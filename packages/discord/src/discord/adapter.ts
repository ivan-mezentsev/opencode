import type { ChatInputCommandInteraction, GuildMember, Interaction, Message, TextChannel } from "discord.js"
import { ChannelType, MessageFlags } from "discord.js"
import { Context, Effect, Layer, Option, Queue, Ref, Runtime, Schedule, Stream } from "effect"
import { AppConfig } from "../config"
import { DiscordClient } from "./client"
import { TYPING_INTERVAL } from "./constants"
import { cleanResponse, splitForDiscord } from "./format"
import { SessionStore } from "../session/store"
import { ChannelId, GuildId, ThreadId } from "../types"
import { DeliveryError, HistoryError, messageOf, ThreadEnsureError } from "../conversation/model/errors"
import { ChannelMessage, Mention, ThreadMessage, ThreadRef, Typing, type Action, type Inbound } from "../conversation/model/schema"
import { History, Inbox, OffsetStore, Outbox, Threads } from "../conversation"
import {
  COMMAND_ACK,
  COMMAND_CHANNEL_REPLY,
  COMMAND_FORBIDDEN_REPLY,
  COMMAND_NOT_THREAD_REPLY,
  COMMANDS,
  EMPTY_MENTION_REPLY,
  SETUP_FAILURE_REPLY,
  commandText,
} from "./conversation-commands"
import {
  asTextChannel,
  asThreadChannel,
  type ChatChannel,
  hasRequiredRole,
  isChannelAllowed,
  isMentioned,
} from "./conversation-channels"
import { catchupBenign, deliveryRetriable, deliveryRetry } from "./conversation-delivery"
import { buildHistoryReplayPrompt } from "./conversation-history"
import { catchupFromOffset } from "./catchup"

const CACHE_LIMIT = 4_000
const CATCHUP_PAGE_SIZE = 100

