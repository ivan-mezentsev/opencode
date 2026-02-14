import { ClusterSchema, Entity } from "@effect/cluster"
import { Rpc } from "@effect/rpc"
import { Effect, Option, Predicate, Schema } from "effect"
import {
  DatabaseError,
  type HealthCheckError,
  isOpenCodeSandboxUnavailable,
  OpenCodeClientError,
  SandboxDeadError,
  type SandboxStartError,
} from "../../../errors"
import { StatefulActor } from "../../../lib/actors/stateful"
import { DaytonaService } from "../../../sandbox/daytona/service"
import { OpenCodeClient } from "../../../sandbox/opencode/client"
import { SandboxProvisioner } from "../../../sandbox/provisioner"
import { SessionStore } from "../../../session/store"
import { ChannelId, GuildId, PreviewAccess, SessionInfo, ThreadId } from "../../../types"
import { History } from "../../history"
import {
  LogsInput,
  LogsOutput,
  PauseInput,
  ResumeInput,
  SendInput,
  SendOutput,
  ThreadChatError,
} from "./contracts"

const StatusInput = Schema.Void
const RecreateInput = Schema.Void

type RetriableCause = SandboxDeadError | OpenCodeClientError | HealthCheckError | SandboxStartError

const isRetriableCause = (cause: unknown): cause is RetriableCause =>
  Predicate.isTagged(cause, "SandboxDeadError") ||
  Predicate.isTagged(cause, "OpenCodeClientError") ||
  Predicate.isTagged(cause, "HealthCheckError") ||
  Predicate.isTagged(cause, "SandboxStartError")

const toThreadError = (threadId: ThreadId, cause: unknown): ThreadChatError =>
  ThreadChatError.make({
    threadId,
    cause,
    retriable: isRetriableCause(cause),
  })

class ThreadState extends Schema.Class<ThreadState>("ClusterMode/ThreadState")({
  loaded: Schema.Boolean,
  session: Schema.NullOr(SessionInfo),
}) {
  static empty() {
    return ThreadState.make({ loaded: false, session: null })
  }

  option() {
    return Option.fromNullable(this.session)
  }

  hydrate(row: Option.Option<SessionInfo>) {
    if (Option.isNone(row)) return ThreadState.make({ loaded: true, session: null })
    return ThreadState.make({ loaded: true, session: row.value })
  }

  with(session: SessionInfo) {
    return ThreadState.make({ loaded: true, session })
  }

  clear() {
    return ThreadState.make({ loaded: true, session: null })
  }
}

const SendRpc = Rpc.make("send", {
  payload: SendInput,
  success: SendOutput,
  error: ThreadChatError,
}).annotate(ClusterSchema.Persisted, true)

const StatusRpc = Rpc.make("status", {
  payload: StatusInput,
  success: Schema.NullOr(SessionInfo),
  error: DatabaseError,
})

const RecreateRpc = Rpc.make("recreate", {
  payload: RecreateInput,
  success: Schema.Void,
  error: DatabaseError,
})

const PauseRpc = Rpc.make("pause", {
  payload: PauseInput,
  success: Schema.NullOr(SessionInfo),
  error: ThreadChatError,
})

const ResumeRpc = Rpc.make("resume", {
  payload: ResumeInput,
  success: SessionInfo,
  error: ThreadChatError,
})

const LogsRpc = Rpc.make("logs", {
  payload: LogsInput,
  success: Schema.NullOr(LogsOutput),
  error: ThreadChatError,
})

export const ThreadEntity = Entity.make("ThreadChat", [
  SendRpc,
  StatusRpc,
  RecreateRpc,
  PauseRpc,
  ResumeRpc,
  LogsRpc,
])

