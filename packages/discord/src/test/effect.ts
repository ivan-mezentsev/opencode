import { Reactivity } from "@effect/experimental"
import * as FileSystem from "@effect/platform/FileSystem"
import { BunFileSystem } from "@effect/platform-bun"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import type * as Client from "@effect/sql/SqlClient"
import { test } from "bun:test"
import { Duration, Effect, Layer, Redacted } from "effect"
import type { Scope } from "effect/Scope"
import type { TestOptions } from "bun:test"
import { AppConfig, Milliseconds, Minutes, Seconds } from "../config"

export const effectTest = (
  name: string,
  run: () => Effect.Effect<unknown, unknown, Scope | never>,
  options?: number | TestOptions,
) =>
  test(name, () => Effect.runPromise(run().pipe(Effect.scoped)), options)

export const withSqlite = <A, E, R>(filename: string, run: (db: Client.SqlClient) => Effect.Effect<A, E, R>) =>
  SqliteClient.make({ filename }).pipe(
    Effect.provide(Reactivity.layer),
    Effect.flatMap(run),
    Effect.scoped,
  )

export const withTempSqliteFile = <A, E, R>(
  run: (filename: string) => Effect.Effect<A, E, R>,
  prefix = "discord-test-",
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const filename = yield* fs.makeTempFileScoped({ prefix, suffix: ".sqlite" })
    return yield* run(filename)
  }).pipe(Effect.provide(BunFileSystem.layer))

export const testConfigLayer = Layer.succeed(
  AppConfig,
  AppConfig.of({
    discordToken: Redacted.make("test"),
    allowedChannelIds: [],
    discordCategoryId: "",
    discordRoleId: "",
    discordRequiredRoleId: "",
    discordCommandGuildId: "",
    databasePath: ":memory:",
    daytonaApiKey: Redacted.make("test"),
    daytonaSnapshot: "",
    openCodeZenApiKey: Redacted.make("test"),
    githubToken: "",
    logLevel: "info" as const,
    healthHost: "0.0.0.0",
    healthPort: 8787,
    turnRoutingMode: "off" as const,
    turnRoutingModel: "test",
    sandboxReusePolicy: "resume_preferred" as const,
    sandboxTimeout: Duration.minutes(30),
    cleanupInterval: Duration.minutes(5),
    staleActiveGraceMinutes: Minutes.make(5),
    pausedTtlMinutes: Minutes.make(180),
    activeHealthCheckTimeoutMs: Milliseconds.make(15000),
    startupHealthTimeoutMs: Milliseconds.make(120000),
    resumeHealthTimeoutMs: Milliseconds.make(120000),
    sandboxCreationTimeout: Seconds.make(180),
    openCodeModel: "opencode/claude-sonnet-4-5",
  }),
)
