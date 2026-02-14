import { describe, expect } from "bun:test"
import { Deferred, Effect, Layer, Option } from "effect"
import { ThreadChatCluster, ThreadChatError } from "../conversation/thread/cluster"
import { TurnRouter, TurnRoutingDecision } from "../discord/turn-routing"
import { effectTest, testConfigLayer } from "../test/effect"
import { ChannelId, GuildId, SandboxId, SessionId, SessionInfo, ThreadId } from "../types"
import { Conversation } from "../conversation/conversation"
import { IngressDedup } from "../conversation/dedup"
import { makeTui } from "./local-adapter"

const makeSession = (id: string) =>
  SessionInfo.make({
    threadId: ThreadId.make("thread-local-channel"),
    channelId: ChannelId.make("local-channel"),
    guildId: GuildId.make("local"),
    sandboxId: SandboxId.make("sb1"),
    sessionId: SessionId.make(id),
    previewUrl: "https://preview",
    previewToken: null,
    status: "active",
    lastError: null,
    resumeFailCount: 0,
  })

const routerLayer = Layer.succeed(
  TurnRouter,
  TurnRouter.of({
    shouldRespond: () =>
      Effect.succeed(TurnRoutingDecision.make({ shouldRespond: true, reason: "test" })),
    generateThreadName: () => Effect.succeed("unused"),
  }),
)

const makeThreadChatLayer = (opts: {
  send?: (prompt: string) => string
  seen?: Array<string>
  gate?: Deferred.Deferred<void>
}) => {
  const session = makeSession("s1")
  const seen = opts.seen ?? []
  return Layer.succeed(ThreadChatCluster, ThreadChatCluster.of({
    send: (input) =>
      Effect.gen(function* () {
        if (opts.gate) yield* Deferred.await(opts.gate)
        seen.push(input.text)
        return {
          text: opts.send ? opts.send(input.text) : `local:${input.text}`,
          session,
          changedSession: false,
        }
      }).pipe(
        Effect.mapError((cause) =>
          ThreadChatError.make({
            threadId: input.threadId,
            cause,
            retriable: false,
          })),
      ),
    status: () => Effect.succeed(Option.some(session)),
    recreate: () => Effect.void,
  }))
}

describe("makeTui", () => {
  effectTest("drives conversation locally without Discord", () =>
    Effect.gen(function* () {
      const seen: Array<string> = []
      const tui = yield* makeTui
      const threadChatLayer = makeThreadChatLayer({ seen })

      const live = Conversation.layer.pipe(
        Layer.provideMerge(tui.layer),
        Layer.provideMerge(IngressDedup.noop),
        Layer.provideMerge(routerLayer),
        Layer.provideMerge(threadChatLayer),
        Layer.provideMerge(testConfigLayer),
      )

      yield* Effect.gen(function* () {
        const conversation = yield* Conversation
        yield* Effect.forkScoped(conversation.run)

        yield* tui.send("hello local")

        const first = yield* tui.take
        const second = yield* tui.take

        expect(seen).toEqual(["hello local"])
        expect(first.kind).toBe("typing")
        expect(second.kind).toBe("send")
        expect(/^thread-[a-z]+-[a-z]+-\d+$/.test(String(second.threadId))).toBe(true)
        if (second.kind === "send") expect(second.text).toBe("local:hello local")
      }).pipe(Effect.provide(live))
    }),
  )

  effectTest("publishes typing before session resolution completes", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>()
      const tui = yield* makeTui
      const threadChatLayer = makeThreadChatLayer({ gate })

      const live = Conversation.layer.pipe(
        Layer.provideMerge(tui.layer),
        Layer.provideMerge(IngressDedup.noop),
        Layer.provideMerge(routerLayer),
        Layer.provideMerge(threadChatLayer),
        Layer.provideMerge(testConfigLayer),
      )

      yield* Effect.gen(function* () {
        const conversation = yield* Conversation
        yield* Effect.forkScoped(conversation.run)

        yield* tui.send("hello local")
        const first = yield* tui.take
        expect(first.kind).toBe("typing")

        yield* Deferred.succeed(gate, undefined)
        const second = yield* tui.take
        expect(second.kind).toBe("send")
      }).pipe(Effect.provide(live))
    }),
  )

  effectTest("channel messages create distinct threads", () =>
    Effect.gen(function* () {
      const tui = yield* makeTui
      const threadChatLayer = makeThreadChatLayer({})

      const live = Conversation.layer.pipe(
        Layer.provideMerge(tui.layer),
        Layer.provideMerge(IngressDedup.noop),
        Layer.provideMerge(routerLayer),
        Layer.provideMerge(threadChatLayer),
        Layer.provideMerge(testConfigLayer),
      )

      yield* Effect.gen(function* () {
        const conversation = yield* Conversation
        yield* Effect.forkScoped(conversation.run)

        yield* tui.send("one")
        const firstTyping = yield* tui.take
        const firstSend = yield* tui.take

        yield* tui.send("two")
        const secondTyping = yield* tui.take
        const secondSend = yield* tui.take

        expect(firstTyping.kind).toBe("typing")
        expect(firstSend.kind).toBe("send")
        expect(secondTyping.kind).toBe("typing")
        expect(secondSend.kind).toBe("send")
        if (firstTyping.kind === "typing" && secondTyping.kind === "typing") {
          expect(firstTyping.threadId === secondTyping.threadId).toBe(false)
        }
      }).pipe(Effect.provide(live))
    }),
  )
})
