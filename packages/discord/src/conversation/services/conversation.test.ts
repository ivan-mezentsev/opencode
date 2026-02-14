import { describe, expect } from "bun:test"
import { Deferred, Effect, Fiber, Layer, Option, Stream } from "effect"
import { TurnRouter, TurnRoutingDecision } from "../../discord/turn-routing"
import { DatabaseError, OpenCodeClientError, SandboxDeadError } from "../../errors"
import { ThreadAgentPool, type ThreadAgent } from "../../sandbox/pool"
import { effectTest, testConfigLayer } from "../../test/effect"
import { ChannelId, GuildId, SandboxId, SessionId, SessionInfo, ThreadId } from "../../types"
import { Mention, ThreadMessage, ThreadRef, Typing, type Action, type Inbound } from "../model/schema"
import { History } from "./history"
import { Inbox } from "./inbox"
import { ConversationLedger } from "./ledger"
import { Outbox } from "./outbox"
import { Threads } from "./threads"
import { Conversation } from "./conversation"

const makeSession = (id: string, threadId = "t1", channelId = "c1") =>
  SessionInfo.make({
    threadId: ThreadId.make(threadId),
    channelId: ChannelId.make(channelId),
    guildId: GuildId.make("g1"),
    sandboxId: SandboxId.make("sb1"),
    sessionId: SessionId.make(id),
    previewUrl: "https://preview",
    previewToken: null,
    status: "active",
    lastError: null,
    resumeFailCount: 0,
  })

const makeThreadEvent = (props: {
  threadId: string
  channelId: string
  messageId: string
  content: string
}) =>
  ThreadMessage.make({
    kind: "thread_message",
    thread_id: ThreadId.make(props.threadId),
    channel_id: ChannelId.make(props.channelId),
    message_id: props.messageId,
    guild_id: GuildId.make("g1"),
    bot_user_id: "bot-1",
    bot_role_id: "role-1",
    author_id: "u1",
    author_is_bot: false,
    mentions_everyone: false,
    mentions: Mention.make({ user_ids: [], role_ids: [] }),
    content: props.content,
  })

const makeEvent = (content: string) =>
  makeThreadEvent({ threadId: "t1", channelId: "c1", messageId: "m1", content })

const makeChannelEvent = (content: string) => ({
  kind: "channel_message" as const,
  channel_id: ChannelId.make("c-root"),
  message_id: "m-root",
  guild_id: GuildId.make("g1"),
  bot_user_id: "bot-1",
  bot_role_id: "role-1",
  author_id: "u1",
  author_is_bot: false,
  mentions_everyone: false,
  mentions: Mention.make({ user_ids: ["bot-1"], role_ids: [] }),
  content,
})

const makeRouterLayer = (shouldRespond: boolean) =>
  Layer.succeed(
    TurnRouter,
    TurnRouter.of({
      shouldRespond: () =>
        Effect.succeed(
          TurnRoutingDecision.make({
            shouldRespond,
            reason: "test",
          }),
        ),
      generateThreadName: () => Effect.succeed("unused"),
    }),
  )

const makeAgent = (
  session: SessionInfo,
  send: (
    session: SessionInfo,
    text: string,
  ) => Effect.Effect<string, OpenCodeClientError | SandboxDeadError | DatabaseError>,
  prompts: Array<string>,
): ThreadAgent => ({
  threadId: session.threadId,
  session,
  current: () => Effect.succeed(session),
  send: (text: string) =>
    Effect.sync(() => {
      prompts.push(text)
      return { session, text }
    }).pipe(
      Effect.flatMap(({ session, text }) => send(session, text)),
    ),
  pause: () => Effect.void,
  destroy: () => Effect.void,
})

