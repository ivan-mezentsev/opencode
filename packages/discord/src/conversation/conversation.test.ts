import { describe, expect } from "bun:test"
import { Deferred, Effect, Fiber, Layer, Option, Predicate, Stream } from "effect"
import { ThreadChatCluster, ThreadChatError } from "./thread/cluster"
import { TurnRouter, TurnRoutingDecision } from "../discord/turn-routing"
import { classifyOpenCodeFailure, DatabaseError, OpenCodeClientError, SandboxDeadError } from "../errors"
import { effectTest, testConfigLayer } from "../test/effect"
import { ChannelId, GuildId, SandboxId, SessionId, SessionInfo, ThreadId } from "../types"
import { Mention, ThreadMessage, ThreadRef, Typing, type Action, type Inbound } from "./model/schema"
import { Inbox } from "./inbox"
import { IngressDedup } from "./dedup"
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
    threadId: ThreadId.make(props.threadId),
    channelId: ChannelId.make(props.channelId),
    messageId: props.messageId,
    guildId: GuildId.make("g1"),
    botUserId: "bot-1",
    botRoleId: "role-1",
    authorId: "u1",
    authorIsBot: false,
    mentionsEveryone: false,
    mentions: Mention.make({ userIds: [], roleIds: [] }),
    content: props.content,
  })

const makeEvent = (content: string) =>
  makeThreadEvent({ threadId: "t1", channelId: "c1", messageId: "m1", content })

