import { Daytona as DaytonaSDK, Image } from "@daytonaio/sdk"
import { Context, Effect, Layer, Redacted, Schema } from "effect"
import { AppConfig } from "../../config"
import { SandboxCreateError, SandboxExecError, SandboxNotFoundError, SandboxStartError } from "../../errors"
import { GuildId, SandboxId, ThreadId, PreviewAccess } from "../../types"

export class SandboxHandle extends Schema.Class<SandboxHandle>("SandboxHandle")({
  id: SandboxId,
  previewUrl: Schema.String,
  previewToken: Schema.Union(Schema.Null, Schema.String),
}) {}

export class ExecResult extends Schema.Class<ExecResult>("ExecResult")({
  exitCode: Schema.Number,
  output: Schema.String,
}) {}

export declare namespace DaytonaService {
  export interface Service {
    readonly create: (opts: {
      threadId: ThreadId
      guildId: GuildId
      timeout: number
    }) => Effect.Effect<SandboxHandle, SandboxCreateError>
    readonly exec: (
      sandboxId: SandboxId,
      label: string,
      command: string,
      opts?: { cwd?: string; env?: Record<string, string> },
    ) => Effect.Effect<ExecResult, SandboxExecError | SandboxNotFoundError>
    readonly start: (
      sandboxId: SandboxId,
      timeout: number,
    ) => Effect.Effect<SandboxHandle, SandboxStartError | SandboxNotFoundError>
    readonly stop: (sandboxId: SandboxId) => Effect.Effect<void, SandboxNotFoundError>
    readonly destroy: (sandboxId: SandboxId) => Effect.Effect<void>
    readonly getPreview: (sandboxId: SandboxId) => Effect.Effect<PreviewAccess, SandboxNotFoundError>
  }
}

export const discordBotImage = Image.base("node:22-bookworm-slim")
  .runCommands(
    "apt-get update && apt-get install -y git curl && rm -rf /var/lib/apt/lists/*",
    "curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/githubcli-archive-keyring.gpg && echo \"deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main\" > /etc/apt/sources.list.d/github-cli.list && apt-get update && apt-get install -y gh && rm -rf /var/lib/apt/lists/*",
    "npm install -g opencode-ai@latest bun",
  )
  .workdir("/home/daytona")

export class DaytonaService extends Context.Tag("@discord/DaytonaService")<DaytonaService, DaytonaService.Service>() {
  static readonly layer = Layer.effect(
    DaytonaService,
    Effect.gen(function* () {
      const config = yield* AppConfig
      const sdk = new DaytonaSDK({
        apiKey: Redacted.value(config.daytonaApiKey),
        _experimental: {},
      })

      const getSandbox = (sandboxId: SandboxId) =>
        Effect.tryPromise({
          try: () => sdk.get(sandboxId),
          catch: () => new SandboxNotFoundError({ sandboxId }),
        })

      const toHandle = <E>(
        sandboxId: SandboxId,
        sandbox: { getPreviewLink: (timeout: number) => Promise<{ url: string; token?: string | null }> },
        error: (cause: unknown) => E,
      ) =>
        Effect.tryPromise({
          try: () => sandbox.getPreviewLink(4096),
          catch: error,
        }).pipe(
          Effect.map((preview) =>
            SandboxHandle.make({
              id: sandboxId,
              previewUrl: preview.url.replace(/\/$/, ""),
              previewToken: preview.token ?? null,
            }),
          ),
        )

      const create = Effect.fn("DaytonaService.create")(
        function* (opts: { threadId: ThreadId; guildId: GuildId; timeout: number }) {
          const base = {
            labels: { app: "opencord", threadId: opts.threadId, guildId: opts.guildId },
            autoStopInterval: 0,
            autoArchiveInterval: 0,
          }
          const snapshot = config.daytonaSnapshot.trim()
          const sandbox = yield* Effect.tryPromise({
            try: () =>
              snapshot.length > 0
                ? sdk.create(
                    {
                      ...base,
                      snapshot,
                    },
                    { timeout: opts.timeout },
                  )
                : sdk.create(
                    {
                      ...base,
                      image: discordBotImage,
                    },
                    { timeout: opts.timeout },
                  ),
            catch: (cause) => new SandboxCreateError({ cause }),
          })
          const sandboxId = SandboxId.make(sandbox.id)
          return yield* toHandle(
            sandboxId,
            sandbox,
            (cause) => new SandboxCreateError({ sandboxId, cause }),
          )
        },
      )

      const exec = Effect.fn("DaytonaService.exec")(
        function* (
          sandboxId: SandboxId,
          label: string,
          command: string,
          opts?: { cwd?: string; env?: Record<string, string> },
        ) {
          const sandbox = yield* getSandbox(sandboxId)
          const result = yield* Effect.tryPromise({
            try: () => sandbox.process.executeCommand(command, opts?.cwd, opts?.env),
            catch: () => new SandboxExecError({ sandboxId, label, exitCode: -1, output: "exec failed" }),
          })
          if (result.exitCode !== 0) {
            return yield* new SandboxExecError({
              sandboxId,
              label,
              exitCode: result.exitCode,
              output: result.result.slice(0, 500),
            })
          }
          return ExecResult.make({
            exitCode: result.exitCode,
            output: result.result.trim(),
          })
        },
      )

      const start = Effect.fn("DaytonaService.start")(function* (sandboxId: SandboxId, timeout: number) {
        const sandbox = yield* getSandbox(sandboxId)
        yield* Effect.tryPromise({
          try: () => sdk.start(sandbox, timeout),
          catch: (cause) => new SandboxStartError({ sandboxId, cause }),
        })
        return yield* toHandle(sandboxId, sandbox, (cause) => new SandboxStartError({ sandboxId, cause }))
      })

      const stop = Effect.fn("DaytonaService.stop")(function* (sandboxId: SandboxId) {
        const sandbox = yield* getSandbox(sandboxId)
        yield* Effect.tryPromise({
          try: () => sdk.stop(sandbox),
          catch: () => new SandboxNotFoundError({ sandboxId }),
        })
      })

      const destroy = Effect.fn("DaytonaService.destroy")(function* (sandboxId: SandboxId) {
        yield* Effect.tryPromise({
          try: async () => {
            const sandbox = await sdk.get(sandboxId)
            await sdk.delete(sandbox)
          },
          catch: () => undefined,
        }).pipe(Effect.ignore)
      })

      const getPreview = Effect.fn("DaytonaService.getPreview")(function* (sandboxId: SandboxId) {
        const sandbox = yield* getSandbox(sandboxId)
        const handle = yield* toHandle(sandboxId, sandbox, () => new SandboxNotFoundError({ sandboxId }))
        return PreviewAccess.from(handle)
      })

      return DaytonaService.of({ create, exec, start, stop, destroy, getPreview })
    }),
  )
}