const makeConversationLayer = (props: {
  events: ReadonlyArray<Inbound>
  tracked: Option.Option<SessionInfo>
  resolves: ReadonlyArray<SessionInfo>
  resolve?: (threadId: ThreadId, channelId: ChannelId, guildId: GuildId) => SessionInfo
  send: (
    session: SessionInfo,
    text: string,
  ) => Effect.Effect<string, OpenCodeClientError | SandboxDeadError | DatabaseError>
  rehydrate: (threadId: ThreadId, latest: string) => Effect.Effect<string>
  shouldRespond?: boolean
  actions: Array<Action>
  prompts: Array<string>
}) => {
  const resolveIndex = { value: 0 }

  const inboxLayer = Layer.succeed(
    Inbox,
    Inbox.of({
      events: Stream.fromIterable(props.events),
    }),
  )

  const outboxLayer = Layer.succeed(
    Outbox,
    Outbox.of({
      publish: (action) =>
        Effect.sync(() => {
          props.actions.push(action)
        }),
      withTyping: <A, E, R>(thread_id: ThreadId, self: Effect.Effect<A, E, R>) =>
        Effect.gen(function* () {
          props.actions.push(
            Typing.make({
              kind: "typing",
              thread_id,
            }),
          )
          return yield* self
        }),
    }),
  )

  const historyLayer = Layer.succeed(
    History,
    History.of({
      rehydrate: props.rehydrate,
    }),
  )

  const threadsLayer = Layer.succeed(
    Threads,
    Threads.of({
      ensure: (event) => {
        if (event.kind === "thread_message") {
          return Effect.succeed(ThreadRef.make({ thread_id: event.thread_id, channel_id: event.channel_id }))
        }
        return Effect.succeed(ThreadRef.make({ thread_id: ThreadId.make("t-new"), channel_id: event.channel_id }))
      },
    }),
  )

  const resolveSession = (threadId: ThreadId, channelId: ChannelId, guildId: GuildId): SessionInfo => {
    if (props.resolve) return props.resolve(threadId, channelId, guildId)
    const ix = Math.min(resolveIndex.value, props.resolves.length - 1)
    const session = props.resolves[ix]!
    resolveIndex.value += 1
    return session
  }

  const poolLayer = Layer.succeed(
    ThreadAgentPool,
    ThreadAgentPool.of({
      getOrCreate: (threadId, channelId, guildId) =>
        Effect.sync(() => {
          const session = resolveSession(threadId, channelId, guildId)
          return makeAgent(session, props.send, props.prompts)
        }),
      hasTrackedThread: () => Effect.succeed(true),
      getTrackedSession: () => Effect.succeed(props.tracked),
      getActiveSessionCount: () => Effect.succeed(0),
      pauseSession: () => Effect.void,
      destroySession: () => Effect.void,
    }),
  )

  return Conversation.layer.pipe(
    Layer.provideMerge(inboxLayer),
    Layer.provideMerge(outboxLayer),
    Layer.provideMerge(historyLayer),
    Layer.provideMerge(ConversationLedger.noop),
    Layer.provideMerge(threadsLayer),
    Layer.provideMerge(poolLayer),
    Layer.provideMerge(makeRouterLayer(props.shouldRespond ?? true)),
    Layer.provideMerge(testConfigLayer),
  )
}

