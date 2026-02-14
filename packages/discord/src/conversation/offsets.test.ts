import { describe, expect } from "bun:test"
import { Duration, Effect, Layer, Option, Redacted } from "effect"
import { AppConfig } from "../config"
import { SqliteDb } from "../db/client"
import { effectTest, withTempSqliteFile } from "../test/effect"
import { OffsetStore } from "./offsets"

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

const withOffsets = <A, E, R>(
  run: (offsets: OffsetStore.Service) => Effect.Effect<A, E, R>,
) =>
  withTempSqliteFile((databasePath) =>
    Effect.gen(function* () {
      const config = Layer.succeed(AppConfig, makeConfig(databasePath))
      const sqlite = SqliteDb.layer.pipe(Layer.provide(config))
      const deps = Layer.merge(sqlite, config)
      const live = OffsetStore.layer.pipe(Layer.provide(deps))
      const program = Effect.flatMap(OffsetStore, (offsets) => run(offsets))
      return yield* program.pipe(Effect.provide(live))
    }),
    "discord-offsets-",
  )

describe("OffsetStore", () => {
  effectTest("stores and updates source offsets", () =>
    withOffsets((offsets) =>
      Effect.gen(function* () {
        expect(Option.isNone(yield* offsets.getOffset("thread:t1"))).toBe(true)
        yield* offsets.setOffset("thread:t1", "m1")
        expect(yield* offsets.getOffset("thread:t1")).toEqual(Option.some("m1"))
        yield* offsets.setOffset("thread:t1", "m9")
        expect(yield* offsets.getOffset("thread:t1")).toEqual(Option.some("m9"))
      }),
    ),
  )

  effectTest("noop offsets always return none", () =>
    Effect.gen(function* () {
      const offsets = yield* OffsetStore
      expect(Option.isNone(yield* offsets.getOffset("thread:t1"))).toBe(true)
      yield* offsets.setOffset("thread:t1", "m1")
      expect(Option.isNone(yield* offsets.getOffset("thread:t1"))).toBe(true)
    }).pipe(Effect.provide(OffsetStore.noop)),
  )
})
