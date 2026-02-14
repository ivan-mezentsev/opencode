import agentPrompt from "../agent-prompt.md" with { type: "text" }
import { Context, Effect, Exit, Layer, Option, Redacted, Schema } from "effect"
import { AppConfig } from "../config"
import {
  ConfigEncodeError,
  DatabaseError,
  type HealthCheckError,
  type OpenCodeClientError,
  SandboxCreateError,
  SandboxDeadError,
  type SandboxExecError,
  type SandboxNotFoundError,
  type SandboxStartError,
} from "../errors"
import { SessionStore } from "../session/store"
import { ChannelId, GuildId, PreviewAccess, SandboxId, SessionInfo, ThreadId } from "../types"
import { DaytonaService, type SandboxHandle } from "./daytona/service"
import { OpenCodeClient, OpenCodeSessionSummary } from "./opencode/client"

import { logIgnore } from "../lib/log"

const OpenCodeAuth = Schema.parseJson(
  Schema.Struct({
    opencode: Schema.Struct({
      type: Schema.Literal("api"),
      key: Schema.String,
    }),
  }),
)

const OpenCodeConfig = Schema.parseJson(
  Schema.Struct({
    model: Schema.String,
    share: Schema.String,
    permission: Schema.String,
    agent: Schema.Struct({
      build: Schema.Struct({
        mode: Schema.Literal("primary"),
        prompt: Schema.String,
      }),
    }),
  }),
)

export class Resumed extends Schema.Class<Resumed>("Resumed")({
  session: SessionInfo,
}) {}

export class ResumeFailed extends Schema.Class<ResumeFailed>("ResumeFailed")({
  allowRecreate: Schema.Boolean,
}) {}

export type ResumeResult = Resumed | ResumeFailed

export declare namespace SandboxProvisioner {
  export interface Service {
    /** Creates a brand new sandbox + OpenCode session. */
    readonly provision: (
      threadId: ThreadId,
      channelId: ChannelId,
      guildId: GuildId,
    ) => Effect.Effect<
      SessionInfo,
      | SandboxCreateError
      | SandboxExecError
      | SandboxNotFoundError
      | SandboxStartError
      | HealthCheckError
      | OpenCodeClientError
      | ConfigEncodeError
      | DatabaseError
    >
    /** Attempts to resume an existing sandbox/session. Returns Resumed or Failed. */
    readonly resume: (
      session: SessionInfo,
    ) => Effect.Effect<ResumeResult>
    /** Ensures a thread has an active healthy session, resuming or recreating if needed. */
    readonly ensureActive: (input: {
      threadId: ThreadId
      channelId: ChannelId
      guildId: GuildId
      current: Option.Option<SessionInfo>
    }) => Effect.Effect<
      SessionInfo,
      | SandboxCreateError
      | SandboxExecError
      | SandboxNotFoundError
      | SandboxStartError
      | HealthCheckError
      | OpenCodeClientError
      | ConfigEncodeError
      | SandboxDeadError
      | DatabaseError
    >
    /** Verifies active session health and attachment before reusing it. */
    readonly ensureHealthy: (
      session: SessionInfo,
      maxWaitMs: number,
    ) => Effect.Effect<boolean, HealthCheckError>
    /** Applies session-state recovery policy after a send failure. */
    readonly recoverSendFailure: (
      threadId: ThreadId,
      session: SessionInfo,
      error: OpenCodeClientError,
    ) => Effect.Effect<SessionInfo, DatabaseError>
    /** Pauses a session by stopping its sandbox. */
    readonly pause: (
      threadId: ThreadId,
      session: SessionInfo,
      reason: string,
    ) => Effect.Effect<SessionInfo, DatabaseError>
    /** Destroys a session by destroying its sandbox. */
    readonly destroy: (
      threadId: ThreadId,
      session: SessionInfo,
      reason?: string,
    ) => Effect.Effect<SessionInfo, DatabaseError>
  }
}

export class SandboxProvisioner extends Context.Tag("@discord/SandboxProvisioner")<
  SandboxProvisioner,
  SandboxProvisioner.Service