describe("Conversation", () => {
  effectTest("run consumes fake inbox and publishes typing + send", () => {
    const actions: Array<Action> = []
    const prompts: Array<string> = []
    const live = makeConversationLayer({
      events: [makeEvent("hello")],
      tracked: Option.none(),
      resolves: [makeSession("s1")],
      send: (_session, text) => Effect.succeed(`echo:${text}`),
      rehydrate: (_threadId, latest) => Effect.succeed(`rehydrated:${latest}`),
      actions,
      prompts,
    })

    return Effect.gen(function* () {
      const conversation = yield* Conversation
      yield* conversation.run

      expect(prompts).toEqual(["hello"])
      expect(actions.map((x) => x.kind)).toEqual(["typing", "send"])
      const sent = actions[1]
      if (!sent) throw new Error("missing send action")
      expect(sent.kind).toBe("send")
      expect(sent.thread_id).toBe(ThreadId.make("t1"))
      if (sent.kind === "send") expect(sent.text).toBe("echo:hello")
    }).pipe(Effect.provide(live))
  })

  effectTest("turn rehydrates prompt when tracked and resolved sessions differ", () => {
    const actions: Array<Action> = []
    const prompts: Array<string> = []
    const live = makeConversationLayer({
      events: [],
      tracked: Option.some(makeSession("s-old")),
      resolves: [makeSession("s-new")],
      send: () => Effect.succeed("ok"),
      rehydrate: (_threadId, latest) => Effect.succeed(`rehydrated:${latest}`),
      actions,
      prompts,
    })

    return Effect.gen(function* () {
      const conversation = yield* Conversation
      yield* conversation.turn(makeEvent("help me"))

      expect(prompts).toEqual(["rehydrated:help me"])
      expect(actions.map((x) => x.kind)).toEqual(["typing", "send"])
      const sent = actions[1]
      if (!sent) throw new Error("missing send action")
      expect(sent.kind).toBe("send")
      expect(sent.thread_id).toBe(ThreadId.make("t1"))
      if (sent.kind === "send") expect(sent.text).toBe("ok")
    }).pipe(Effect.provide(live))
  })

  effectTest("turn recovers from dead sandbox by re-resolving and retrying", () => {
    const actions: Array<Action> = []
    const prompts: Array<string> = []
    const calls = { value: 0 }
    const live = makeConversationLayer({
      events: [],
      tracked: Option.none(),
      resolves: [makeSession("s-a"), makeSession("s-b")],
      send: (_session, text) => {
        if (calls.value === 0) {
          calls.value += 1
          return Effect.fail(
            SandboxDeadError.make({
              threadId: ThreadId.make("t1"),
              reason: "dead",
            }),
          )
        }
        calls.value += 1
        return Effect.succeed(`ok:${text}`)
      },
      rehydrate: (_threadId, latest) => Effect.succeed(`rehydrated:${latest}`),
      actions,
      prompts,
    })

    return Effect.gen(function* () {
      const conversation = yield* Conversation
      yield* conversation.turn(makeEvent("fix build"))

      expect(prompts).toEqual(["fix build", "rehydrated:fix build"])
      expect(actions.map((x) => x.kind)).toEqual(["typing", "send", "send"])
      const recovery = actions[1]
      if (!recovery) throw new Error("missing recovery action")
      expect(recovery.kind).toBe("send")
      expect(recovery.thread_id).toBe(ThreadId.make("t1"))
      if (recovery.kind === "send") expect(recovery.text).toBe("*Session changed state, recovering...*")

      const sent = actions[2]
      if (!sent) throw new Error("missing final action")
      expect(sent.kind).toBe("send")
      expect(sent.thread_id).toBe(ThreadId.make("t1"))
      if (sent.kind === "send") expect(sent.text).toBe("ok:rehydrated:fix build")
    }).pipe(Effect.provide(live))
  })

  effectTest("turn handles a channel message by using ensured thread target", () => {
    const actions: Array<Action> = []
    const prompts: Array<string> = []
    const live = makeConversationLayer({
      events: [],
      tracked: Option.none(),
      resolves: [makeSession("s1")],
      send: (_session, text) => Effect.succeed(`echo:${text}`),
      rehydrate: (_threadId, latest) => Effect.succeed(`rehydrated:${latest}`),
      actions,
      prompts,
    })

    return Effect.gen(function* () {
      const conversation = yield* Conversation
      yield* conversation.turn(makeChannelEvent("from channel"))

      expect(prompts).toEqual(["from channel"])
      expect(actions.map((x) => x.kind)).toEqual(["typing", "send"])
      const sent = actions[1]
      if (!sent) throw new Error("missing send action")
      expect(sent.kind).toBe("send")
      expect(sent.thread_id).toBe(ThreadId.make("t-new"))
      if (sent.kind === "send") expect(sent.text).toBe("echo:from channel")
    }).pipe(Effect.provide(live))
  })

  effectTest("run retries retriable failures in-process", () => {
    const actions: Array<Action> = []
    const prompts: Array<string> = []
    const calls = { value: 0 }
    const live = makeConversationLayer({
      events: [makeEvent("retry now")],
      tracked: Option.none(),
      resolves: [makeSession("s1")],
      send: (_session, text) =>
        Effect.gen(function* () {
          calls.value += 1
          if (calls.value === 1) {
            return yield* Effect.fail(new OpenCodeClientError({
              operation: "sendPrompt",
              statusCode: 502,
              body: "StatusCode: non 2xx status code (502 POST https://proxy.daytona.works/session/s1/message)",
            }))
          }
          return `ok:${text}`
        }),
      rehydrate: (_threadId, latest) => Effect.succeed(`rehydrated:${latest}`),
      actions,
      prompts,
    })

    return Effect.gen(function* () {
      const conversation = yield* Conversation
      yield* conversation.run

      expect(prompts).toEqual(["retry now", "retry now"])
      expect(actions.map((x) => x.kind)).toEqual(["typing", "typing", "send"])
      const sent = actions[2]
      if (!sent) throw new Error("missing send action")
      expect(sent.kind).toBe("send")
      expect(sent.thread_id).toBe(ThreadId.make("t1"))
      if (sent.kind === "send") expect(sent.text).toBe("ok:retry now")
    }).pipe(Effect.provide(live))
  })

  effectTest("turn sends generic non-retriable error text", () => {
    const actions: Array<Action> = []
    const prompts: Array<string> = []
    const live = makeConversationLayer({
      events: [],
      tracked: Option.none(),
      resolves: [makeSession("s1")],
      send: () =>
        Effect.fail(new DatabaseError({
          cause: new Error("StatusCode: non 2xx status code (502 POST https://proxy.daytona.works/session/s1/message)"),
        })),
      rehydrate: (_threadId, latest) => Effect.succeed(`rehydrated:${latest}`),
      actions,
      prompts,
    })

    return Effect.gen(function* () {
      const conversation = yield* Conversation
      yield* conversation.turn(makeEvent("oops")).pipe(Effect.either)

      expect(prompts).toEqual(["oops"])
      expect(actions.map((x) => x.kind)).toEqual(["typing", "send"])
      const sent = actions[1]
      if (!sent) throw new Error("missing send action")
      expect(sent.kind).toBe("send")
      expect(sent.thread_id).toBe(ThreadId.make("t1"))
      if (sent.kind === "send") {
        expect(sent.text).toBe("Something went wrong. Please try again in a moment.")
        expect(sent.text.includes("proxy.daytona.works")).toBe(false)
      }
    }).pipe(Effect.provide(live))
  })

  effectTest("run processes different thread keys concurrently", () => {
    const actions: Array<Action> = []
    const prompts: Array<string> = []
    const gate = Effect.runSync(Deferred.make<void>())
    const fast = Effect.runSync(Deferred.make<void>())
    const live = makeConversationLayer({
      events: [
        makeThreadEvent({ threadId: "t1", channelId: "c1", messageId: "m1", content: "slow" }),
        makeThreadEvent({ threadId: "t2", channelId: "c2", messageId: "m2", content: "fast" }),
      ],
      tracked: Option.none(),
      resolves: [makeSession("s-a", "t1", "c1"), makeSession("s-b", "t2", "c2")],
      resolve: (threadId, channelId) => {
        if (threadId === "t2") return makeSession("s-b", "t2", channelId)
        return makeSession("s-a", "t1", channelId)
      },
      send: (session, text) =>
        Effect.gen(function* () {
          if (session.threadId === ThreadId.make("t2")) {
            yield* Deferred.succeed(fast, undefined)
            return `ok:${text}`
          }
          yield* Deferred.await(gate)
          return `ok:${text}`
        }),
      rehydrate: (_threadId, latest) => Effect.succeed(`rehydrated:${latest}`),
      actions,
      prompts,
    })

    return Effect.gen(function* () {
      const conversation = yield* Conversation
      const fiber = yield* Effect.forkScoped(conversation.run)
      yield* Deferred.await(fast).pipe(
        Effect.timeoutFail({ duration: "1 second", onTimeout: () => "thread-concurrency-blocked" }),
      )
      yield* Deferred.succeed(gate, undefined)
      yield* Fiber.join(fiber)

      expect(prompts.sort()).toEqual(["fast", "slow"])
      expect(actions.filter((x) => x.kind === "typing").length).toBe(2)
    }).pipe(Effect.provide(live))
  })
})

