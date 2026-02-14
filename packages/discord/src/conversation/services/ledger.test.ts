import { describe, expect } from "bun:test"
import { Duration, Effect, Layer, Option, Redacted } from "effect"
import { AppConfig } from "../../config"
import { SqliteDb } from "../../db/client"
import { effectTest, withTempSqliteFile } from "../../test/effect"
import { ConversationLedger } from "./ledger"

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

const withLedger = <A, E, R>(
  run: (ledger: ConversationLedger.Service) => Effect.Effect<A, E, R>,
) =>
  withTempSqliteFile((databasePath) =>
    Effect.gen(function* () {
      const config = Layer.succeed(AppConfig, makeConfig(databasePath))
      const sqlite = SqliteDb.layer.pipe(Layer.provide(config))
      const deps = Layer.merge(sqlite, config)
      const live = ConversationLedger.layer.pipe(Layer.provide(deps))
      const program = Effect.flatMap(ConversationLedger, (ledger) => run(ledger))
      return yield* program.pipe(Effect.provide(live))
    }),
    "discord-ledger-",
  )

describe("ConversationLedger", () => {
  effectTest("dedup returns true first time, false second time", () =>
    Effect.gen(function* () {
      const ledger = yield* ConversationLedger
      expect(yield* ledger.dedup("m1")).toBe(true)
      expect(yield* ledger.dedup("m1")).toBe(false)
      expect(yield* ledger.dedup("m2")).toBe(true)
      expect(yield* ledger.dedup("m2")).toBe(false)
    }).pipe(Effect.provide(ConversationLedger.noop)),
  )

  effectTest("stores and updates source offsets", () =>
    withLedger((ledger) =>
      Effect.gen(function* () {
        expect(Option.isNone(yield* ledger.getOffset("thread:t1"))).toBe(true)
        yield* ledger.setOffset("thread:t1", "m1")
        expect(yield* ledger.getOffset("thread:t1")).toEqual(Option.some("m1"))
        yield* ledger.setOffset("thread:t1", "m9")
        expect(yield* ledger.getOffset("thread:t1")).toEqual(Option.some("m9"))
      }),
    ),
  )

  effectTest("dedup works in layer mode", () =>
    withLedger((ledger) =>
      Effect.gen(function* () {
        expect(yield* ledger.dedup("m1")).toBe(true)
        expect(yield* ledger.dedup("m1")).toBe(false)
        expect(yield* ledger.dedup("m2")).toBe(true)
      }),
    ),
  )

  effectTest("noop offsets always return none", () =>
    Effect.gen(function* () {
      const ledger = yield* ConversationLedger
      expect(Option.isNone(yield* ledger.getOffset("thread:t1"))).toBe(true)
      yield* ledger.setOffset("thread:t1", "m1")
      expect(Option.isNone(yield* ledger.getOffset("thread:t1"))).toBe(true)
    }).pipe(Effect.provide(ConversationLedger.noop)),
  )
})