>() {
  static readonly layer = Layer.effect(
    SandboxProvisioner,
    Effect.gen(function* () {
      const config = yield* AppConfig
      const daytonaService = yield* DaytonaService
      const oc = yield* OpenCodeClient
      const store = yield* SessionStore

      /** Best-effort read of the OpenCode startup log from inside a sandbox. */
      const readStartupLog = (sandboxId: SandboxId, lines = 100) =>
        daytonaService.exec(sandboxId, "read-opencode-log", `cat /tmp/opencode.log 2>/dev/null | tail -${lines}`).pipe(
          Effect.map((r) => r.output),
          Effect.catchAll(() => Effect.succeed("(unable to read log)")),
        )

      /** Locate the existing OpenCode session or create a fresh one for a thread. */
      const findOrCreateSessionId = Effect.fnUntraced(function* (preview: PreviewAccess, session: SessionInfo) {
        const exists = yield* oc
          .sessionExists(preview, session.sessionId)
          .pipe(Effect.catchAll(() => Effect.succeed(false)))
        if (exists) return session.sessionId

        const title = `Discord thread ${session.threadId}`
        const sessions = yield* oc
          .listSessions(preview, 50)
          .pipe(Effect.catchAll(() => Effect.succeed([] as ReadonlyArray<OpenCodeSessionSummary>)))
        const match = [...sessions]
          .filter((c) => c.title === title)
          .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0]

        return match ? match.id : yield* oc.createSession(preview, title)
      })

      const buildRuntimeEnv = (input?: Record<string, string>): Record<string, string> => {
        const runtimeEnv: Record<string, string> = {}
        const githubToken = config.githubToken.trim()
        if (githubToken.length > 0) {
          runtimeEnv.GH_TOKEN = githubToken
          runtimeEnv.GITHUB_TOKEN = githubToken
        }
        if (!input) return runtimeEnv
        return { ...runtimeEnv, ...input }
      }

      /** Best-effort: record a resume failure reason and mark the session as errored. */
      const recordFailure = (threadId: ThreadId, reason: string) =>
        Effect.all(
          [
            logIgnore(store.incrementResumeFailure(threadId, reason), "incrementResumeFailure"),
            logIgnore(store.updateStatus(threadId, "error", reason), "updateStatus"),
          ],
          { discard: true },
        )

      const restartOpenCodeServe =
        'pkill -f \'opencode serve --port 4096\' >/dev/null 2>&1 || true; for d in "$HOME/opencode" "/home/daytona/opencode" "/root/opencode"; do if [ -d "$d" ]; then cd "$d" && setsid opencode serve --port 4096 --hostname 0.0.0.0 > /tmp/opencode.log 2>&1 & exit 0; fi; done; exit 1'

      const provision = Effect.fn("SandboxProvisioner.provision")(function* (
        threadId: ThreadId,
        channelId: ChannelId,
        guildId: GuildId,
      ) {
        yield* logIgnore(store.updateStatus(threadId, "creating"), "updateStatus")

        return yield* Effect.acquireUseRelease(
          daytonaService.create({
            threadId,
            guildId,
            timeout: config.sandboxCreationTimeout,
          }),
          (handle) =>
            Effect.gen(function* () {
              const sandboxId = handle.id

              yield* Effect.logInfo("Created sandbox").pipe(
                Effect.annotateLogs({ event: "sandbox.create.started", threadId, channelId, guildId, sandboxId }),
              )

              const opencodeConfig: string = yield* Schema.encode(OpenCodeConfig)({
                model: config.openCodeModel,
                share: "disabled",
                permission: "allow",
                agent: { build: { mode: "primary", prompt: agentPrompt } },
              }).pipe(Effect.mapError((cause) => new ConfigEncodeError({ config: "OpenCodeConfig", cause })))

              const authJson: string = yield* Schema.encode(OpenCodeAuth)({
                opencode: { type: "api", key: Redacted.value(config.openCodeZenApiKey) },
              }).pipe(Effect.mapError((cause) => new ConfigEncodeError({ config: "OpenCodeAuth", cause })))

              yield* daytonaService.exec(
                sandboxId,
                "setup-opencode",
                [
                  `set -e`,
                  `git clone --depth=1 https://github.com/anomalyco/opencode.git $HOME/opencode`,
                  `mkdir -p $HOME/.local/share/opencode`,
                  `printf '%s' "$OPENCODE_AUTH_JSON" > $HOME/.local/share/opencode/auth.json`,
                  `printf '%s' "$OPENCODE_CONFIG_JSON" > $HOME/opencode/opencode.json`,
                  `cd $HOME/opencode`,
                  `setsid opencode serve --port 4096 --hostname 0.0.0.0 > /tmp/opencode.log 2>&1 &`,
                ].join("\n"),
                {
                  env: buildRuntimeEnv({
                    OPENCODE_AUTH_JSON: authJson,
                    OPENCODE_CONFIG_JSON: opencodeConfig,
                  }),
                },
              )

              const healthy = yield* oc.waitForHealthy(
                PreviewAccess.from(handle),
                config.startupHealthTimeoutMs,
              )
              if (!healthy) {
                const startupLog = yield* readStartupLog(sandboxId)
                return yield* new SandboxCreateError({
                  sandboxId: handle.id,
                  cause: new Error(`OpenCode server did not become healthy: ${startupLog.slice(0, 400)}`),
                })
              }

              const sessionId = yield* oc.createSession(
                PreviewAccess.from(handle),
                `Discord thread ${threadId}`,
              )

              const session: SessionInfo = SessionInfo.make({
                threadId,
                channelId,
                guildId,
                sandboxId: handle.id,
                sessionId,
                previewUrl: handle.previewUrl,
                previewToken: handle.previewToken,
                status: "active",
                lastError: null,
                resumeFailCount: 0,
              })

              yield* store.markHealthOk(threadId)

              yield* Effect.logInfo("Session is ready").pipe(
                Effect.annotateLogs({ event: "sandbox.create.ready", threadId, sandboxId, sessionId }),
              )

              return session
            }),
          (handle, exit) =>
            Exit.isFailure(exit)
              ? Effect.gen(function* () {
                  yield* Effect.logError("Failed to create session").pipe(
                    Effect.annotateLogs({ event: "sandbox.create.failed", threadId, sandboxId: handle.id }),
                  )
                  yield* logIgnore(store.updateStatus(threadId, "error", "creation-failed"), "updateStatus")
                  yield* daytonaService.destroy(handle.id)
                })
              : Effect.void,
        )
      })

      const failed = (allowRecreate: boolean) => ResumeFailed.make({ allowRecreate })

      const resume = (session: SessionInfo): Effect.Effect<ResumeResult> =>
        Effect.gen(function* () {
          if (!["paused", "destroyed", "error", "pausing", "resuming"].includes(session.status)) {
            return failed(true)
          }

          yield* store.updateStatus(session.threadId, "resuming")

          const startResult = yield* daytonaService.start(session.sandboxId, config.sandboxCreationTimeout).pipe(
            Effect.map(Option.some),
            Effect.catchTag("SandboxNotFoundError", (err) =>
              Effect.gen(function* () {
                yield* logIgnore(store.incrementResumeFailure(session.threadId, err.message), "incrementResumeFailure")
                yield* logIgnore(store.updateStatus(session.threadId, "destroyed", err.message), "updateStatus")
                return Option.none<SandboxHandle>()
              }),
            ),
            Effect.catchTag("SandboxStartError", (err) =>
              recordFailure(session.threadId, String(err.cause)).pipe(Effect.as(Option.none<SandboxHandle>())),
            ),
          )

          if (Option.isNone(startResult)) return failed(true)

          const handle = startResult.value

          yield* logIgnore(
            daytonaService.exec(session.sandboxId, "restart-opencode-serve", restartOpenCodeServe, {
              env: buildRuntimeEnv(),
            }),
            "restart-opencode-serve",
          )

          const preview = PreviewAccess.from(handle)

          const healthy = yield* oc.waitForHealthy(preview, config.resumeHealthTimeoutMs)
          if (!healthy) {
            const startupLog = yield* readStartupLog(session.sandboxId, 120)
            yield* recordFailure(
              session.threadId,
              `OpenCode health check failed after resume. Log: ${startupLog.slice(0, 500)}`,
            )
            return failed(false)
          }

          const sessionId = yield* findOrCreateSessionId(preview, session)

          const resumed = SessionInfo.make({
            ...session,
            sessionId,
            previewUrl: handle.previewUrl,
            previewToken: handle.previewToken,
            status: "active",
          })

          yield* store.markHealthOk(session.threadId)

          yield* Effect.logInfo("Resumed existing sandbox").pipe(
            Effect.annotateLogs({ event: "sandbox.resumed", threadId: session.threadId, sandboxId: session.sandboxId }),
          )

          return Resumed.make({ session: resumed })
        }).pipe(
          Effect.catchAll((err) =>
            recordFailure(session.threadId, String(err)).pipe(Effect.as(failed(false))),
          ),
        )

      const ensureHealthy = Effect.fn("SandboxProvisioner.ensureHealthy")(function* (
        session: SessionInfo,
        maxWaitMs: number,
      ) {
        const healthy = yield* oc.waitForHealthy(PreviewAccess.from(session), maxWaitMs)
        if (!healthy) {
          yield* recordFailure(session.threadId, "active-session-healthcheck-failed")
          return false
        }

        const attached = yield* oc
          .sessionExists(PreviewAccess.from(session), session.sessionId)
          .pipe(Effect.catchAll(() => Effect.succeed(false)))
        if (!attached) {
          yield* recordFailure(session.threadId, "active-session-missing")
          return false
        }

        yield* logIgnore(store.markHealthOk(session.threadId), "markHealthOk")
        return true
      })

      const pause = Effect.fn("SandboxProvisioner.pause")(function* (
        threadId: ThreadId,
        session: SessionInfo,
        reason: string,
      ) {
        if (session.status === "paused") return session

        yield* store.updateStatus(threadId, "pausing", reason)

        const stopped = Exit.isSuccess(yield* Effect.exit(daytonaService.stop(session.sandboxId)))

        if (stopped) {
          yield* store.updateStatus(threadId, "paused", null)
          return session.withStatus("paused")
        }

        yield* store.updateStatus(threadId, "destroyed", "sandbox-unavailable-during-pause")
        return session.withStatus("destroyed")
      })

      const destroy = Effect.fn("SandboxProvisioner.destroy")(function* (
        threadId: ThreadId,
        session: SessionInfo,
        reason?: string,
      ) {
        if (session.status === "destroyed") return session
        yield* store.updateStatus(threadId, "destroying", reason ?? null)
        yield* daytonaService.destroy(session.sandboxId)
        yield* store.updateStatus(threadId, "destroyed", reason ?? null)
        return session.withStatus("destroyed")
      })

      const ensureActive = Effect.fn("SandboxProvisioner.ensureActive")(function* (input: {
        threadId: ThreadId
        channelId: ChannelId
        guildId: GuildId
        current: Option.Option<SessionInfo>
      }) {
        if (Option.isNone(input.current)) {
          return yield* provision(input.threadId, input.channelId, input.guildId)
        }

        let candidate = input.current.value
        if (candidate.status === "active") {
          const healthy = yield* ensureHealthy(candidate, config.activeHealthCheckTimeoutMs)
          if (healthy) return candidate
          const refreshed = yield* store.getByThread(input.threadId)
          candidate = Option.isSome(refreshed) ? refreshed.value : candidate.withStatus("error")
        }

        if (config.sandboxReusePolicy === "resume_preferred") {
          const resumed = yield* resume(candidate)
          if (resumed instanceof Resumed) return resumed.session
          if (!resumed.allowRecreate) {
            return yield* new SandboxDeadError({
              threadId: input.threadId,
              reason: "Unable to reattach to existing sandbox session. Try again shortly.",
            })
          }
        }

        yield* destroy(input.threadId, candidate, "recreate-after-resume-failure")
        return yield* provision(input.threadId, input.channelId, input.guildId)
      })

      const recoverSendFailure = Effect.fn("SandboxProvisioner.recoverSendFailure")(function* (
        threadId: ThreadId,
        session: SessionInfo,
        error: OpenCodeClientError,
      ) {
        const kind = error.kind
        if (kind === "non-recoverable") return session

        yield* store.incrementResumeFailure(threadId, String(error))
        if (kind === "session-missing") {
          yield* store.updateStatus(threadId, "error", "opencode-session-missing")
          return session.withStatus("error")
        }

        return yield* pause(threadId, session, "recoverable send failure")
      })

      return SandboxProvisioner.of({
        provision,
        resume,
        ensureActive,
        ensureHealthy,
        recoverSendFailure,
        pause,
        destroy,
      })
    }),
  )
}
