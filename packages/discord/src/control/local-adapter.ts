import { Effect, Layer, Queue, Schedule, Stream } from "effect"
import { TYPING_INTERVAL } from "../discord/constants"
import { ChannelId, GuildId, ThreadId } from "../types"
import { ChannelMessage, Mention, ThreadMessage, ThreadRef, Typing, type Action, type Inbound } from "../conversation/model/schema"
import { History, Inbox, Outbox, Threads } from "../conversation"

export type Tui = {
  layer: Layer.Layer<Inbox | Outbox | History | Threads, never, never>
  send: (text: string) => Effect.Effect<void>
  sendTo: (threadId: ThreadId, text: string) => Effect.Effect<void>
  take: Effect.Effect<Action>
  actions: Stream.Stream<Action>
}

export const makeTui = Effect.gen(function* () {
  const input = yield* Queue.unbounded<Inbound>()
  const output = yield* Queue.unbounded<Action>()
  const history = new Map<string, Array<string>>()
  const roots = new Map<string, ThreadId>()
  const parents = new Map<string, ChannelId>()
  const words = {
    a: ["brisk", "calm", "dapper", "eager", "fuzzy", "gentle", "jolly", "mellow", "nimble", "sunny"],
    b: ["otter", "falcon", "panda", "badger", "fox", "heron", "lemur", "raven", "tiger", "whale"],
  } as const
  let seq = 0

  const name = () => {
    const i = seq
    seq += 1
    const x = words.a[i % words.a.length] ?? "brisk"
    const y = words.b[Math.floor(i / words.a.length) % words.b.length] ?? "otter"
    const z = Math.floor(i / (words.a.length * words.b.length)) + 1
    return ThreadId.make(`thread-${x}-${y}-${z}`)
  }

  const remember = (threadId: ThreadId, line: string) => {
    const current = history.get(threadId)
    if (current) {
      current.push(line)
      return
    }
    history.set(threadId, [line])
  }

  const sendTo = (threadId: ThreadId, text: string) =>
    Effect.gen(function* () {
      remember(threadId, `user: ${text}`)
      const channelId = parents.get(threadId) ?? ChannelId.make(`channel-${threadId}`)
      yield* input.offer(
        ThreadMessage.make({
          kind: "thread_message",
          threadId,
          channelId,
          messageId: crypto.randomUUID(),
          guildId: GuildId.make("local"),
          botUserId: "local-bot",
          botRoleId: "",
          authorId: "local-user",
          authorIsBot: false,
          mentionsEveryone: false,
          mentions: Mention.make({ userIds: [], roleIds: [] }),
          content: text,
        }),
      ).pipe(Effect.asVoid)
    })

  const send = (text: string) =>
    Effect.gen(function* () {
      const channelId = ChannelId.make("local-channel")
      yield* input.offer(
        ChannelMessage.make({
          kind: "channel_message",
          channelId,
          messageId: crypto.randomUUID(),
          guildId: GuildId.make("local"),
          botUserId: "local-bot",
          botRoleId: "",
          authorId: "local-user",
          authorIsBot: false,
          mentionsEveryone: false,
          mentions: Mention.make({ userIds: ["local-bot"], roleIds: [] }),
          content: text,
        }),
      ).pipe(Effect.asVoid)
    })

  const layer = Layer.mergeAll(
    Layer.succeed(
      Inbox,
      Inbox.of({
        events: Stream.fromQueue(input, { shutdown: false }),
      }),
    ),
    Layer.succeed(
      Outbox,
      Outbox.of({
        publish: (action) =>
          Effect.gen(function* () {
            if (action.kind === "send" || action.kind === "reply") {
              remember(action.threadId, `assistant: ${action.text}`)
            }
            yield* output.offer(action).pipe(Effect.asVoid)
          }),
        withTyping: <A, E, R>(threadId: ThreadId, self: Effect.Effect<A, E, R>) =>
          Effect.scoped(
            Effect.gen(function* () {
              const pulse = output.offer(
                Typing.make({
                  kind: "typing",
                  threadId,
                }),
              ).pipe(Effect.asVoid)
              yield* pulse
              yield* Effect.forkScoped(
                Effect.repeat(pulse, Schedule.spaced(TYPING_INTERVAL)).pipe(
                  Effect.delay(TYPING_INTERVAL),
                ),
              )
              return yield* self
            }),
          ),
      }),
    ),
    Layer.succeed(
      History,
      History.of({
        rehydrate: (threadId, latest: string) =>
          Effect.sync(() => {
            const lines = history.get(threadId) ?? []
            const prior = lines.at(-1) === `user: ${latest}` ? lines.slice(0, -1) : lines
            if (prior.length === 0) return latest
            return [
              "Conversation history from this same thread (oldest to newest):",
              prior.join("\n"),
              "",
              "Continue the same conversation and respond to the latest user message:",
              latest,
            ].join("\n")
          }),
      }),
    ),
    Layer.succeed(
      Threads,
      Threads.of({
        ensure: (event) =>
          Effect.sync(() => {
            if (event.kind === "thread_message") {
              parents.set(event.threadId, event.channelId)
              return ThreadRef.make({ threadId: event.threadId, channelId: event.channelId })
            }
            const known = roots.get(event.messageId)
            if (known) return ThreadRef.make({ threadId: known, channelId: event.channelId })
            const threadId = name()
            roots.set(event.messageId, threadId)
            parents.set(threadId, event.channelId)
            return ThreadRef.make({ threadId, channelId: event.channelId })
          }),
      }),
    ),
  )

  return {
    layer,
    send,
    sendTo,
    take: output.take,
    actions: Stream.fromQueue(output, { shutdown: false }),
  } satisfies Tui
})