// --- Duplicate processing tests ---

/** A ledger that tracks dedup calls */
const makeTrackingLedger = () => {
  const seen = new Set<string>()
  const dedupCalls: Array<string> = []

  const service: ConversationLedger.Service = {
    dedup: (message_id) =>
      Effect.sync(() => {
        dedupCalls.push(message_id)
        if (seen.has(message_id)) return false
        seen.add(message_id)
        return true
      }),
    getOffset: () => Effect.succeed(Option.none()),
    setOffset: () => Effect.void,
  }

  return { service, seen, dedupCalls }
}

const makeConversationLayerWithLedger = (props: {
  events: ReadonlyArray<Inbound>
  tracked: Option.Option<SessionInfo>
  resolves: ReadonlyArray<SessionInfo>
  resolve?: (threadId: ThreadId, channelId: ChannelId, guildId: GuildId) => SessionInfo
  send: (
    session: SessionInfo,
    text: string,
  ) => Effect.Effect<string, OpenCodeClientError | SandboxDeadError | DatabaseError>
  rehydrate: (threadId: ThreadId, latest: string) => Effect.Effect<string>
  shouldRespond?: boolean
  actions: Array<Action>
  prompts: Array<string>
  ledger: ConversationLedger.Service
}) => {
  const resolveIndex = { value: 0 }

  const inboxLayer = Layer.succeed(
    Inbox,
    Inbox.of({
      events: Stream.fromIterable(props.events),
    }),
  )

  const outboxLayer = Layer.succeed(
    Outbox,
    Outbox.of({
      publish: (action) =>
        Effect.sync(() => {
          props.actions.push(action)
        }),
      withTyping: <A, E, R>(thread_id: ThreadId, self: Effect.Effect<A, E, R>) =>
        Effect.gen(function* () {
          props.actions.push(
            Typing.make({
              kind: "typing",
              thread_id,
            }),
          )
          return yield* self
        }),
    }),
  )

  const historyLayer = Layer.succeed(
    History,
    History.of({
      rehydrate: props.rehydrate,
    }),
  )

  const threadsLayer = Layer.succeed(
    Threads,
    Threads.of({
      ensure: (event) => {
        if (event.kind === "thread_message") {
          return Effect.succeed(ThreadRef.make({ thread_id: event.thread_id, channel_id: event.channel_id }))
        }
        return Effect.succeed(ThreadRef.make({ thread_id: ThreadId.make("t-new"), channel_id: event.channel_id }))
      },
    }),
  )

  const resolveSession = (threadId: ThreadId, channelId: ChannelId, guildId: GuildId): SessionInfo => {
    if (props.resolve) return props.resolve(threadId, channelId, guildId)
    const ix = Math.min(resolveIndex.value, props.resolves.length - 1)
    const session = props.resolves[ix]!
    resolveIndex.value += 1
    return session
  }

  const poolLayer = Layer.succeed(
    ThreadAgentPool,
    ThreadAgentPool.of({
      getOrCreate: (threadId, channelId, guildId) =>
        Effect.sync(() => {
          const session = resolveSession(threadId, channelId, guildId)
          return makeAgent(session, props.send, props.prompts)
        }),
      hasTrackedThread: () => Effect.succeed(true),
      getTrackedSession: () => Effect.succeed(props.tracked),
      getActiveSessionCount: () => Effect.succeed(0),
      pauseSession: () => Effect.void,
      destroySession: () => Effect.void,
    }),
  )

  const ledgerLayer = Layer.succeed(ConversationLedger, ConversationLedger.of(props.ledger))

  return Conversation.layer.pipe(
    Layer.provideMerge(inboxLayer),
    Layer.provideMerge(outboxLayer),
    Layer.provideMerge(historyLayer),
    Layer.provideMerge(ledgerLayer),
    Layer.provideMerge(threadsLayer),
    Layer.provideMerge(poolLayer),
    Layer.provideMerge(makeRouterLayer(props.shouldRespond ?? true)),
    Layer.provideMerge(testConfigLayer),
  )
}

