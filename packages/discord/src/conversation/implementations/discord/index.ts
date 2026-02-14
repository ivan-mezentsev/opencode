import type { ChatInputCommandInteraction, GuildMember, Interaction, Message, TextChannel, ThreadChannel } from "discord.js"
import { ChannelType, MessageFlags } from "discord.js"
import { Context, Effect, Layer, Option, Queue, Ref, Runtime, Schedule, Stream } from "effect"
import { AppConfig } from "../../../config"
import { DiscordClient } from "../../../discord/client"
import { TYPING_INTERVAL } from "../../../discord/constants"
import { cleanResponse, splitForDiscord } from "../../../discord/format"
import { ThreadAgentPool } from "../../../sandbox/pool"
import { SessionStore } from "../../../sessions/store"
import { ChannelId, GuildId, ThreadId } from "../../../types"
import { DeliveryError, HistoryError, messageOf, ThreadEnsureError } from "../../model/errors"
import { ChannelMessage, Mention, ThreadMessage, ThreadRef, Typing, type Action, type Inbound } from "../../model/schema"
import { ConversationLedger, History, Inbox, Outbox, Threads } from "../../services"

type ChatChannel = TextChannel | ThreadChannel

const HISTORY_FETCH_LIMIT = 40
const HISTORY_LINE_CHAR_LIMIT = 500
const HISTORY_TOTAL_CHAR_LIMIT = 6000
const INGRESS_DEDUP_LIMIT = 4_000
const EMPTY_MENTION_REPLY = "Tag me with a question!"
const SETUP_FAILURE_REPLY = "Something went wrong setting up the thread."
const COMMAND_NOT_THREAD_REPLY = "Use this command inside a Discord thread."
const COMMAND_FORBIDDEN_REPLY = "You don't have the required role for this command."
const COMMAND_CHANNEL_REPLY = "This thread is not allowed for the bot."
const COMMAND_ACK = "Running command in this thread..."
const CATCHUP_PAGE_SIZE = 100
const COMMANDS = [
  {
    name: "status",
    description: "Show sandbox status for this thread",
  },
  {
    name: "reset",
    description: "Destroy the sandbox session for this thread",
  },
] as const

const commandText = (name: string): string => {
  if (name === "status") return "!status"
  if (name === "reset") return "!reset"
  return ""
}

const isChannelAllowed = (channelId: string, categoryId: string | null, config: AppConfig.Service): boolean => {
  if (config.allowedChannelIds.length > 0 && config.allowedChannelIds.includes(channelId)) return true
  if (config.discordCategoryId && categoryId === config.discordCategoryId) return true
  return false
}

const hasRequiredRole = (member: GuildMember | null, config: AppConfig.Service): boolean => {
  if (!config.discordRequiredRoleId) return true
  if (!member) return false
  return member.roles.cache.has(config.discordRequiredRoleId)
}

const asThreadChannel = (value: unknown): ThreadChannel | null => {
  if (typeof value !== "object" || value === null) return null
  const type = (value as { type?: unknown }).type
  if (type === ChannelType.PublicThread || type === ChannelType.PrivateThread) return value as ThreadChannel
  return null
}

const asTextChannel = (value: unknown): TextChannel | null => {
  if (typeof value !== "object" || value === null) return null
  const type = (value as { type?: unknown }).type
  if (type === ChannelType.GuildText) return value as TextChannel
  return null
}

const isMentioned = (message: Message, botUserId: string, botRoleId: string): boolean => {
  if (botUserId.length > 0 && message.mentions.users.has(botUserId)) return true
  if (botRoleId.length > 0 && message.mentions.roles.has(botRoleId)) return true
  if (botUserId.length > 0 && message.content.includes(`<@${botUserId}>`)) return true
  if (botUserId.length > 0 && message.content.includes(`<@!${botUserId}>`)) return true
  if (botRoleId.length > 0 && message.content.includes(`<@&${botRoleId}>`)) return true
  return false
}