export class DiscordConversationServices {
  static readonly portLayer = Layer.scopedContext(
    Effect.gen(function* () {
      const client = yield* DiscordClient
      const config = yield* AppConfig
      const sessions = yield* SessionStore
      const offsets = yield* OffsetStore
      const runtime = yield* Effect.runtime<never>()
      const input = yield* Queue.unbounded<Inbound>()
      const chats = new Map<string, ChatChannel>()
      const texts = new Map<string, TextChannel>()
      const refs = new Map<string, Message>()
      const roots = new Map<string, ThreadId>()
      const ref_ids: Array<string> = []
      const root_ids: Array<string> = []

      const stash = <A>(map: Map<string, A>, keys: Array<string>, key: string, value: A) => {
        if (!map.has(key)) keys.push(key)
        map.set(key, value)
        if (keys.length <= CACHE_LIMIT) return
        const oldest = keys.shift()
        if (!oldest) return
        map.delete(oldest)
      }

      const sourceChannel = (channelId: string) => `channel:${channelId}`
      const sourceThread = (threadId: string) => `thread:${threadId}`
      const uniq = <A>(values: ReadonlyArray<A>): Array<A> => [...new Set(values)]

      const offer = (event: Inbound, onFresh: Effect.Effect<void>) =>
        Effect.logInfo("Message queued").pipe(
          Effect.annotateLogs({
            event: "conversation.message.queued",
            kind: event.kind,
            message_id: event.messageId,
            author_id: event.authorId,
            content: event.content.slice(0, 200),
          }),
          Effect.zipRight(onFresh),
          Effect.zipRight(input.offer(event)),
          Effect.asVoid,
        )

      const memberOf = (message: Message) => {
        if (message.member) return Effect.succeed(message.member)
        if (config.discordRequiredRoleId.length === 0) return Effect.succeed<GuildMember | null>(null)
        const guild = message.guild
        if (!guild) return Effect.succeed<GuildMember | null>(null)
        return Effect.tryPromise(() => guild.members.fetch(message.author.id)).pipe(
          Effect.catchAll(() => Effect.succeed<GuildMember | null>(null)),
        )
      }

      const ingestMessage = Effect.fn("DiscordAdapter.ingestMessage")(function* (message: Message) {
        const source = message.channel.type === ChannelType.PublicThread || message.channel.type === ChannelType.PrivateThread
          ? sourceThread(message.channel.id)
          : message.channel.type === ChannelType.GuildText
          ? sourceChannel(message.channel.id)
          : null
        if (source === null) return

        if (message.author.bot || message.mentions.everyone) {
          yield* offsets.setOffset(source, message.id)
          return
        }
        const member = yield* memberOf(message)
        if (!hasRequiredRole(member, config)) {
          yield* offsets.setOffset(source, message.id)
          return
        }

        const botUserId = client.user?.id ?? ""
        const botRoleId = config.discordRoleId
        const mentioned = isMentioned(message, botUserId, botRoleId)
        const content = message.content.replace(/<@[!&]?\d+>/g, "").trim()
        const mentions = Mention.make({
          userIds: [...message.mentions.users.keys()],
          roleIds: [...message.mentions.roles.keys()],
        })

        if (!content && mentioned) {
          yield* Effect.tryPromise(() => message.reply(EMPTY_MENTION_REPLY)).pipe(Effect.catchAll(() => Effect.void))
          yield* offsets.setOffset(source, message.id)
          return
        }

        if (message.channel.type === ChannelType.PublicThread || message.channel.type === ChannelType.PrivateThread) {
          const thread = asThreadChannel(message.channel)
          if (!thread) return
          const threadId = ThreadId.make(thread.id)
          const channelId = ChannelId.make(thread.parentId ?? thread.id)
          const allowed = isChannelAllowed(thread.parentId ?? "", thread.parent?.parentId ?? null, config)

          if (!allowed) {
            const owned = yield* sessions.hasTrackedThread(threadId).pipe(
              Effect.catchAll(() => Effect.succeed(false)),
            )
            if (!owned || mentioned) {
              yield* offsets.setOffset(source, message.id)
              return
            }
          }

          const event = ThreadMessage.make({
            kind: "thread_message",
            threadId,
            channelId,
            messageId: message.id,
            guildId: GuildId.make(message.guildId ?? ""),
            botUserId,
            botRoleId,
            authorId: message.author.id,
            authorIsBot: message.author.bot,
            mentionsEveryone: message.mentions.everyone,
            mentions,
            content,
          })
          yield* offer(
            event,
            Effect.sync(() => {
              chats.set(event.threadId, thread)
              stash(refs, ref_ids, event.messageId, message)
            }),
          )
          yield* offsets.setOffset(source, message.id)
          return
        }

        const channel = asTextChannel(message.channel)
        if (!channel) return
        if (!isChannelAllowed(channel.id, channel.parentId ?? null, config)) {
          yield* offsets.setOffset(source, message.id)
          return
        }

        const event = ChannelMessage.make({
          kind: "channel_message",
          channelId: ChannelId.make(channel.id),
          messageId: message.id,
          guildId: GuildId.make(message.guildId ?? ""),
          botUserId,
          botRoleId,
          authorId: message.author.id,
          authorIsBot: message.author.bot,
          mentionsEveryone: message.mentions.everyone,
          mentions,
          content,
        })
        yield* offer(
          event,
          Effect.sync(() => {
            texts.set(event.channelId, channel)
            stash(refs, ref_ids, event.messageId, message)
          }),
        )
        yield* offsets.setOffset(source, message.id)
      })

      const onMessage = (message: Message): void => {
        const run = ingestMessage(message).pipe(
          Effect.catchAll((error) =>
            Effect.logError("Failed ingesting Discord message").pipe(
              Effect.annotateLogs({
                event: "conversation.ingest.failed",
                message_id: message.id,
                error: messageOf(error),
              }),
            )),
        )
        void Runtime.runPromise(runtime)(run)
      }

      const catchupSource = (source: string, channel: ChatChannel) =>
        catchupFromOffset({
          source,
          pageSize: CATCHUP_PAGE_SIZE,
          offsets,
          fetchLatest: Effect.tryPromise(() => channel.messages.fetch({ limit: 1 })).pipe(
            Effect.map((page) => {
              const latest = page.first()
              return latest ? Option.some(latest) : Option.none()
            }),
          ),
          fetchAfter: (after) =>
            Effect.tryPromise(() =>
              channel.messages.fetch({
                limit: CATCHUP_PAGE_SIZE,
                after,
              })
            ).pipe(
              Effect.map((page) => [...page.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp)),
            ),
          idOf: (message) => message.id,
          ingest: (message) => ingestMessage(message),
        })

      const categoryChannels = () =>
        Effect.gen(function* () {
          if (config.discordCategoryId.length === 0) return [] as Array<string>
          const guilds = [...client.guilds.cache.values()]
          const nested = yield* Effect.forEach(
            guilds,
            (guild) =>
              Effect.tryPromise(() => guild.channels.fetch()).pipe(
                Effect.map((channels) =>
                  [...channels.values()].flatMap((channel) => {
                    const text = asTextChannel(channel)
                    if (!text) return []
                    if (text.parentId !== config.discordCategoryId) return []
                    return [text.id]
                  }),
                ),
                Effect.catchAll(() => Effect.succeed([] as Array<string>)),
              ),
            { discard: false, concurrency: "unbounded" },
          )
          return nested.flat()
        })

      const fetchText = (channelId: string) =>
        Effect.tryPromise(() => client.channels.fetch(channelId)).pipe(
          Effect.map((channel) => asTextChannel(channel)),
          Effect.catchAll(() => Effect.succeed(null)),
        )

      const fetchThread = (threadId: string) =>
        Effect.tryPromise(() => client.channels.fetch(threadId)).pipe(
          Effect.map((channel) => asThreadChannel(channel)),
          Effect.catchAll(() => Effect.succeed(null)),
        )

      const recoverMissedMessages = Effect.gen(function* () {
        const channels = config.allowedChannelIds.length > 0
          ? uniq(config.allowedChannelIds)
          : uniq(yield* categoryChannels())
        const threads = uniq((yield* sessions.listTrackedThreads()).map((id) => String(id)))

        const fromChannels = yield* Effect.forEach(
          channels,
          (channelId) =>
            fetchText(channelId).pipe(
              Effect.flatMap((channel) => {
                if (!channel) return Effect.succeed(0)
                return catchupSource(sourceChannel(channelId), channel)
              }),
              Effect.catchAll((error) => {
                const log = catchupBenign(error) ? Effect.logDebug("Channel catch-up skipped") : Effect.logWarning("Channel catch-up failed")
                return log.pipe(
                  Effect.annotateLogs({
                    event: "conversation.catchup.channel.failed",
                    channel_id: channelId,
                    error: messageOf(error),
                  }),
                  Effect.as(0),
                )
              }),
            ),
          { discard: false, concurrency: "unbounded" },
        )

        const fromThreads = yield* Effect.forEach(
          threads,
          (threadId) =>
            fetchThread(threadId).pipe(
              Effect.flatMap((thread) => {
                if (!thread) return Effect.succeed(0)
                return catchupSource(sourceThread(threadId), thread)
              }),
              Effect.catchAll((error) => {
                const log = catchupBenign(error) ? Effect.logDebug("Thread catch-up skipped") : Effect.logWarning("Thread catch-up failed")
                return log.pipe(
                  Effect.annotateLogs({
                    event: "conversation.catchup.thread.failed",
                    thread_id: threadId,
                    error: messageOf(error),
                  }),
                  Effect.as(0),
                )
              }),
            ),
          { discard: false, concurrency: "unbounded" },
        )

        const fetched = [...fromChannels, ...fromThreads].reduce((n, x) => n + x, 0)
        yield* Effect.logInfo("Discord catch-up complete").pipe(
          Effect.annotateLogs({
            event: "conversation.catchup.complete",
            channels: channels.length,
            threads: threads.length,
            fetched,
          }),
        )
      })

      const acknowledge = (interaction: ChatInputCommandInteraction, content: string) =>
        Effect.tryPromise(async () => {
          if (interaction.deferred || interaction.replied) {
            await interaction.editReply({ content })
          } else {
            await interaction.reply({ content, flags: MessageFlags.Ephemeral })
          }
        }).pipe(Effect.catchAll(() => Effect.void))

      const onInteraction = (interaction: Interaction): void => {
        if (!interaction.isChatInputCommand()) return
        const text = commandText(interaction.commandName)
        if (!text) return
        const handle = Effect.gen(function* () {
          yield* Effect.tryPromise(() =>
            interaction.deferReply({
              flags: MessageFlags.Ephemeral,
            })
          ).pipe(Effect.catchAll(() => Effect.void))
          const thread = asThreadChannel(interaction.channel)
          if (!thread) {
            yield* acknowledge(interaction, COMMAND_NOT_THREAD_REPLY)
            return
          }
          const threadId = ThreadId.make(thread.id)
          const channelId = ChannelId.make(thread.parentId ?? thread.id)
          const allowed = isChannelAllowed(thread.parentId ?? "", thread.parent?.parentId ?? null, config)
          if (!allowed) {
            const owned = yield* sessions.hasTrackedThread(threadId).pipe(
              Effect.catchAll(() => Effect.succeed(false)),
            )
            if (!owned) {
              yield* acknowledge(interaction, COMMAND_CHANNEL_REPLY)
              return
            }
          }

          const member = yield* Effect.tryPromise(() =>
            interaction.guild ? interaction.guild.members.fetch(interaction.user.id) : Promise.resolve(null),
          ).pipe(Effect.catchAll(() => Effect.succeed(null)))
          if (!hasRequiredRole(member, config)) {
            yield* acknowledge(interaction, COMMAND_FORBIDDEN_REPLY)
            return
          }

          const botUserId = client.user?.id ?? ""
          const event = ThreadMessage.make({
            kind: "thread_message",
            threadId,
            channelId,
            messageId: interaction.id,
            guildId: GuildId.make(interaction.guildId ?? ""),
            botUserId,
            botRoleId: config.discordRoleId,
            authorId: interaction.user.id,
            authorIsBot: false,
            mentionsEveryone: false,
            mentions: Mention.make({
              userIds: botUserId.length > 0 ? [botUserId] : [],
              roleIds: [],
            }),
            content: text,
          })
          yield* Effect.sync(() => {
            chats.set(event.threadId, thread)
            input.unsafeOffer(event)
          })
          yield* acknowledge(interaction, COMMAND_ACK)
        })
        void Runtime.runPromise(runtime)(handle)
      }

      const registerCommands = Effect.gen(function* () {
        if (!client.isReady()) {
          yield* Effect.async<void, never>((resume) => {
            const ready = () => {
              resume(Effect.void)
            }
            client.once("clientReady", ready)
            return Effect.sync(() => {
              client.off("clientReady", ready)
            })
          })
        }
        const app = client.application
        if (!app) return
        const guild = config.discordCommandGuildId.trim()
        const registered = yield* Effect.tryPromise(() =>
          guild.length > 0
            ? app.commands.set([...COMMANDS], guild)
            : app.commands.set([...COMMANDS]),
        )
        yield* Effect.logInfo("Discord slash commands registered").pipe(
          Effect.annotateLogs({
            event: "discord.commands.registered",
            scope: guild.length > 0 ? "guild" : "global",
            guild_id: guild.length > 0 ? guild : "global",
            count: registered.size,
          }),
        )
      }).pipe(
        Effect.tapError((cause) =>
          Effect.logError("Discord slash command registration failed").pipe(
            Effect.annotateLogs({
              event: "discord.commands.failed",
              message: messageOf(cause),
            }),
          )),
        Effect.catchAll(() => Effect.void),
      )

      yield* registerCommands

      client.on("messageCreate", onMessage)
      client.on("interactionCreate", onInteraction)
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          client.off("messageCreate", onMessage)
          client.off("interactionCreate", onInteraction)
          yield* input.shutdown
        }),
      )