describe("Conversation duplicate processing", () => {
  effectTest("same message_id queued twice via run is only sent once", () => {
    const actions: Array<Action> = []
    const prompts: Array<string> = []
    const ledger = makeTrackingLedger()
    const event = makeEvent("hello")

    const live = makeConversationLayerWithLedger({
      // Feed the same event twice to simulate catch-up + real-time race
      events: [event, event],
      tracked: Option.none(),
      resolves: [makeSession("s1")],
      send: (_session, text) => Effect.succeed(`echo:${text}`),
      rehydrate: (_threadId, latest) => Effect.succeed(`rehydrated:${latest}`),
      actions,
      prompts,
      ledger: ledger.service,
    })

    return Effect.gen(function* () {
      const conversation = yield* Conversation
      yield* conversation.run

      // The ledger should have been called twice with dedup
      expect(ledger.dedupCalls).toEqual(["m1", "m1"])
      // The agent should have received the prompt only once
      expect(prompts).toEqual(["hello"])
      // Only one typing + one send
      expect(actions.filter((x) => x.kind === "send").length).toBe(1)
    }).pipe(Effect.provide(live))
  })

  effectTest("noop ledger deduplicates", () => {
    const actions: Array<Action> = []
    const prompts: Array<string> = []
    const event = makeEvent("hello")

    // The noop ledger tracks seen message_ids
    const live = makeConversationLayer({
      events: [event, event],
      tracked: Option.none(),
      resolves: [makeSession("s1")],
      send: (_session, text) => Effect.succeed(`echo:${text}`),
      rehydrate: (_threadId, latest) => Effect.succeed(`rehydrated:${latest}`),
      actions,
      prompts,
    })

    return Effect.gen(function* () {
      const conversation = yield* Conversation
      yield* conversation.run

      // Same event fed twice but only processed once
      expect(prompts).toEqual(["hello"])
      expect(actions.filter((x) => x.kind === "send").length).toBe(1)
    }).pipe(Effect.provide(live))
  })

  effectTest("turn called twice with same event only processes once with tracking ledger", () => {
    const actions: Array<Action> = []
    const prompts: Array<string> = []
    const ledger = makeTrackingLedger()
    const event = makeEvent("help me")

    const live = makeConversationLayerWithLedger({
      events: [],
      tracked: Option.none(),
      resolves: [makeSession("s1")],
      send: (_session, text) => Effect.succeed(`echo:${text}`),
      rehydrate: (_threadId, latest) => Effect.succeed(`rehydrated:${latest}`),
      actions,
      prompts,
      ledger: ledger.service,
    })

    return Effect.gen(function* () {
      const conversation = yield* Conversation
      // Call turn twice with the same event (simulating race between real-time and catch-up)
      yield* conversation.turn(event)
      yield* conversation.turn(event)

      expect(prompts).toEqual(["help me"])
      expect(actions.filter((x) => x.kind === "send").length).toBe(1)
    }).pipe(Effect.provide(live))
  })

  effectTest("two different messages on same thread are processed sequentially (not lost)", () => {
    const actions: Array<Action> = []
    const prompts: Array<string> = []
    const ledger = makeTrackingLedger()
    const event1 = makeThreadEvent({ threadId: "t1", channelId: "c1", messageId: "m1", content: "first" })
    const event2 = makeThreadEvent({ threadId: "t1", channelId: "c1", messageId: "m2", content: "second" })

    const live = makeConversationLayerWithLedger({
      events: [event1, event2],
      tracked: Option.none(),
      resolves: [makeSession("s1")],
      send: (_session, text) => Effect.succeed(`echo:${text}`),
      rehydrate: (_threadId, latest) => Effect.succeed(`rehydrated:${latest}`),
      actions,
      prompts,
      ledger: ledger.service,
    })

    return Effect.gen(function* () {
      const conversation = yield* Conversation
      yield* conversation.run

      // Both messages should be processed (different message_ids)
      expect(prompts).toEqual(["first", "second"])
      expect(actions.filter((x) => x.kind === "send").length).toBe(2)
    }).pipe(Effect.provide(live))
  })
})