const buildHistoryReplayPrompt = Effect.fn("DiscordAdapter.buildHistoryReplayPrompt")(
  function* (channel: ChatChannel, latest: string) {
    const fetched = yield* Effect.tryPromise(() => channel.messages.fetch({ limit: HISTORY_FETCH_LIMIT }))
    const ordered = [...fetched.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp)
    const lines = ordered
      .filter((prior) => !prior.system)
      .flatMap((prior) => {
        const text = prior.content.replace(/\s+/g, " ").trim()
        const files = prior.attachments.size > 0
          ? `[attachments: ${[...prior.attachments.values()].map((att) => att.name ?? "file").join(", ")}]`
          : ""
        const line = text || files
        if (!line) return []
        const value = line.length > HISTORY_LINE_CHAR_LIMIT ? `${line.slice(0, HISTORY_LINE_CHAR_LIMIT)}...` : line
        return [`${prior.author.bot ? "assistant" : "user"}: ${value}`]
      })

    const prior = lines.at(-1) === `user: ${latest}` ? lines.slice(0, -1) : lines
    if (prior.length === 0) return latest

    const selected = prior.reduceRight(
      (state, candidate) => {
        if (state.stop) return state
        if (state.total + candidate.length > HISTORY_TOTAL_CHAR_LIMIT && state.list.length > 0) {
          return { ...state, stop: true }
        }
        return { list: [candidate, ...state.list], total: state.total + candidate.length, stop: false }
      },
      { list: [] as ReadonlyArray<string>, total: 0, stop: false },
    ).list

    return [
      "Conversation history from this same Discord thread (oldest to newest):",
      selected.join("\n"),
      "",
      "Continue the same conversation and respond to the latest user message:",
      latest,
    ].join("\n")
  },
)

const statusOf = (cause: unknown): number | null => {
  if (typeof cause !== "object" || cause === null) return null
  const status = (cause as { status?: unknown }).status
  if (typeof status === "number") return status
  const code = (cause as { code?: unknown }).code
  if (typeof code === "number") return code
  return null
}

const deliveryRetriable = (cause: unknown): boolean => {
  const status = statusOf(cause)
  if (status === 429) return true
  if (status !== null && status >= 500) return true
  return false
}

const catchupBenign = (cause: unknown): boolean => {
  const text = messageOf(cause).toLowerCase()
  if (text.includes("missing access")) return true
  if (text.includes("missing permissions")) return true
  if (text.includes("unknown channel")) return true
  if (text.includes("50001")) return true
  if (text.includes("50013")) return true
  return false
}

const deliveryRetry = Schedule.exponential("200 millis").pipe(
  Schedule.intersect(Schedule.recurs(3)),
  Schedule.whileInput((error: DeliveryError) => error.retriable),
)