export const ThreadEntityLive = ThreadEntity.toLayer(
  Effect.gen(function* () {
    const oc = yield* OpenCodeClient
    const daytona = yield* DaytonaService
    const store = yield* SessionStore
    const history = yield* History
    const provisioner = yield* SandboxProvisioner
    const entityId = String((yield* Entity.CurrentAddress).entityId)
    if (entityId.includes("/")) {
      return yield* Effect.dieMessage(`ThreadEntity expected raw threadId entityId, got "${entityId}"`)
    }
    const threadId = ThreadId.make(entityId)
    const thread = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(Effect.mapError((cause) => toThreadError(threadId, cause)))

    const state = StatefulActor.make(ThreadState.empty())
    const stateNow = () => state.get().option()
    const setState = (session: SessionInfo) => {
      state.update((current) => current.with(session))
    }
    const clearState = () => {
      state.update((current) => current.clear())
    }

    /** Bootstrap state from DB once, then serve from in-memory state. */
    const load = Effect.fn("ThreadEntity.load")(function* () {
      const current = state.get()
      if (current.loaded) return current.option()
      const row = yield* store.getByThread(threadId)
      const hydrated = current.hydrate(row)
      state.set(hydrated)
      return hydrated.option()
    })

    /** Persist the latest session snapshot for crash recovery. */
    const saveSession = Effect.fnUntraced(function* (session: SessionInfo) {
      yield* store.upsert(session)
    })

    /** Update in-memory state and persist it as one operation. */
    const commitSession = Effect.fnUntraced(function* (session: SessionInfo) {
      setState(session)
      yield* saveSession(session)
    })

    /** Ensure there is an active session for this thread (resume or create). */
    const ensureSession = Effect.fnUntraced(function* (
      channelId: ChannelId,
      guildId: GuildId,
      current: Option.Option<SessionInfo>,
    ) {
      return yield* provisioner.ensureActive({
        threadId,
        channelId,
        guildId,
        current,
      })
    })

    /** Rebuild prompt context when session changed; otherwise keep prompt as-is. */
    const rehydrate = (latest: string, before: Option.Option<SessionInfo>, next: SessionInfo) => {
      if (Option.isNone(before)) return Effect.succeed(latest)
      if (before.value.sessionId === next.sessionId) return Effect.succeed(latest)
      return history.rehydrate(threadId, latest)
    }

    const recoverFailure = (session: SessionInfo, error: OpenCodeClientError) =>
      isOpenCodeSandboxUnavailable(error)
        ? SandboxDeadError.make({
          threadId: session.threadId,
          reason: `OpenCode send failed (${error.statusCode})`,
        })
        : error

    const recoverSendError = Effect.fnUntraced(function* (session: SessionInfo, error: OpenCodeClientError) {
      const next = yield* provisioner.recoverSendFailure(session.threadId, session, error)
      yield* commitSession(next)
      return yield* recoverFailure(session, error)
    })

    /** Send prompt to OpenCode and record recovery state if send failed. */
    const sendPrompt = Effect.fnUntraced(function* (session: SessionInfo, text: string) {
      yield* store.markActivity(session.threadId)
      return yield* oc
        .sendPrompt(PreviewAccess.from(session), session.sessionId, text)
        .pipe(Effect.catchTag("OpenCodeClientError", (error) => recoverSendError(session, error)))
    })

    /** Retry exactly once after sandbox-dead by re-ensuring and rehydrating. */
    const retrySend = Effect.fnUntraced(function* (payload: SendInput, prior: SessionInfo, text: string) {
      return yield* sendPrompt(prior, text).pipe(
        Effect.catchTag("SandboxDeadError", () =>
          Effect.gen(function* () {
            const resumed = yield* ensureSession(payload.channelId, payload.guildId, stateNow())
            yield* commitSession(resumed)
            const next = yield* rehydrate(payload.text, Option.some(prior), resumed)
            return yield* sendPrompt(resumed, next)
          }),
        ),
      )
    })

    /** Full send lifecycle: load, ensure, persist, rehydrate, send, retry, return output. */
    const sendNow = Effect.fnUntraced(function* (payload: SendInput) {
      return yield* Effect.gen(function* () {
        const before = yield* load()
        const active = yield* ensureSession(payload.channelId, payload.guildId, before)
        yield* commitSession(active)
        const first = yield* rehydrate(payload.text, before, active)
        const text = yield* retrySend(payload, active, first)
        const session = Option.getOrElse(stateNow(), () => active)
        return SendOutput.make({
          text,
          session,
          changedSession: Option.isSome(before) ? before.value.sessionId !== session.sessionId : false,
        })
      })
    })

    /** Full send lifecycle: load, ensure, persist, rehydrate, send, retry, return output. */
    const send = Effect.fn("ThreadEntity.send")(function* ({ payload }) {
      return yield* thread(sendNow(payload))
    })

    /** Read current session from actor state (bootstrapping from DB on first access). */
    const status = Effect.fn("ThreadEntity.status")(function* () {
      const row = yield* load()
      if (Option.isNone(row)) return null
      return row.value
    })

    /** Destroy current session resources for this thread and clear actor state. */
    const recreate = Effect.fn("ThreadEntity.recreate")(function* () {
      const row = yield* load()
      if (Option.isNone(row)) {
        clearState()
        return
      }
      const next = yield* provisioner.destroy(threadId, row.value, "cluster-recreate")
      yield* store.upsert(next)
      clearState()
    })

    /** Pause active session if present and commit paused state. */
    const pause = Effect.fn("ThreadEntity.pause")(function* ({ payload }) {
      return yield* thread(Effect.gen(function* () {
        const row = yield* load()
        if (Option.isNone(row)) return null
        const next = yield* provisioner.pause(threadId, row.value, payload.reason)
        yield* commitSession(next)
        return next
      }))
    })

    /** Resume existing session or create one when missing, then commit state. */
    const resume = Effect.fn("ThreadEntity.resume")(function* ({ payload }) {
      return yield* thread(Effect.gen(function* () {
        const before = yield* load()
        const channelId = payload.channelId === null
          ? Option.match(before, {
            onNone: () => ChannelId.make("ctl"),
            onSome: (row) => row.channelId,
          })
          : payload.channelId
        const guildId = payload.guildId === null
          ? Option.match(before, {
            onNone: () => GuildId.make("local"),
            onSome: (row) => row.guildId,
          })
          : payload.guildId
        const next = yield* ensureSession(channelId, guildId, before)
        yield* commitSession(next)
        return next
      }))
    })

    /** Read sandbox log tail for active session if present. */
    const logs = Effect.fn("ThreadEntity.logs")(function* ({ payload }) {
      return yield* thread(Effect.gen(function* () {
        const row = yield* load()
        if (Option.isNone(row)) return null
        const out = yield* daytona.exec(
          row.value.sandboxId,
          "read-opencode-log",
          `cat /tmp/opencode.log 2>/dev/null | tail -${payload.lines}`,
        )
        return LogsOutput.make({
          sandboxId: row.value.sandboxId,
          output: out.output,
        })
      }))
    })

    const handlers = { send, status, recreate, pause, resume, logs }
    return ThreadEntity.of(handlers)
  }),
  { maxIdleTime: "30 minutes" },
)
