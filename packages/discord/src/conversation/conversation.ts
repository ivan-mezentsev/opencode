import { Context, Effect, Layer, Option, Predicate, Schedule, Stream } from "effect"
import { ThreadChatCluster, ThreadChatError } from "./thread/cluster"
import { AppConfig } from "../config"
import { TurnRouter } from "../discord/turn-routing"
import type { HealthCheckError, OpenCodeClientError, SandboxDeadError, SandboxStartError } from "../errors"
import { ActorMap } from "../lib/actors/keyed"
import type { ChannelId, SessionInfo, ThreadId } from "../types"
import { type ConversationError, messageOf, RoutingError, SandboxSendError } from "./model/errors"
import { Send, type Inbound } from "./model/schema"
import { Inbox } from "./inbox"
import { IngressDedup } from "./dedup"
import { Outbox } from "./outbox"
import { Threads } from "./threads"

export declare namespace Conversation {
  export interface Service {
    readonly turn: (event: Inbound) => Effect.Effect<void, ConversationError>
    readonly run: Effect.Effect<void>
  }
}

export class Conversation extends Context.Tag("@discord/conversation/Conversation")<
  Conversation,
  Conversation.Service
>() {
  static readonly layer = Layer.scoped(
    Conversation,
    Effect.gen(function* () {
      const inbox = yield* Inbox
      const outbox = yield* Outbox
      const threads = yield* Threads
      const dedup = yield* IngressDedup
      const config = yield* AppConfig
      const threadChat = yield* ThreadChatCluster
      const router = yield* TurnRouter
      const actors = yield* ActorMap.make<string>()
      const RETRY_MESSAGE = "Something went wrong. Please try again in a moment."
      const turnRetry = Schedule.exponential("500 millis").pipe(
        Schedule.intersect(Schedule.recurs(2)),
        Schedule.whileInput((error: ConversationError) => error.retriable),
      )

      type RetriableCause = SandboxDeadError | OpenCodeClientError | HealthCheckError | SandboxStartError

      const isRetriableCause = (cause: unknown): cause is RetriableCause =>
        Predicate.isTagged(cause, "SandboxDeadError") ||
        Predicate.isTagged(cause, "OpenCodeClientError") ||
        Predicate.isTagged(cause, "HealthCheckError") ||
        Predicate.isTagged(cause, "SandboxStartError")

      const asSendError =
        (threadId: ThreadId) =>
        (cause: unknown): SandboxSendError => {
          if (cause instanceof ThreadChatError) {
            return SandboxSendError.make({
              threadId,
              message: messageOf(cause.cause),
              retriable: cause.retriable,
            })
          }
          return SandboxSendError.make({
            threadId,
            message: messageOf(cause),
            retriable: isRetriableCause(cause),
          })
        }

      const publishText = (threadId: ThreadId, text: string) =>
        outbox.publish(
          Send.make({
            kind: "send",
            threadId,
            text,
          }),
        )

      const renderStatus = (session: SessionInfo) => {
        const model = config.openCodeModel.replace("opencode/", "")
        return [
          `**Status:** ${session.status}`,
          `**Model:** \`${model}\``,
          `**Sandbox:** \`${session.sandboxId}\``,
          `**Session:** \`${session.sessionId}\``,
          session.resumeFailCount > 0 ? `**Resume failures:** ${session.resumeFailCount}` : null,
          session.lastError ? `**Last error:** ${session.lastError.slice(0, 200)}` : null,
        ]
          .filter((line): line is string => line !== null)
          .join("\n")
      }

      const reportFailure = (threadId: ThreadId) => (error: ConversationError) => {
        if (error.retriable) return Effect.fail(error)
        return publishText(threadId, RETRY_MESSAGE).pipe(
          Effect.catchAll(() => Effect.void),
          Effect.zipRight(Effect.fail(error)),
        )
      }

      const route = Effect.fn("Conversation.route")(function* (event: Inbound) {
        if (event.authorIsBot) return false
        if (event.mentionsEveryone) return false
        if (!event.content.trim()) return false

        const mentioned =
          event.mentions.userIds.includes(event.botUserId) ||
          (event.botRoleId.length > 0 && event.mentions.roleIds.includes(event.botRoleId))
        if (event.kind === "channel_message") return mentioned
        if (mentioned) return true

        const owned = yield* threadChat
          .status(event.threadId)
          .pipe(
            Effect.map((session) => Option.isSome(session)),
            Effect.mapError(asSendError(event.threadId)),
          )
        if (!owned) return false

        const decision = yield* router
          .shouldRespond({
            content: event.content,
            botUserId: event.botUserId,
            botRoleId: event.botRoleId,
            mentionedUserIds: event.mentions.userIds,
            mentionedRoleIds: event.mentions.roleIds,
          })
          .pipe(
            Effect.mapError((cause) =>
              RoutingError.make({
                message: messageOf(cause),
                retriable: false,
              }),
            ),
          )
        return decision.shouldRespond
      })

      const resolve = Effect.fn("Conversation.resolve")(function* (event: Inbound) {
        if (event.kind === "thread_message") {
          return { threadId: event.threadId, channelId: event.channelId }
        }
        const name = yield* router.generateThreadName(event.content)
        return yield* threads.ensure(event, name)
      })

      const commandStatus = (threadId: ThreadId) =>
        Effect.gen(function* () {
          const tracked = yield* threadChat
            .status(threadId)
            .pipe(Effect.catchAll(() => Effect.succeed(Option.none())))
          if (Option.isNone(tracked)) {
            yield* publishText(threadId, "*No active session for this thread.*")
            return
          }
          yield* publishText(threadId, renderStatus(tracked.value))
        })

      const commandRecreate = (threadId: ThreadId) =>
        threadChat.recreate(threadId).pipe(
          Effect.catchAll(() => Effect.void),
          Effect.zipRight(
            publishText(threadId, "*☠️ Session recreated. Next message will provision a fresh sandbox.*"),
          ),
        )

      const commands = {
        "!status": commandStatus,
        "!reset": commandRecreate,
        "!recreate": commandRecreate,
      } as const
      type CommandName = keyof typeof commands
      const isCommand = (text: string): text is CommandName => text in commands

      const command = (event: Inbound, target: { threadId: ThreadId; channelId: ChannelId }) =>
        Effect.gen(function* () {
          const text = event.content.trim().toLowerCase()
          if (!isCommand(text)) return false
          yield* commands[text](target.threadId)
          return true
        })

      const turnRaw = Effect.fn("Conversation.turnRaw")(function* (event: Inbound) {
        if (!(yield* route(event))) return

        const target = yield* resolve(event)

        if (yield* command(event, target)) return

        yield* Effect.logInfo("User message").pipe(
          Effect.annotateLogs({
            event: "conversation.user.message",
            thread_id: target.threadId,
            author_id: event.authorId,
            content: event.content.slice(0, 200),
          }),
        )

        yield* outbox
          .withTyping(
            target.threadId,
            Effect.gen(function* () {
              const reply = yield* threadChat.send({
                threadId: target.threadId,
                channelId: target.channelId,
                guildId: event.guildId,
                messageId: event.messageId,
                text: event.content,
              }).pipe(
                Effect.map((out) => out.text),
                Effect.mapError(asSendError(target.threadId)),
              )

              yield* Effect.logInfo("Bot reply").pipe(
                Effect.annotateLogs({
                  event: "conversation.bot.reply",
                  thread_id: target.threadId,
                  content: reply.slice(0, 200),
                }),
              )
              yield* publishText(target.threadId, reply)
            }),
          )
          .pipe(Effect.catchAll(reportFailure(target.threadId)))
      })

      const keyOf = (event: Inbound) =>
        event.kind === "thread_message" ? `thread:${event.threadId}` : `channel:${event.channelId}`

      const processEvent = (event: Inbound) => actors.run(keyOf(event), turnRaw(event), { touch: false })
      const processFresh = (event: Inbound) =>
        dedup.dedup(event.messageId).pipe(
          Effect.flatMap((fresh) => {
            if (!fresh) return Effect.void
            return processEvent(event)
          }),
        )

      const turn = Effect.fn("Conversation.turn")(function* (event: Inbound) {
        yield* processFresh(event)
      })

      const run = inbox.events.pipe(
        Stream.mapEffect(
          (event) =>
            dedup.dedup(event.messageId).pipe(
              Effect.flatMap((fresh) => {
                if (!fresh) return Effect.void
                return processEvent(event).pipe(
                  Effect.retry(turnRetry),
                  Effect.catchAll((error) =>
                    Effect.logError("Conversation turn failed").pipe(
                      Effect.annotateLogs({
                        event: "conversation.turn.failed",
                        tag: error._tag,
                        retriable: error.retriable,
                        message: error.message,
                      }),
                    ),
                  ),
                )
              }),
            ),
          { concurrency: "unbounded", unordered: true },
        ),
        Stream.runDrain,
      )

      return Conversation.of({ turn, run })
    }),
  )
}