export class DiscordConversationServices {
  static readonly portLayer = Layer.scopedContext(
    Effect.gen(function* () {
      const client = yield* DiscordClient
      const config = yield* AppConfig
      const pool = yield* ThreadAgentPool
      const sessions = yield* SessionStore
      const ledger = yield* ConversationLedger
      const runtime = yield* Effect.runtime<never>()
      const input = yield* Queue.unbounded<Inbound>()
      const chats = new Map<string, ChatChannel>()
      const texts = new Map<string, TextChannel>()
      const refs = new Map<string, Message>()
      const roots = new Map<string, ThreadId>()
      const seen = new Set<string>()
      const order: Array<string> = []
      const ref_ids: Array<string> = []
      const root_ids: Array<string> = []

      const mark = (message_id: string): boolean => {
        if (seen.has(message_id)) return false
        seen.add(message_id)
        order.push(message_id)
        if (order.length <= INGRESS_DEDUP_LIMIT) return true
        const oldest = order.shift()
        if (!oldest) return true
        seen.delete(oldest)
        return true
      }

      const stash = <A>(map: Map<string, A>, keys: Array<string>, key: string, value: A) => {
        if (!map.has(key)) keys.push(key)
        map.set(key, value)
        if (keys.length <= INGRESS_DEDUP_LIMIT) return
        const oldest = keys.shift()
        if (!oldest) return
        map.delete(oldest)
      }

      const sourceChannel = (channel_id: string) => `channel:${channel_id}`
      const sourceThread = (thread_id: string) => `thread:${thread_id}`
      const uniq = <A>(values: ReadonlyArray<A>): Array<A> => [...new Set(values)]

      const offer = (event: Inbound, onFresh: Effect.Effect<void>) =>
        ledger.dedup(event.message_id).pipe(
          Effect.flatMap((fresh) => {
            if (!fresh) {
              return Effect.logDebug("Message deduped (already seen)").pipe(
                Effect.annotateLogs({
                  event: "conversation.message.deduped",
                  message_id: event.message_id,
                }),
              )
            }
            return Effect.logInfo("Message queued").pipe(
              Effect.annotateLogs({
                event: "conversation.message.queued",
                kind: event.kind,
                message_id: event.message_id,
                author_id: event.author_id,
                content: event.content.slice(0, 200),
              }),
            ).pipe(
              Effect.zipRight(onFresh),
              Effect.zipRight(input.offer(event)),
              Effect.asVoid,
            )
          }),
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
          yield* ledger.setOffset(source, message.id)
          return
        }
        const member = yield* memberOf(message)
        if (!hasRequiredRole(member, config)) {
          yield* ledger.setOffset(source, message.id)
          return
        }

        const bot_user_id = client.user?.id ?? ""
        const bot_role_id = config.discordRoleId
        const mentioned = isMentioned(message, bot_user_id, bot_role_id)
        const content = message.content.replace(/<@[!&]?\d+>/g, "").trim()
        const mentions = Mention.make({
          user_ids: [...message.mentions.users.keys()],
          role_ids: [...message.mentions.roles.keys()],
        })

        if (!content && mentioned) {
          yield* Effect.tryPromise(() => message.reply(EMPTY_MENTION_REPLY)).pipe(Effect.catchAll(() => Effect.void))
          yield* ledger.setOffset(source, message.id)
          return
        }

        if (message.channel.type === ChannelType.PublicThread || message.channel.type === ChannelType.PrivateThread) {
          const thread = message.channel as ThreadChannel
          const thread_id = ThreadId.make(thread.id)
          const channel_id = ChannelId.make(thread.parentId ?? thread.id)
          const allowed = isChannelAllowed(thread.parentId ?? "", thread.parent?.parentId ?? null, config)

          if (!allowed) {
            const owned = yield* pool.hasTrackedThread(thread_id).pipe(
              Effect.catchAll(() => Effect.succeed(false)),
            )
            if (!owned || mentioned) {
              yield* ledger.setOffset(source, message.id)
              return
            }
          }

          const event = ThreadMessage.make({
            kind: "thread_message",
            thread_id,
            channel_id,
            message_id: message.id,
            guild_id: GuildId.make(message.guildId ?? ""),
            bot_user_id,
            bot_role_id,
            author_id: message.author.id,
            author_is_bot: message.author.bot,
            mentions_everyone: message.mentions.everyone,
            mentions,
            content,
          })
          yield* offer(
            event,
            Effect.sync(() => {
              chats.set(event.thread_id, thread)
              stash(refs, ref_ids, event.message_id, message)
            }),
          )
          yield* ledger.setOffset(source, message.id)
          return
        }

        const channel = message.channel as TextChannel
        if (!isChannelAllowed(channel.id, channel.parentId ?? null, config)) {
          yield* ledger.setOffset(source, message.id)
          return
        }

        const event = ChannelMessage.make({
          kind: "channel_message",
          channel_id: ChannelId.make(channel.id),
          message_id: message.id,
          guild_id: GuildId.make(message.guildId ?? ""),
          bot_user_id,
          bot_role_id,
          author_id: message.author.id,
          author_is_bot: message.author.bot,
          mentions_everyone: message.mentions.everyone,
          mentions,
          content,
        })
        yield* offer(
          event,
          Effect.sync(() => {
            texts.set(event.channel_id, channel)
            stash(refs, ref_ids, event.message_id, message)
          }),
        )
        yield* ledger.setOffset(source, message.id)
      })

      const onMessage = (message: Message): void => {
        if (!mark(message.id)) return
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

      const pullAfter = (channel: ChatChannel, after: string): Effect.Effect<number, unknown> =>
        Effect.tryPromise(() =>
          channel.messages.fetch({
            limit: CATCHUP_PAGE_SIZE,
            after,
          })
        ).pipe(
          Effect.map((page) => [...page.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp)),
          Effect.flatMap((rows) => {
            if (rows.length === 0) return Effect.succeed(0)
            const last = rows.at(-1)
            if (!last) return Effect.succeed(0)
            return Effect.forEach(rows, (row) => ingestMessage(row), { discard: true }).pipe(
              Effect.zipRight(
                rows.length < CATCHUP_PAGE_SIZE
                  ? Effect.succeed(rows.length)
                  : pullAfter(channel, last.id).pipe(Effect.map((tail: number) => rows.length + tail)),
              ),
            )
          }),
        )

      const catchupSource = (source: string, channel: ChatChannel) =>
        Effect.gen(function* () {
          const offset = yield* ledger.getOffset(source)
          if (Option.isNone(offset)) {
            const page = yield* Effect.tryPromise(() => channel.messages.fetch({ limit: 1 }))
            const latest = page.first()
            if (latest) yield* ledger.setOffset(source, latest.id)
            return 0
          }
          return yield* pullAfter(channel, offset.value)
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

      const fetchText = (channel_id: string) =>
        Effect.tryPromise(() => client.channels.fetch(channel_id)).pipe(
          Effect.map((channel) => asTextChannel(channel)),
          Effect.catchAll(() => Effect.succeed(null)),
        )

      const fetchThread = (thread_id: string) =>
        Effect.tryPromise(() => client.channels.fetch(thread_id)).pipe(
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
          (channel_id) =>
            fetchText(channel_id).pipe(
              Effect.flatMap((channel) => {
                if (!channel) return Effect.succeed(0)
                return catchupSource(sourceChannel(channel_id), channel)
              }),
              Effect.catchAll((error) => {
                const log = catchupBenign(error) ? Effect.logDebug("Channel catch-up skipped") : Effect.logWarning("Channel catch-up failed")
                return log.pipe(
                  Effect.annotateLogs({
                    event: "conversation.catchup.channel.failed",
                    channel_id,
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
          (thread_id) =>
            fetchThread(thread_id).pipe(
              Effect.flatMap((thread) => {
                if (!thread) return Effect.succeed(0)
                return catchupSource(sourceThread(thread_id), thread)
              }),
              Effect.catchAll((error) => {
                const log = catchupBenign(error) ? Effect.logDebug("Thread catch-up skipped") : Effect.logWarning("Thread catch-up failed")
                return log.pipe(
                  Effect.annotateLogs({
                    event: "conversation.catchup.thread.failed",
                    thread_id,
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
        if (!mark(interaction.id)) return
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
          const thread_id = ThreadId.make(thread.id)
          const channel_id = ChannelId.make(thread.parentId ?? thread.id)
          const allowed = isChannelAllowed(thread.parentId ?? "", thread.parent?.parentId ?? null, config)
          if (!allowed) {
            const owned = yield* pool.hasTrackedThread(thread_id).pipe(
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

          const bot_user_id = client.user?.id ?? ""
          const event = ThreadMessage.make({
            kind: "thread_message",
            thread_id,
            channel_id,
            message_id: interaction.id,
            guild_id: GuildId.make(interaction.guildId ?? ""),
            bot_user_id,
            bot_role_id: config.discordRoleId,
            author_id: interaction.user.id,
            author_is_bot: false,
            mentions_everyone: false,
            mentions: Mention.make({
              user_ids: bot_user_id.length > 0 ? [bot_user_id] : [],
              role_ids: [],
            }),
            content: text,
          })
          const ingest = ledger.dedup(event.message_id).pipe(
            Effect.flatMap((fresh) => {
              if (!fresh) return Effect.void
              return Effect.sync(() => {
                chats.set(event.thread_id, thread)
                input.unsafeOffer(event)
              })
            }),
            Effect.catchAll(() => Effect.void),
          )
          yield* ingest
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

      const channelOf = (thread_id: ThreadId, action: Action["kind"]) => {
        const channel = chats.get(thread_id)
        if (channel) return Effect.succeed(channel)
        return Effect.tryPromise(() => client.channels.fetch(thread_id)).pipe(
          Effect.flatMap((fetched) => {
            const thread = asThreadChannel(fetched)
            if (thread) {
              chats.set(thread_id, thread)
              return Effect.succeed(thread)
            }
            return DeliveryError.make({
              thread_id,
              action,
              message: "missing-thread-channel",
              retriable: false,
            })
          }),
          Effect.mapError((cause) =>
            DeliveryError.make({
              thread_id,
              action,
              message: messageOf(cause),
              retriable: deliveryRetriable(cause),
            })),
        )
      }

      const deliver = (thread_id: ThreadId, action: Action["kind"], send: Effect.Effect<unknown, unknown>) =>
        Effect.gen(function* () {
          const attempts = yield* Ref.make(0)
          yield* send.pipe(
            Effect.mapError((cause) =>
              DeliveryError.make({
                thread_id,
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
                      thread_id,
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
                      thread_id,
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

      const sendTyping = (thread_id: ThreadId) =>
        Effect.gen(function* () {
          const channel = yield* channelOf(thread_id, "typing")
          yield* deliver(thread_id, "typing", Effect.tryPromise(() => channel.sendTyping()))
        })

      const sendText = (thread_id: ThreadId, action: "send" | "reply", text: string) =>
        Effect.gen(function* () {
          const channel = yield* channelOf(thread_id, action)
          yield* Effect.forEach(
            splitForDiscord(cleanResponse(text)),
            (chunk) => deliver(thread_id, action, Effect.tryPromise(() => channel.send(chunk))),
            { discard: true },
          )
        })

      const publish = (action: Action) => {
        if (action.kind === "typing") return sendTyping(action.thread_id)
        return sendText(action.thread_id, action.kind, action.text)
      }

      const withTyping = <A, E, R>(thread_id: ThreadId, self: Effect.Effect<A, E, R>) =>
        Effect.scoped(
          Effect.gen(function* () {
            const pulse = publish(
              Typing.make({
                kind: "typing",
                thread_id,
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
        rehydrate: (thread_id, latest: string) =>
          Effect.gen(function* () {
            const channel = chats.get(thread_id)
            if (!channel) return latest
            return yield* buildHistoryReplayPrompt(channel, latest).pipe(
              Effect.mapError((cause) =>
                HistoryError.make({
                  thread_id,
                  message: messageOf(cause),
                  retriable: true,
                })),
            )
          }),
      })

      const threads = Threads.of({
        ensure: (event, name: string) => {
          if (event.kind === "thread_message") {
            return Effect.succeed(ThreadRef.make({ thread_id: event.thread_id, channel_id: event.channel_id }))
          }

          const known = roots.get(event.message_id)
          if (known) {
            return Effect.succeed(ThreadRef.make({ thread_id: known, channel_id: event.channel_id }))
          }

          return Effect.gen(function* () {
            const local = texts.get(event.channel_id)
            const channel = local
              ? local
              : yield* Effect.tryPromise(() => client.channels.fetch(event.channel_id)).pipe(
                Effect.map((fetched) => asTextChannel(fetched)),
                Effect.mapError((cause) =>
                  ThreadEnsureError.make({
                    channel_id: event.channel_id,
                    message: messageOf(cause),
                    retriable: deliveryRetriable(cause),
                  })),
              )
            if (!channel) {
              return yield* ThreadEnsureError.make({
                channel_id: event.channel_id,
                message: "missing-parent-channel",
                retriable: false,
              })
            }
            texts.set(event.channel_id, channel)
            const base = refs.get(event.message_id)
            const thread = yield* Effect.tryPromise(() =>
              channel.threads.create({
                name,
                startMessage: base ?? event.message_id,
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
                  channel_id: event.channel_id,
                  message: messageOf(cause),
                  retriable: deliveryRetriable(cause),
                })),
            )
            const thread_id = ThreadId.make(thread.id)
            chats.set(thread_id, thread)
            stash(roots, root_ids, event.message_id, thread_id)
            return ThreadRef.make({ thread_id, channel_id: event.channel_id })
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