      yield* recoverMissedMessages.pipe(
        Effect.catchAll((error) =>
          Effect.logError("Discord catch-up failed").pipe(
            Effect.annotateLogs({ event: "conversation.catchup.failed", error: messageOf(error) }),
          )),
      )

      const inbox = Inbox.of({
        events: Stream.fromQueue(input, { shutdown: false }),
      })

      const channelOf = (threadId: ThreadId, action: Action["kind"]) => {
        const channel = chats.get(threadId)
        if (channel) return Effect.succeed(channel)
        return Effect.tryPromise(() => client.channels.fetch(threadId)).pipe(
          Effect.flatMap((fetched) => {
            const thread = asThreadChannel(fetched)
            if (thread) {
              chats.set(threadId, thread)
              return Effect.succeed(thread)
            }
            return DeliveryError.make({
              threadId,
              action,
              message: "missing-thread-channel",
              retriable: false,
            })
          }),
          Effect.mapError((cause) =>
            DeliveryError.make({
              threadId,
              action,
              message: messageOf(cause),
              retriable: deliveryRetriable(cause),
            })),
        )
      }

      const deliver = (threadId: ThreadId, action: Action["kind"], send: Effect.Effect<unknown, unknown>) =>
        Effect.gen(function* () {
          const attempts = yield* Ref.make(0)
          yield* send.pipe(
            Effect.mapError((cause) =>
              DeliveryError.make({
                threadId,
                action,
                message: messageOf(cause),
                retriable: deliveryRetriable(cause),
              })),
            Effect.tapError((error) =>
              Ref.updateAndGet(attempts, (n) => n + 1).pipe(
                Effect.flatMap((attempt) =>
                  Effect.logWarning("Discord delivery attempt failed").pipe(
                    Effect.annotateLogs({
                      event: "conversation.delivery.retry",
                      thread_id: threadId,
                      action,
                      attempt,
                      retriable: error.retriable,
                      message: error.message,
                    }),
                  )),
              ),
            ),
            Effect.retry(deliveryRetry),
            Effect.tapError((error) =>
              Ref.get(attempts).pipe(
                Effect.flatMap((attempt) =>
                  Effect.logError("Discord delivery failed").pipe(
                    Effect.annotateLogs({
                      event: "conversation.delivery.failed",
                      thread_id: threadId,
                      action,
                      attempts: attempt,
                      retriable: error.retriable,
                      message: error.message,
                    }),
                  )),
              ),
            ),
          )
        })

