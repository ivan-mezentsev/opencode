import { describe, expect } from "bun:test"
import { TestRunner } from "@effect/cluster"
import { Effect, Layer, Option } from "effect"
import { History } from "../../history"
import { ThreadChatCluster, ThreadChatClusterLive, ThreadEntityLive } from "."
import { OpenCodeClient, OpenCodeSessionSummary } from "../../../sandbox/opencode/client"
import { SandboxProvisioner } from "../../../sandbox/provisioner"
import { SessionStore } from "../../../session/store"
import { ChannelId, GuildId, PreviewAccess, SandboxId, SessionId, SessionInfo, ThreadId } from "../../../types"
import { DaytonaService } from "../../../sandbox/daytona/service"
import { OpenCodeClientError } from "../../../errors"
import { SqliteDb } from "../../../db/client"
import { effectTest, testConfigLayer } from "../../../test/effect"

const makeSession = (input: { threadId: ThreadId; channelId: ChannelId; guildId: GuildId; sandboxId: string; sessionId: string }) =>
  SessionInfo.make({
    threadId: input.threadId,
    channelId: input.channelId,
    guildId: input.guildId,
    sandboxId: SandboxId.make(input.sandboxId),
    sessionId: SessionId.make(input.sessionId),
    previewUrl: "https://preview",
    previewToken: null,
    status: "active",
    lastError: null,
    resumeFailCount: 0,
  })

describe("ThreadEntity", () => {
  effectTest("retries after sandbox-down by re-ensuring session and rehydrating prompt", () => {
    const threadId = ThreadId.make("t-dead")
    const channelId = ChannelId.make("c-dead")
    const guildId = GuildId.make("g-dead")
    const first = makeSession({ threadId, channelId, guildId, sandboxId: "sb-1", sessionId: "s-1" })
    const second = makeSession({ threadId, channelId, guildId, sandboxId: "sb-2", sessionId: "s-2" })

    const ensured: Array<string> = []
    const recovered: Array<string> = []
    const sent: Array<string> = []
    const rehydrated: Array<string> = []

    const historyLayer = Layer.succeed(
      History,
      History.of({
        rehydrate: (_threadId, latest) =>
          Effect.sync(() => {
            rehydrated.push(latest)
            return `rehydrated:${latest}`
          }),
      }),
    )

    const provisionerLayer = Layer.succeed(
      SandboxProvisioner,
      SandboxProvisioner.of({
        provision: () => Effect.dieMessage("unused"),
        resume: () => Effect.dieMessage("unused"),
        ensureActive: (input) =>
          Effect.sync(() => {
            ensured.push(Option.isSome(input.current) ? String(input.current.value.sessionId) : "none")
            return ensured.length === 1 ? first : second
          }),
        ensureHealthy: () => Effect.succeed(true),
        recoverSendFailure: (_threadId, session) =>
          Effect.sync(() => {
            recovered.push(String(session.sessionId))
            return SessionInfo.make({
              ...session,
              status: "error",
              lastError: "send-failed",
            })
          }),
        pause: (_threadId, session) => Effect.succeed(session),
        destroy: (_threadId, session) => Effect.succeed(session),
      }),
    )

    const openCodeLayer = Layer.succeed(
      OpenCodeClient,
      OpenCodeClient.of({
        waitForHealthy: () => Effect.succeed(true),
        createSession: () => Effect.succeed(SessionId.make("unused")),
        sessionExists: () => Effect.succeed(true),
        listSessions: () => Effect.succeed([] as ReadonlyArray<OpenCodeSessionSummary>),
        sendPrompt: (_preview, _sessionId, text) =>
          Effect.gen(function* () {
            sent.push(text)
            if (sent.length === 1) {
              return yield* OpenCodeClientError.make({
                operation: "sendPrompt",
                statusCode: 502,
                body: "bad gateway",
                kind: "sandbox-down",
              })
            }
            return `ok:${text}`
          }),
        abortSession: () => Effect.void,
      }),
    )

    const daytonaLayer = Layer.succeed(
      DaytonaService,
      DaytonaService.of({
        create: () => Effect.dieMessage("unused"),
        exec: () => Effect.dieMessage("unused"),
        start: () => Effect.dieMessage("unused"),
        stop: () => Effect.dieMessage("unused"),
        destroy: () => Effect.void,
        getPreview: () =>
          Effect.succeed(
            PreviewAccess.make({
              previewUrl: "https://preview",
              previewToken: null,
            }),
          ),
      }),
    )

    const live = ThreadChatClusterLive.pipe(
      Layer.provideMerge(ThreadEntityLive),
      Layer.provideMerge(TestRunner.layer),
      Layer.provideMerge(SessionStore.layer),
      Layer.provideMerge(SqliteDb.layer),
      Layer.provideMerge(testConfigLayer),
      Layer.provideMerge(daytonaLayer),
      Layer.provideMerge(openCodeLayer),
      Layer.provideMerge(provisionerLayer),
      Layer.provideMerge(historyLayer),
    )

    return Effect.gen(function* () {
      const threadChat = yield* ThreadChatCluster
      const out = yield* threadChat.send({
        threadId,
        channelId,
        guildId,
        messageId: "m-1",
        text: "hello",
      })

      expect(ensured).toEqual(["none", "s-1"])
      expect(recovered).toEqual(["s-1"])
      expect(rehydrated).toEqual(["hello"])
      expect(sent).toEqual(["hello", "rehydrated:hello"])
      expect(out.text).toBe("ok:rehydrated:hello")
      expect(out.session.sessionId).toBe(SessionId.make("s-2"))
    }).pipe(Effect.provide(live))
  })
})
