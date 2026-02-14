import { Config, Context, Duration, Effect, Layer, Redacted, Schema } from "effect"

const TurnRoutingMode = Schema.Literal("off", "heuristic", "ai")
type TurnRoutingMode = typeof TurnRoutingMode.Type

const SandboxReusePolicy = Schema.Literal("resume_preferred", "recreate")
type SandboxReusePolicy = typeof SandboxReusePolicy.Type

const LogLevel = Schema.Literal("debug", "info", "warn", "error")
type LogLevel = typeof LogLevel.Type

const Port = Schema.NumberFromString.pipe(
  Schema.int(),
  Schema.between(1, 65535),
)

export const Minutes = Schema.NumberFromString.pipe(
  Schema.int(),
  Schema.positive(),
  Schema.brand("Minutes"),
)
export type Minutes = typeof Minutes.Type

export const Milliseconds = Schema.NumberFromString.pipe(
  Schema.int(),
  Schema.positive(),
  Schema.brand("Milliseconds"),
)
export type Milliseconds = typeof Milliseconds.Type

export const Seconds = Schema.NumberFromString.pipe(
  Schema.int(),
  Schema.positive(),
  Schema.brand("Seconds"),
)
export type Seconds = typeof Seconds.Type

const CommaSeparatedList = Schema.transform(
  Schema.String,
  Schema.Array(Schema.String),
  {
    decode: (s) =>
      s
        .split(",")
        .map((id) => id.trim())
        .filter((id) => id.length > 0),
    encode: (a) => a.join(","),
  },
)

export declare namespace AppConfig {
  export interface Service {
    readonly discordToken: Redacted.Redacted
    readonly allowedChannelIds: ReadonlyArray<string>
    readonly discordCategoryId: string
    readonly discordRoleId: string
    readonly discordRequiredRoleId: string
    readonly discordCommandGuildId: string
    readonly databasePath: string
    readonly daytonaApiKey: Redacted.Redacted
    readonly daytonaSnapshot: string
    readonly openCodeZenApiKey: Redacted.Redacted
    readonly githubToken: string
    readonly logLevel: LogLevel
    readonly healthHost: string
    readonly healthPort: number
    readonly turnRoutingMode: TurnRoutingMode
    readonly turnRoutingModel: string
    readonly sandboxReusePolicy: SandboxReusePolicy
    readonly sandboxTimeout: Duration.Duration
    readonly cleanupInterval: Duration.Duration
    readonly staleActiveGraceMinutes: Minutes
    readonly pausedTtlMinutes: Minutes
    readonly activeHealthCheckTimeoutMs: Milliseconds
    readonly startupHealthTimeoutMs: Milliseconds
    readonly resumeHealthTimeoutMs: Milliseconds
    readonly sandboxCreationTimeout: Seconds
    readonly openCodeModel: string
  }
}

