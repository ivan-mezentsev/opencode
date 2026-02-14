import { Context, Effect, Layer, Option, Schedule, Stream } from "effect"
import { AppConfig } from "../../config"
import { TurnRouter } from "../../discord/turn-routing"
import { ActorMap } from "../../lib/actors/keyed"
import { ThreadAgentPool } from "../../sandbox/pool"
import type { ChannelId, ThreadId } from "../../types"
import { type ConversationError, messageOf, RoutingError, SandboxSendError } from "../model/errors"
import { Send, type Inbound } from "../model/schema"
import { History } from "./history"
import { Inbox } from "./inbox"
import { ConversationLedger } from "./ledger"
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
      const history = yield* History
      const threads = yield* Threads
      const ledger = yield* ConversationLedger
      const config = yield* AppConfig
      const pool = yield* ThreadAgentPool
      const router = yield* TurnRouter
      const actors = yield* ActorMap.make<string>()
      const RETRIABLE_TAGS: ReadonlySet<string> = new Set([
        "SandboxDeadError",
        "OpenCodeClientError",
        "HealthCheckError",
        "SandboxStartError",
      ])
      const RETRY_MESSAGE = "Something went wrong. Please try again in a moment."
      const turnRetry = Schedule.exponential("500 millis").pipe(
        Schedule.intersect(Schedule.recurs(2)),
        Schedule.whileInput((error: ConversationError) => error.retriable),
      )

      const asSendError =
        (thread_id: ThreadId) =>
        (cause: { readonly _tag: string }): SandboxSendError =>
          SandboxSendError.make({
            thread_id,
            message: messageOf(cause),
            retriable: RETRIABLE_TAGS.has(cause._tag),
          })

      const publishText = (threadId: ThreadId, text: string) =>
        outbox.publish(
          Send.make({
            kind: "send",
            thread_id: threadId,
            text,
          }),
        )

      const reportFailure = (thread_id: ThreadId) => (error: ConversationError) => {
        if (error.retriable) return Effect.fail(error)
        return publishText(thread_id, RETRY_MESSAGE).pipe(
          Effect.catchAll(() => Effect.void),
          Effect.zipRight(Effect.fail(error)),
        )
      }

      const route = Effect.fn("Conversation.route")(function* (event: Inbound) {
        if (event.author_is_bot) return false
        if (event.mentions_everyone) return false
        if (!event.content.trim()) return false

        const mentioned =
          event.mentions.user_ids.includes(event.bot_user_id) ||
          (event.bot_role_id.length > 0 && event.mentions.role_ids.includes(event.bot_role_id))
        if (event.kind === "channel_message") return mentioned
        if (mentioned) return true

        const owned = yield* pool.hasTrackedThread(event.thread_id).pipe(Effect.mapError(asSendError(event.thread_id)))
        if (!owned) return false

        const decision = yield* router
          .shouldRespond({
            content: event.content,
            botUserId: event.bot_user_id,
            botRoleId: event.bot_role_id,
            mentionedUserIds: event.mentions.user_ids,
            mentionedRoleIds: event.mentions.role_ids,
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
          return { thread_id: event.thread_id, channel_id: event.channel_id }
        }
        const name = yield* router.generateThreadName(event.content)
        return yield* threads.ensure(event, name)
      })

      const buildInput = Effect.fn("Conversation.buildInput")(function* (
        event: Inbound,
        target: { thread_id: ThreadId; channel_id: ChannelId },
      ) {
        const toSendError = asSendError(target.thread_id)
        const tracked = yield* pool.getTrackedSession(target.thread_id).pipe(Effect.mapError(toSendError))
        const agent = yield* pool
          .getOrCreate(target.thread_id, target.channel_id, event.guild_id)
          .pipe(Effect.mapError(toSendError))
        const current = yield* agent.current().pipe(Effect.mapError(toSendError))
        const prompt =
          Option.isSome(tracked) && tracked.value.sessionId !== current.sessionId
            ? yield* history.rehydrate(target.thread_id, event.content)
            : event.content
        return { target, agent, prompt, session: current }
      })

      const command = (event: Inbound, target: { thread_id: ThreadId; channel_id: ChannelId }) =>
        Effect.gen(function* () {
          const text = event.content.trim().toLowerCase()
          if (text === "!reset") {
            yield* pool.destroySession(target.thread_id).pipe(Effect.catchAll(() => Effect.void))
            yield* publishText(target.thread_id, "*☠️ Session destroyed. Next message will provision a fresh sandbox.*")
            return true
          }
          if (text === "!status") {
            const tracked = yield* pool
              .getTrackedSession(target.thread_id)
              .pipe(Effect.catchAll(() => Effect.succeed(Option.none())))
            if (Option.isNone(tracked)) {
              yield* publishText(target.thread_id, "*No active session for this thread.*")
            } else {
              const s = tracked.value
              const model = config.openCodeModel.replace("opencode/", "")
              const lines = [
                `**Status:** ${s.status}`,
                `**Model:** \`${model}\``,
                `**Sandbox:** \`${s.sandboxId}\``,
                `**Session:** \`${s.sessionId}\``,
                s.resumeFailCount > 0 ? `**Resume failures:** ${s.resumeFailCount}` : null,
                s.lastError ? `**Last error:** ${s.lastError.slice(0, 200)}` : null,
              ].filter(Boolean)
              yield* publishText(target.thread_id, lines.join("\n"))
            }
            return true
          }
          return false
        })

      const turnRaw = Effect.fn("Conversation.turnRaw")(function* (event: Inbound) {
        if (!(yield* route(event))) return

        const target = yield* resolve(event)

        if (yield* command(event, target)) return

        yield* Effect.logInfo("User message").pipe(
          Effect.annotateLogs({
            event: "conversation.user.message",
            thread_id: target.thread_id,
            author_id: event.author_id,
            content: event.content.slice(0, 200),
          }),
        )

        yield* outbox
          .withTyping(
            target.thread_id,
            Effect.gen(function* () {
              const input = yield* buildInput(event, target)

              const reply = yield* input.agent.send(input.prompt).pipe(
                Effect.catchTag("SandboxDeadError", () =>
                  Effect.gen(function* () {
                    yield* publishText(input.target.thread_id, "*Session changed state, recovering...*")
                    const toErr = asSendError(input.target.thread_id)
                    const next = yield* pool
                      .getOrCreate(input.target.thread_id, input.target.channel_id, event.guild_id)
                      .pipe(Effect.mapError(toErr))
                    const nextSession = yield* next.current().pipe(Effect.mapError(toErr))
                    const prompt =
                      nextSession.sessionId !== input.session.sessionId
                        ? yield* history.rehydrate(input.target.thread_id, event.content)
                        : event.content
                    return yield* next.send(prompt)
                  }),
                ),
                Effect.mapError(asSendError(input.target.thread_id)),
              )

              yield* Effect.logInfo("Bot reply").pipe(
                Effect.annotateLogs({
                  event: "conversation.bot.reply",
                  thread_id: input.target.thread_id,
                  content: reply.slice(0, 200),
                }),
              )
              yield* publishText(input.target.thread_id, reply)
            }),
          )
          .pipe(Effect.catchAll(reportFailure(target.thread_id)))
      })

      const keyOf = (event: Inbound) =>
        event.kind === "thread_message" ? `thread:${event.thread_id}` : `channel:${event.channel_id}`

      const processEvent = (event: Inbound) => actors.run(keyOf(event), turnRaw(event), { touch: false })

      const turn = Effect.fn("Conversation.turn")(function* (event: Inbound) {
        const fresh = yield* ledger.dedup(event.message_id)
        if (!fresh) return
        yield* processEvent(event)
      })

      const run = inbox.events.pipe(
        Stream.mapEffect(
          (event) =>
            ledger.dedup(event.message_id).pipe(
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