      const sendTyping = (threadId: ThreadId) =>
        Effect.gen(function* () {
          const channel = yield* channelOf(threadId, "typing")
          yield* deliver(threadId, "typing", Effect.tryPromise(() => channel.sendTyping()))
        })

      const sendText = (threadId: ThreadId, action: "send" | "reply", text: string) =>
        Effect.gen(function* () {
          const channel = yield* channelOf(threadId, action)
          yield* Effect.forEach(
            splitForDiscord(cleanResponse(text)),
            (chunk) => deliver(threadId, action, Effect.tryPromise(() => channel.send(chunk))),
            { discard: true },
          )
        })

      const publish = (action: Action) => {
        if (action.kind === "typing") return sendTyping(action.threadId)
        return sendText(action.threadId, action.kind, action.text)
      }

      const withTyping = <A, E, R>(threadId: ThreadId, self: Effect.Effect<A, E, R>) =>
        Effect.scoped(
          Effect.gen(function* () {
            const pulse = publish(
              Typing.make({
                kind: "typing",
                threadId,
              }),
            ).pipe(Effect.catchAll(() => Effect.void))
            yield* pulse
            yield* Effect.forkScoped(
              Effect.repeat(pulse, Schedule.spaced(TYPING_INTERVAL)).pipe(
                Effect.delay(TYPING_INTERVAL),
              ),
            )
            return yield* self
          }),
        )

