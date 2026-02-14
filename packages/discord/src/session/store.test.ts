import type * as Client from "@effect/sql/SqlClient"
import { describe, expect } from "bun:test"
import { Duration, Effect, Layer, Option, Redacted } from "effect"
import { AppConfig } from "../config"
import { SqliteDb } from "../db/client"
import { effectTest, withTempSqliteFile } from "../test/effect"
import { ChannelId, GuildId, SandboxId, SessionId, SessionInfo, ThreadId } from "../types"
import { SessionStore } from "./store"

const makeConfig = (databasePath: string) =>
  AppConfig.of({
    discordToken: Redacted.make("token"),
    allowedChannelIds: [],
    discordCategoryId: "",
    discordRoleId: "",
    discordRequiredRoleId: "",
    discordCommandGuildId: "",
    databasePath,
    daytonaApiKey: Redacted.make("daytona"),
    daytonaSnapshot: "",
    openCodeZenApiKey: Redacted.make("zen"),
    githubToken: "",
    logLevel: "info",
    healthHost: "127.0.0.1",
    healthPort: 8787,
    turnRoutingMode: "off",
    turnRoutingModel: "claude-haiku-4-5",
    sandboxReusePolicy: "resume_preferred",
    sandboxTimeout: Duration.minutes(30),
    cleanupInterval: Duration.minutes(5),
    staleActiveGraceMinutes: 5 as AppConfig.Service["staleActiveGraceMinutes"],
    pausedTtlMinutes: 180 as AppConfig.Service["pausedTtlMinutes"],
    activeHealthCheckTimeoutMs: 15000 as AppConfig.Service["activeHealthCheckTimeoutMs"],
    startupHealthTimeoutMs: 120000 as AppConfig.Service["startupHealthTimeoutMs"],
    resumeHealthTimeoutMs: 120000 as AppConfig.Service["resumeHealthTimeoutMs"],
    sandboxCreationTimeout: 180 as AppConfig.Service["sandboxCreationTimeout"],
    openCodeModel: "opencode/claude-sonnet-4-5",
  })

const makeSession = (threadId: string, status: "creating" | "active" | "paused" = "active") =>
  SessionInfo.make({
    threadId: ThreadId.make(threadId),
    channelId: ChannelId.make("c1"),
    guildId: GuildId.make("g1"),
    sandboxId: SandboxId.make("sb1"),
    sessionId: SessionId.make(`s-${threadId}`),
    previewUrl: `https://preview/${threadId}`,
    previewToken: null,
    status,
    lastError: null,
    resumeFailCount: 0,
  })

const withStore = <A, E, R>(run: (store: SessionStore.Service, sql: Client.SqlClient) => Effect.Effect<A, E, R>) =>
  withTempSqliteFile((databasePath) =>
    Effect.gen(function* () {
      const config = Layer.succeed(AppConfig, makeConfig(databasePath))
      const sqlite = SqliteDb.layer.pipe(
        Layer.provide(config),
      )
      const live = Layer.merge(
        SessionStore.layer.pipe(
          Layer.provide(sqlite),
        ),
        sqlite,
      )

      const program = Effect.all([SessionStore, SqliteDb]).pipe(
        Effect.flatMap(([store, sql]) => run(store, sql)),
      )
      return yield* program.pipe(Effect.provide(live))
    }),
    "discord-store-",
  )

const getTransitions = (sql: Client.SqlClient, threadId: ThreadId) =>
  sql<{
    pause_requested_at: string | null
    paused_at: string | null
    resume_attempted_at: string | null
    resumed_at: string | null
    destroyed_at: string | null
  }>`SELECT pause_requested_at, paused_at, resume_attempted_at, resumed_at, destroyed_at
      FROM discord_sessions
      WHERE thread_id = ${threadId}
      LIMIT 1`.pipe(
    Effect.map((rows) => rows[0] ?? null),
  )