const makeChannelEvent = (content: string) => ({
  kind: "channel_message" as const,
  channelId: ChannelId.make("c-root"),
  messageId: "m-root",
  guildId: GuildId.make("g1"),
  botUserId: "bot-1",
  botRoleId: "role-1",
  authorId: "u1",
  authorIsBot: false,
  mentionsEveryone: false,
  mentions: Mention.make({ userIds: ["bot-1"], roleIds: [] }),
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
  recreateCalls?: Array<ThreadId>
}) => {
  const resolveIndex = { value: 0 }
  const state = new Map<string, SessionInfo>()
  if (Option.isSome(props.tracked)) state.set(props.tracked.value.threadId, props.tracked.value)

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
      withTyping: <A, E, R>(threadId: ThreadId, self: Effect.Effect<A, E, R>) =>
        Effect.gen(function* () {
          props.actions.push(
            Typing.make({
              kind: "typing",
              threadId,
            }),
          )
          return yield* self
        }),
    }),
  )

  const threadsLayer = Layer.succeed(
    Threads,
    Threads.of({
      ensure: (event) => {
        if (event.kind === "thread_message") {
          return Effect.succeed(ThreadRef.make({ threadId: event.threadId, channelId: event.channelId }))
        }
        return Effect.succeed(ThreadRef.make({ threadId: ThreadId.make("t-new"), channelId: event.channelId }))
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

  const toThreadError = (threadId: ThreadId, cause: unknown): ThreadChatError => {
    if (cause instanceof ThreadChatError) return cause
    return ThreadChatError.make({
      threadId,
      cause,
      retriable: Predicate.isTagged(cause, "SandboxDeadError") || Predicate.isTagged(cause, "OpenCodeClientError"),
    })
  }

  const threadChatLayer = Layer.succeed(
    ThreadChatCluster,
    ThreadChatCluster.of({
      send: (input) =>
        Effect.sync(() => {
          props.prompts.push(input.text)
          const session = resolveSession(input.threadId, input.channelId, input.guildId)
          return session
        }).pipe(
          Effect.flatMap((session) =>
            props.send(session, input.text).pipe(
              Effect.map((text) => {
                const prev = state.get(input.threadId)
                state.set(input.threadId, session)
                return {
                  text,
                  session,
                  changedSession: prev ? prev.sessionId !== session.sessionId : true,
                }
              }),
              Effect.mapError((cause) => toThreadError(input.threadId, cause)),
            )),
        ),
      status: (threadId) =>
        Effect.succeed(
          Option.fromNullable(
            state.get(threadId) ?? SessionInfo.make({
              threadId,
              channelId: ChannelId.make("c1"),
              guildId: GuildId.make("g1"),
              sandboxId: SandboxId.make("sb1"),
              sessionId: SessionId.make("s-tracked"),
              previewUrl: "https://preview",
              previewToken: null,
              status: "active",
              lastError: null,
              resumeFailCount: 0,
            }),
          ),
        ),
      recreate: (threadId) =>
        Effect.sync(() => {
          props.recreateCalls?.push(threadId)
          state.delete(threadId)
        }),
    }),
  )

  return Conversation.layer.pipe(
    Layer.provideMerge(inboxLayer),
    Layer.provideMerge(outboxLayer),
    Layer.provideMerge(IngressDedup.noop),
    Layer.provideMerge(threadsLayer),
    Layer.provideMerge(threadChatLayer),
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
      expect(sent.threadId).toBe(ThreadId.make("t1"))
      if (sent.kind === "send") expect(sent.text).toBe("echo:hello")
    }).pipe(Effect.provide(live))
  })

  effectTest("turn sends thread prompt through ThreadChatCluster", () => {
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

      expect(prompts).toEqual(["help me"])
      expect(actions.map((x) => x.kind)).toEqual(["typing", "send"])
      const sent = actions[1]
      if (!sent) throw new Error("missing send action")
      expect(sent.kind).toBe("send")
      expect(sent.threadId).toBe(ThreadId.make("t1"))
      if (sent.kind === "send") expect(sent.text).toBe("ok")
    }).pipe(Effect.provide(live))
  })

  effectTest("turn returns retriable error for dead sandbox from ThreadChatCluster", () => {
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
      const out = yield* conversation.turn(makeEvent("fix build")).pipe(Effect.either)

      expect(out._tag).toBe("Left")
      expect(prompts).toEqual(["fix build"])
      expect(actions.map((x) => x.kind)).toEqual(["typing"])
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
      expect(sent.threadId).toBe(ThreadId.make("t-new"))
      if (sent.kind === "send") expect(sent.text).toBe("echo:from channel")
    }).pipe(Effect.provide(live))
  })

  effectTest("!status is handled as a command without sending to agent", () => {
    const actions: Array<Action> = []
    const prompts: Array<string> = []
    const live = makeConversationLayer({
      events: [],
      tracked: Option.some(makeSession("s1")),
      resolves: [makeSession("s1")],
      send: (_session, text) => Effect.succeed(`echo:${text}`),
      rehydrate: (_threadId, latest) => Effect.succeed(`rehydrated:${latest}`),
      actions,
      prompts,
    })

    return Effect.gen(function* () {
      const conversation = yield* Conversation
      yield* conversation.turn(makeEvent("!status"))

      expect(prompts).toEqual([])
      expect(actions.filter((action) => action.kind === "send").length).toBe(1)
      const sent = actions.find((action) => action.kind === "send")
      if (!sent || sent.kind !== "send") throw new Error("missing status output")
      expect(sent.text.includes("**Status:**")).toBe(true)
      expect(sent.text.includes("**Sandbox:**")).toBe(true)
      expect(sent.text.includes("**Session:**")).toBe(true)
    }).pipe(Effect.provide(live))
  })

  effectTest("!recreate invokes recreate command and does not call agent", () => {
    const actions: Array<Action> = []
    const prompts: Array<string> = []
    const recreateCalls: Array<ThreadId> = []
    const live = makeConversationLayer({
      events: [],
      tracked: Option.some(makeSession("s1")),
      resolves: [makeSession("s1")],
      send: (_session, text) => Effect.succeed(`echo:${text}`),
      rehydrate: (_threadId, latest) => Effect.succeed(`rehydrated:${latest}`),
      actions,
      prompts,
      recreateCalls,
    })

    return Effect.gen(function* () {
      const conversation = yield* Conversation
      yield* conversation.turn(makeEvent("!recreate"))

      expect(prompts).toEqual([])
      expect(recreateCalls).toEqual([ThreadId.make("t1")])
      const sent = actions.find((action) => action.kind === "send")
      if (!sent || sent.kind !== "send") throw new Error("missing recreate output")
      expect(sent.text.includes("Session recreated")).toBe(true)
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
            return yield* new OpenCodeClientError({
              operation: "sendPrompt",
              statusCode: 502,
              body: "StatusCode: non 2xx status code (502 POST https://proxy.daytona.works/session/s1/message)",
              kind: classifyOpenCodeFailure(
                502,
                "StatusCode: non 2xx status code (502 POST https://proxy.daytona.works/session/s1/message)",
              ),
            })
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
      expect(sent.threadId).toBe(ThreadId.make("t1"))
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
      expect(sent.threadId).toBe(ThreadId.make("t1"))
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

/** A dedup service that tracks dedup calls */
const makeTrackingDedup = () => {
  const seen = new Set<string>()
  const dedupCalls: Array<string> = []

  const service: IngressDedup.Service = {
    dedup: (messageId) =>
      Effect.sync(() => {
        dedupCalls.push(messageId)
        if (seen.has(messageId)) return false
        seen.add(messageId)
        return true
      }),
  }

  return { service, seen, dedupCalls }
}

const makeConversationLayerWithDedup = (props: {
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
  dedup: IngressDedup.Service
}) => {
  const resolveIndex = { value: 0 }
  const state = new Map<string, SessionInfo>()
  if (Option.isSome(props.tracked)) state.set(props.tracked.value.threadId, props.tracked.value)

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
      withTyping: <A, E, R>(threadId: ThreadId, self: Effect.Effect<A, E, R>) =>
        Effect.gen(function* () {
          props.actions.push(
            Typing.make({
              kind: "typing",
              threadId,
            }),
          )
          return yield* self
        }),
    }),
  )

  const threadsLayer = Layer.succeed(
    Threads,
    Threads.of({
      ensure: (event) => {
        if (event.kind === "thread_message") {
          return Effect.succeed(ThreadRef.make({ threadId: event.threadId, channelId: event.channelId }))
        }
        return Effect.succeed(ThreadRef.make({ threadId: ThreadId.make("t-new"), channelId: event.channelId }))
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

  const toThreadError = (threadId: ThreadId, cause: unknown): ThreadChatError => {
    if (cause instanceof ThreadChatError) return cause
    return ThreadChatError.make({
      threadId,
      cause,
      retriable: Predicate.isTagged(cause, "SandboxDeadError") || Predicate.isTagged(cause, "OpenCodeClientError"),
    })
  }

  const threadChatLayer = Layer.succeed(
    ThreadChatCluster,
    ThreadChatCluster.of({
      send: (input) =>
        Effect.sync(() => {
          props.prompts.push(input.text)
          const session = resolveSession(input.threadId, input.channelId, input.guildId)
          return session
        }).pipe(
          Effect.flatMap((session) =>
            props.send(session, input.text).pipe(
              Effect.map((text) => {
                const prev = state.get(input.threadId)
                state.set(input.threadId, session)
                return {
                  text,
                  session,
                  changedSession: prev ? prev.sessionId !== session.sessionId : true,
                }
              }),
              Effect.mapError((cause) => toThreadError(input.threadId, cause)),
            )),
        ),
      status: (threadId) =>
        Effect.succeed(
          Option.fromNullable(
            state.get(threadId) ?? SessionInfo.make({
              threadId,
              channelId: ChannelId.make("c1"),
              guildId: GuildId.make("g1"),
              sandboxId: SandboxId.make("sb1"),
              sessionId: SessionId.make("s-tracked"),
              previewUrl: "https://preview",
              previewToken: null,
              status: "active",
              lastError: null,
              resumeFailCount: 0,
            }),
          ),
        ),
      recreate: (threadId) =>
        Effect.sync(() => {
          state.delete(threadId)
        }),
    }),
  )

  const dedupLayer = Layer.succeed(IngressDedup, IngressDedup.of(props.dedup))

  return Conversation.layer.pipe(
    Layer.provideMerge(inboxLayer),
    Layer.provideMerge(outboxLayer),
    Layer.provideMerge(dedupLayer),
    Layer.provideMerge(threadsLayer),
    Layer.provideMerge(threadChatLayer),
    Layer.provideMerge(makeRouterLayer(props.shouldRespond ?? true)),
    Layer.provideMerge(testConfigLayer),
  )
}

describe("Conversation duplicate processing", () => {
  effectTest("same message_id queued twice via run is only sent once", () => {
    const actions: Array<Action> = []
    const prompts: Array<string> = []
    const dedup = makeTrackingDedup()
    const event = makeEvent("hello")

    const live = makeConversationLayerWithDedup({
      // Feed the same event twice to simulate catch-up + real-time race
      events: [event, event],
      tracked: Option.none(),
      resolves: [makeSession("s1")],
      send: (_session, text) => Effect.succeed(`echo:${text}`),
      rehydrate: (_threadId, latest) => Effect.succeed(`rehydrated:${latest}`),
      actions,
      prompts,
      dedup: dedup.service,
    })

    return Effect.gen(function* () {
      const conversation = yield* Conversation
      yield* conversation.run

      // The ledger should have been called twice with dedup
      expect(dedup.dedupCalls).toEqual(["m1", "m1"])
      // The agent should have received the prompt only once
      expect(prompts).toEqual(["hello"])
      // Only one typing + one send
      expect(actions.filter((x) => x.kind === "send").length).toBe(1)
    }).pipe(Effect.provide(live))
  })

  effectTest("noop dedup service deduplicates", () => {
    const actions: Array<Action> = []
    const prompts: Array<string> = []
    const event = makeEvent("hello")

    // The noop dedup service tracks seen message_ids
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

  effectTest("turn called twice with same event only processes once with tracking dedup service", () => {
    const actions: Array<Action> = []
    const prompts: Array<string> = []
    const dedup = makeTrackingDedup()
    const event = makeEvent("help me")

    const live = makeConversationLayerWithDedup({
      events: [],
      tracked: Option.none(),
      resolves: [makeSession("s1")],
      send: (_session, text) => Effect.succeed(`echo:${text}`),
      rehydrate: (_threadId, latest) => Effect.succeed(`rehydrated:${latest}`),
      actions,
      prompts,
      dedup: dedup.service,
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
    const dedup = makeTrackingDedup()
    const event1 = makeThreadEvent({ threadId: "t1", channelId: "c1", messageId: "m1", content: "first" })
    const event2 = makeThreadEvent({ threadId: "t1", channelId: "c1", messageId: "m2", content: "second" })

    const live = makeConversationLayerWithDedup({
      events: [event1, event2],
      tracked: Option.none(),
      resolves: [makeSession("s1")],
      send: (_session, text) => Effect.succeed(`echo:${text}`),
      rehydrate: (_threadId, latest) => Effect.succeed(`rehydrated:${latest}`),
      actions,
      prompts,
      dedup: dedup.service,
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