      const outbox = Outbox.of({ publish, withTyping })

      const history = History.of({
        rehydrate: (threadId, latest: string) =>
          Effect.gen(function* () {
            const channel = chats.get(threadId)
            if (!channel) return latest
            return yield* buildHistoryReplayPrompt(channel, latest).pipe(
              Effect.mapError((cause) =>
                HistoryError.make({
                  threadId,
                  message: messageOf(cause),
                  retriable: true,
                })),
            )
          }),
      })

      const threads = Threads.of({
        ensure: (event, name: string) => {
          if (event.kind === "thread_message") {
            return Effect.succeed(ThreadRef.make({ threadId: event.threadId, channelId: event.channelId }))
          }

          const known = roots.get(event.messageId)
          if (known) {
            return Effect.succeed(ThreadRef.make({ threadId: known, channelId: event.channelId }))
          }

          return Effect.gen(function* () {
            const local = texts.get(event.channelId)
            const channel = local
              ? local
              : yield* Effect.tryPromise(() => client.channels.fetch(event.channelId)).pipe(
                Effect.map((fetched) => asTextChannel(fetched)),
                Effect.mapError((cause) =>
                  ThreadEnsureError.make({
                    channelId: event.channelId,
                    message: messageOf(cause),
                    retriable: deliveryRetriable(cause),
                  })),
              )
            if (!channel) {
              return yield* ThreadEnsureError.make({
                channelId: event.channelId,
                message: "missing-parent-channel",
                retriable: false,
              })
            }
            texts.set(event.channelId, channel)
            const base = refs.get(event.messageId)
            const thread = yield* Effect.tryPromise(() =>
              channel.threads.create({
                name,
                startMessage: base ?? event.messageId,
                autoArchiveDuration: 60,
              }),
            ).pipe(
              Effect.tapError(() =>
                Effect.tryPromise(() =>
                  base
                    ? base.reply(SETUP_FAILURE_REPLY).then(() => undefined)
                    : Promise.resolve(undefined)
                ).pipe(
                  Effect.catchAll(() => Effect.void),
                )),
              Effect.mapError((cause) =>
                ThreadEnsureError.make({
                  channelId: event.channelId,
                  message: messageOf(cause),
                  retriable: deliveryRetriable(cause),
                })),
            )
            const threadId = ThreadId.make(thread.id)
            chats.set(threadId, thread)
            stash(roots, root_ids, event.messageId, threadId)
            return ThreadRef.make({ threadId, channelId: event.channelId })
          })
        },
      })

      return Context.empty().pipe(
        Context.add(Inbox, inbox),
        Context.add(Outbox, outbox),
        Context.add(History, history),
        Context.add(Threads, threads),
      )
    }),
  )
}

export const DiscordConversationServicesLive = DiscordConversationServices.portLayer