export class AppConfig extends Context.Tag("@discord/AppConfig")<AppConfig, AppConfig.Service>() {
  static readonly layer = Layer.effect(
    AppConfig,
    Effect.gen(function* () {
      const discordToken = yield* Config.redacted("DISCORD_TOKEN")
      const allowedChannelIds = yield* Schema.Config("ALLOWED_CHANNEL_IDS", CommaSeparatedList).pipe(
        Config.orElse(() => Config.succeed([] as ReadonlyArray<string>)),
      )
      const discordCategoryId = yield* Config.string("DISCORD_CATEGORY_ID").pipe(
        Config.withDefault(""),
      )
      const discordRoleId = yield* Config.string("DISCORD_ROLE_ID").pipe(
        Config.withDefault(""),
      )
      const discordRequiredRoleId = yield* Config.string("DISCORD_REQUIRED_ROLE_ID").pipe(
        Config.withDefault(""),
      )
      const discordCommandGuildId = yield* Config.string("DISCORD_COMMAND_GUILD_ID").pipe(
        Config.withDefault(""),
      )
      const databasePath = yield* Config.string("DATABASE_PATH").pipe(
        Config.withDefault("discord.sqlite"),
      )
      const daytonaApiKey = yield* Config.redacted("DAYTONA_API_KEY")
      const daytonaSnapshot = yield* Config.string("DAYTONA_SNAPSHOT").pipe(
        Config.withDefault(""),
      )
      const openCodeZenApiKey = yield* Config.redacted("OPENCODE_ZEN_API_KEY")
      const githubToken = yield* Config.string("GITHUB_TOKEN").pipe(
        Config.withDefault(""),
      )
      const logLevel = yield* Schema.Config("LOG_LEVEL", LogLevel).pipe(
        Config.orElse(() => Config.succeed("info" as const)),
      )
      const healthHost = yield* Config.string("HEALTH_HOST").pipe(
        Config.withDefault("0.0.0.0"),
      )
      const healthPort = yield* Schema.Config("HEALTH_PORT", Port).pipe(
        Config.orElse(() => Config.succeed(8787)),
      )
      const turnRoutingMode = yield* Schema.Config("TURN_ROUTING_MODE", TurnRoutingMode).pipe(
        Config.orElse(() => Config.succeed("ai" as const)),
      )
      const turnRoutingModel = yield* Config.string("TURN_ROUTING_MODEL").pipe(
        Config.withDefault("claude-haiku-4-5"),
      )
      const sandboxReusePolicy = yield* Schema.Config("SANDBOX_REUSE_POLICY", SandboxReusePolicy).pipe(
        Config.orElse(() => Config.succeed("resume_preferred" as const)),
      )
      const sandboxTimeout = yield* Config.duration("SANDBOX_TIMEOUT").pipe(
        Config.orElse(() =>
          Schema.Config("SANDBOX_TIMEOUT_MINUTES", Minutes).pipe(
            Config.map((n) => Duration.minutes(n)),
          ),
        ),
        Config.withDefault(Duration.minutes(30)),
      )
      const cleanupInterval = yield* Config.duration("SANDBOX_CLEANUP_INTERVAL").pipe(
        Config.withDefault(Duration.minutes(5)),
      )
      const staleActiveGraceMinutes = yield* Schema.Config("STALE_ACTIVE_GRACE_MINUTES", Minutes).pipe(
        Config.orElse(() => Config.succeed(Minutes.make(5))),
      )
      const pausedTtlMinutes = yield* Schema.Config("PAUSED_TTL_MINUTES", Minutes).pipe(
        Config.orElse(() => Config.succeed(Minutes.make(180))),
      )
      const activeHealthCheckTimeoutMs = yield* Schema.Config("ACTIVE_HEALTH_CHECK_TIMEOUT_MS", Milliseconds).pipe(
        Config.orElse(() => Config.succeed(Milliseconds.make(15000))),
      )
      const startupHealthTimeoutMs = yield* Schema.Config("STARTUP_HEALTH_TIMEOUT_MS", Milliseconds).pipe(
        Config.orElse(() => Config.succeed(Milliseconds.make(120000))),
      )
      const resumeHealthTimeoutMs = yield* Schema.Config("RESUME_HEALTH_TIMEOUT_MS", Milliseconds).pipe(
        Config.orElse(() => Config.succeed(Milliseconds.make(120000))),
      )
      const sandboxCreationTimeout = yield* Schema.Config("SANDBOX_CREATION_TIMEOUT", Seconds).pipe(
        Config.orElse(() => Config.succeed(Seconds.make(180))),
      )
      const openCodeModel = yield* Config.string("OPENCODE_MODEL").pipe(
        Config.withDefault("opencode/claude-sonnet-4-5"),
      )

      return AppConfig.of({
        discordToken,
        allowedChannelIds,
        discordCategoryId,
        discordRoleId,
        discordRequiredRoleId,
        discordCommandGuildId,
        databasePath,
        daytonaApiKey,
        daytonaSnapshot,
        openCodeZenApiKey,
        githubToken,
        logLevel,
        healthHost,
        healthPort,
        turnRoutingMode,
        turnRoutingModel,
        sandboxReusePolicy,
        sandboxTimeout,
        cleanupInterval,
        staleActiveGraceMinutes,
        pausedTtlMinutes,
        activeHealthCheckTimeoutMs,
        startupHealthTimeoutMs,
        resumeHealthTimeoutMs,
        sandboxCreationTimeout,
        openCodeModel,
      })
    }),
  ).pipe(Layer.orDie)
}