describe("SessionStore", () => {
  effectTest("runs typed CRUD flow against sqlite", () =>
    withStore((store, sql) =>
      Effect.gen(function* () {
        const t1 = ThreadId.make("t1")
        const t2 = ThreadId.make("t2")

        yield* store.upsert(makeSession("t1", "active"))
        expect(yield* store.hasTrackedThread(t1)).toBe(true)
        expect(Option.map(yield* store.getByThread(t1), (s) => s.threadId)).toEqual(Option.some(t1))
        expect(Option.map(yield* store.getActive(t1), (s) => s.status)).toEqual(Option.some("active"))

        yield* store.updateStatus(t1, "paused", "pause")
        yield* store.incrementResumeFailure(t1, "resume-fail")
        expect(Option.isNone(yield* store.getActive(t1))).toBe(true)
        expect(Option.map(yield* store.getByThread(t1), (s) => s.resumeFailCount)).toEqual(Option.some(1))
        expect(Option.map(yield* store.getByThread(t1), (s) => s.lastError)).toEqual(Option.some("resume-fail"))

        yield* store.updateStatus(t1, "active")
        yield* sql`UPDATE discord_sessions
            SET last_activity = datetime('now', '-40 minutes')
            WHERE thread_id = ${t1}`
        expect((yield* store.listStaleActive(30)).map((row) => row.threadId)).toEqual([t1])
        expect((yield* store.listStaleActive(120)).map((row) => row.threadId)).toEqual([])

        yield* store.upsert(makeSession("t2", "creating"))
        yield* store.updateStatus(t2, "paused")
        yield* sql`UPDATE discord_sessions
            SET paused_at = datetime('now', '-40 minutes')
            WHERE thread_id = ${t2}`
        expect((yield* store.listExpiredPaused(30)).map((row) => row.threadId)).toEqual([t2])
        expect((yield* store.listExpiredPaused(120)).map((row) => row.threadId)).toEqual([])
        expect(new Set(yield* store.listTrackedThreads())).toEqual(new Set([t1, t2]))

        yield* store.updateStatus(t2, "destroyed")
        expect(new Set(yield* store.listTrackedThreads())).toEqual(new Set([t1]))

        const next = SessionInfo.make({
          ...makeSession("t1", "active"),
          sessionId: SessionId.make("s-t1-new"),
          previewToken: "ptok",
        })
        yield* store.upsert(next)
        expect(Option.map(yield* store.getByThread(t1), (s) => s.sessionId)).toEqual(Option.some(SessionId.make("s-t1-new")))
        expect(Option.map(yield* store.getByThread(t1), (s) => s.previewToken)).toEqual(Option.some("ptok"))
        expect((yield* store.listActive()).map((row) => row.threadId)).toContain(t1)
      }),
    ),
  )

  effectTest("tracks lifecycle transition timestamps by status", () =>
    withStore((store, sql) =>
      Effect.gen(function* () {
        const t = ThreadId.make("tx")

        yield* store.upsert(makeSession("tx", "creating"))

        yield* store.updateStatus(t, "pausing", "queued")
        const pausing = yield* getTransitions(sql, t)
        expect(pausing).not.toBeNull()
        if (pausing === null) return
        expect(pausing.pause_requested_at).not.toBeNull()
        expect(pausing.paused_at).toBeNull()
        expect(pausing.resume_attempted_at).toBeNull()
        expect(pausing.resumed_at).toBeNull()
        expect(pausing.destroyed_at).toBeNull()

        yield* store.updateStatus(t, "paused")
        const paused = yield* getTransitions(sql, t)
        expect(paused).not.toBeNull()
        if (paused === null) return
        expect(paused.pause_requested_at).not.toBeNull()
        expect(paused.paused_at).not.toBeNull()
        expect(paused.resume_attempted_at).toBeNull()
        expect(paused.resumed_at).toBeNull()
        expect(paused.destroyed_at).toBeNull()

        yield* store.updateStatus(t, "resuming")
        const resuming = yield* getTransitions(sql, t)
        expect(resuming).not.toBeNull()
        if (resuming === null) return
        expect(resuming.pause_requested_at).not.toBeNull()
        expect(resuming.paused_at).not.toBeNull()
        expect(resuming.resume_attempted_at).not.toBeNull()
        expect(resuming.resumed_at).toBeNull()
        expect(resuming.destroyed_at).toBeNull()

        yield* store.updateStatus(t, "active")
        const active = yield* getTransitions(sql, t)
        expect(active).not.toBeNull()
        if (active === null) return
        expect(active.pause_requested_at).not.toBeNull()
        expect(active.paused_at).not.toBeNull()
        expect(active.resume_attempted_at).not.toBeNull()
        expect(active.resumed_at).not.toBeNull()
        expect(active.destroyed_at).toBeNull()

        yield* store.updateStatus(t, "destroyed")
        const destroyed = yield* getTransitions(sql, t)
        expect(destroyed).not.toBeNull()
        if (destroyed === null) return
        expect(destroyed.pause_requested_at).not.toBeNull()
        expect(destroyed.paused_at).not.toBeNull()
        expect(destroyed.resume_attempted_at).not.toBeNull()
        expect(destroyed.resumed_at).not.toBeNull()
        expect(destroyed.destroyed_at).not.toBeNull()
      }),
    ),
  )
})
