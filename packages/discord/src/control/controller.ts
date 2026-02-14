import { BunRuntime } from "@effect/platform-bun"
import { Duration, Effect, Exit, Fiber, Option, Ref, Schema } from "effect"
import { ControlThreadLayer } from "../app/layers"
import { ThreadChatCluster, ThreadControlCluster } from "../conversation/thread/cluster"
import { ChannelId, GuildId, SandboxId, SessionInfo, ThreadId } from "../types"

type Opt = Record<string, string | boolean>

class CtlUsageError extends Schema.TaggedError<CtlUsageError>()("CtlUsageError", {
  message: Schema.String,
}) {}

class CtlInternalError extends Schema.TaggedError<CtlInternalError>()("CtlInternalError", {
  message: Schema.String,
  cause: Schema.Defect,
}) {}

const usage = (message: string) => CtlUsageError.make({ message })
const internal = (cause: unknown, message = text(cause)) => CtlInternalError.make({ message, cause })

const text = (cause: unknown) => {
  if (cause instanceof Error) return cause.message
  if (typeof cause === "object" && cause !== null && "_tag" in cause && "message" in cause) {
    const tag = (cause as { _tag?: unknown })._tag
    const message = (cause as { message?: unknown }).message
    if (typeof tag === "string" && typeof message === "string") return `${tag}: ${message}`
  }
  if (typeof cause === "object" && cause !== null) return String(cause)
  return String(cause)
}

const parse = (argv: ReadonlyArray<string>) => {
  const input = argv.slice(2)
  const cmd = input.at(0)?.toLowerCase() ?? "help"
  const scan = input.slice(1).reduce(
    (state: { opts: Opt; args: ReadonlyArray<string>; key: string | null }, token) => {
      if (token.startsWith("--")) {
        const key = token.slice(2)
        if (key.length === 0) return state
        if (state.key) {
          return {
            opts: { ...state.opts, [state.key]: true },
            args: state.args,
            key,
          }
        }
        return { ...state, key }
      }
      if (state.key) {
        return {
          opts: { ...state.opts, [state.key]: token },
          args: state.args,
          key: null,
        }
      }
      return { ...state, args: [...state.args, token] }
    },
    { opts: {} as Opt, args: [] as ReadonlyArray<string>, key: null as string | null },
  )
  if (!scan.key) return { cmd, opts: scan.opts, args: scan.args }
  return {
    cmd,
    opts: { ...scan.opts, [scan.key]: true },
    args: scan.args,
  }
}

const value = (opts: Opt, key: string) => {
  const raw = opts[key]
  if (typeof raw !== "string") return null
  const out = raw.trim()
  if (!out) return null
  return out
}

const number = (opts: Opt, key: string, fallback: number) => {
  const raw = value(opts, key)
  if (!raw) return fallback
  const out = Number(raw)
  if (!Number.isInteger(out) || out <= 0) return fallback
  return out
}

const flag = (opts: Opt, key: string) => {
  const raw = opts[key]
  if (raw === true) return true
  if (typeof raw !== "string") return false
  return raw === "1" || raw.toLowerCase() === "true" || raw.toLowerCase() === "yes"
}

let ctlSeq = 0
let msgSeq = 0
const pick = (opts: Opt, active: ReadonlyArray<{ threadId: ThreadId }>) => {
  const raw = value(opts, "thread")
  if (raw) return Effect.succeed(ThreadId.make(raw))
  if (active.length === 1) return Effect.succeed(active[0].threadId)
  if (active.length > 1) return Effect.fail(usage("missing --thread (multiple active sessions)"))
  ctlSeq += 1
  return Effect.succeed(ThreadId.make(`ctl-${ctlSeq}`))
}
const messageId = () => {
  msgSeq += 1
  return `ctl-msg-${Date.now()}-${msgSeq}`
}

const print = (ok: boolean, command: string, payload: Record<string, unknown>) =>
  Effect.sync(() => {
    process.stdout.write(
      `${JSON.stringify({
        ok,
        command,
        ...payload,
      }, null, 2)}\n`,
    )
  })

const event = (command: string, name: string, payload: Record<string, unknown>) =>
  Effect.sync(() => {
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        command,
        event: name,
        ...payload,
      })}\n`,
    )
  })

const run = Effect.gen(function* () {
  const ctl = parse(process.argv)
  const threadChat = yield* ThreadChatCluster
  const threadControl = yield* ThreadControlCluster
  const active = yield* threadControl.active
  const status = (threadId: ThreadId) =>
    threadChat.status(threadId).pipe(
      Effect.catchAll((cause) => internal(cause)),
    )
  const context = (threadId: ThreadId, opts: Opt) =>
    Effect.gen(function* () {
      const row = yield* status(threadId)
      if (Option.isSome(row)) {
        return {
          channelId: row.value.channelId,
          guildId: row.value.guildId,
        }
      }
      const channel = value(opts, "channel") ?? "ctl"
      const guild = value(opts, "guild") ?? "local"
      return {
        channelId: ChannelId.make(channel),
        guildId: GuildId.make(guild),
      }
    })

  if (ctl.cmd === "help") {
    return yield* print(true, ctl.cmd, {
      usage: [
        "conversation:ctl active",
        "conversation:ctl status --thread <id>",
        "conversation:ctl logs --thread <id> [--lines 120]",
        "conversation:ctl pause --thread <id>",
        "conversation:ctl recreate --thread <id>",
        "conversation:ctl resume --thread <id> [--channel <id> --guild <id>]",
        "conversation:ctl send --thread <id> --text <message> [--follow --wait-ms 180000 --logs-every-ms 2000 --lines 80]",
      ],
    })
  }

  if (ctl.cmd === "active") {
    return yield* print(true, ctl.cmd, {
      count: active.length,
      sessions: active.map((row) => ({
        threadId: row.threadId,
        channelId: row.channelId,
        guildId: row.guildId,
        sandboxId: row.sandboxId,
        sessionId: row.sessionId,
        status: row.status,
        resumeFailCount: row.resumeFailCount,
        lastError: row.lastError,
      })),
    })
  }

  if (ctl.cmd === "status") {
    const threadId = yield* pick(ctl.opts, active)
    const row = yield* status(threadId)
    return yield* print(true, ctl.cmd, {
      threadId: threadId,
      tracked: Option.isSome(row),
      session: Option.isSome(row)
        ? {
            threadId: row.value.threadId,
            channelId: row.value.channelId,
            guildId: row.value.guildId,
            sandboxId: row.value.sandboxId,
            sessionId: row.value.sessionId,
            status: row.value.status,
            resumeFailCount: row.value.resumeFailCount,
            lastError: row.value.lastError,
          }
        : null,
    })
  }

  if (ctl.cmd === "logs") {
    const threadId = yield* pick(ctl.opts, active)
    const lines = number(ctl.opts, "lines", 120)
    const row = yield* threadControl.logs({ threadId, lines }).pipe(
      Effect.catchAll((cause) => internal(cause)),
    )
    if (Option.isNone(row)) return yield* usage(`no tracked session for thread ${threadId}`)
    return yield* print(true, ctl.cmd, {
      threadId: threadId,
      sandboxId: row.value.sandboxId,
      lines,
      output: row.value.output,
    })
  }

  if (ctl.cmd === "pause") {
    const threadId = yield* pick(ctl.opts, active)
    const row = yield* threadControl.pause({ threadId, reason: "manual-ctl" }).pipe(
      Effect.catchAll((cause) => internal(cause)),
    )
    if (Option.isNone(row)) return yield* usage(`no tracked session for thread ${threadId}`)
    return yield* print(true, ctl.cmd, { threadId: threadId })
  }

  if (ctl.cmd === "recreate" || ctl.cmd === "destroy") {
    const threadId = yield* pick(ctl.opts, active)
    yield* threadChat.recreate(threadId)
    return yield* print(true, ctl.cmd, { threadId: threadId })
  }

  if (ctl.cmd === "resume") {
    const threadId = yield* pick(ctl.opts, active)
    const channel = value(ctl.opts, "channel")
    const guild = value(ctl.opts, "guild")
    const row = yield* threadControl.resume({
      threadId,
      channelId: channel ? ChannelId.make(channel) : null,
      guildId: guild ? GuildId.make(guild) : null,
    }).pipe(
      Effect.catchAll((cause) => internal(cause)),
    )
    return yield* print(true, ctl.cmd, {
      threadId: threadId,
      session: {
        sandboxId: row.sandboxId,
        sessionId: row.sessionId,
        status: row.status,
      },
    })
  }

  if (ctl.cmd === "send") {
    const threadId = yield* pick(ctl.opts, active)
    const message = value(ctl.opts, "text") ?? ctl.args.join(" ").trim()
    if (!message) {
      return yield* usage("missing message text (pass --text \"...\")")
    }
    const wait = number(ctl.opts, "wait-ms", 0)
    const every = number(ctl.opts, "logs-every-ms", 2000)
    const lines = number(ctl.opts, "lines", 80)
    const follow = flag(ctl.opts, "follow") || wait > 0

    if (!follow) {
      const input = yield* context(threadId, ctl.opts)
      const reply = yield* threadChat.send({
        threadId,
        channelId: input.channelId,
        guildId: input.guildId,
        messageId: messageId(),
        text: message,
      })
      return yield* print(true, ctl.cmd, {
        threadId: threadId,
        sandboxId: reply.session.sandboxId,
        sessionId: reply.session.sessionId,
        reply: reply.text,
      })
    }

    const known = yield* threadChat.status(threadId).pipe(
      Effect.catchAll(() => Effect.succeed(Option.none())),
    )
    const sandbox = yield* Ref.make<SandboxId | null>(Option.isSome(known) ? known.value.sandboxId : null)
    const last = yield* Ref.make<string>("")
    const started = Date.now()

    const fiber = yield* Effect.fork(
      Effect.gen(function* () {
        const input = yield* context(threadId, ctl.opts)
        const reply = yield* threadChat.send({
          threadId,
          channelId: input.channelId,
          guildId: input.guildId,
          messageId: messageId(),
          text: message,
        })
        yield* Ref.set(sandbox, reply.session.sandboxId)
        return { row: reply.session, reply: reply.text }
      }),
    )

    yield* event(ctl.cmd, "started", {
      threadId: threadId,
      waitMs: wait,
      logsEveryMs: every,
      lines,
    })

    const waitTick = Effect.void.pipe(Effect.delay(Duration.millis(every)))
    const loop = (): Effect.Effect<{ row: SessionInfo; reply: string }, unknown> =>
      Effect.gen(function* () {
        const done = yield* Fiber.poll(fiber)
        if (Option.isSome(done)) {
          if (Exit.isSuccess(done.value)) return done.value.value
          return yield* Effect.failCause(done.value.cause)
        }

        const elapsed = Date.now() - started
        if (wait > 0 && elapsed >= wait) {
          yield* Fiber.interrupt(fiber)
          return yield* usage(`send timed out after ${wait}ms`)
        }

        const sandboxId = yield* Ref.get(sandbox)
        if (!sandboxId) {
          yield* event(ctl.cmd, "progress", {
            threadId: threadId,
            elapsedMs: elapsed,
            stage: "resolving-session",
          })
          yield* waitTick
          return yield* loop()
        }

        const output = yield* threadControl.logs({ threadId, lines }).pipe(
          Effect.map((row) => Option.isSome(row) ? row.value.output : "(no tracked session)"),
          Effect.catchAll((cause) => Effect.succeed(`(log read failed: ${text(cause)})`)),
        )

        const previous = yield* Ref.get(last)
        if (output !== previous) {
          yield* Ref.set(last, output)
          yield* event(ctl.cmd, "progress", {
            threadId: threadId,
            elapsedMs: elapsed,
            sandboxId,
            logs: output,
          })
        } else {
          yield* event(ctl.cmd, "progress", {
            threadId: threadId,
            elapsedMs: elapsed,
            sandboxId,
            logs: "(no change)",
          })
        }

        yield* waitTick
        return yield* loop()
      })

    const result = yield* loop()
    return yield* print(true, ctl.cmd, {
      threadId: threadId,
      sandboxId: result.row.sandboxId,
      sessionId: result.row.sessionId,
      reply: result.reply,
    })
  }

  return yield* usage(`unknown command: ${ctl.cmd}`)
}).pipe(
  Effect.catchAll((cause) => {
    const command = parse(process.argv).cmd
    return print(false, command, { error: text(cause) }).pipe(
      Effect.zipRight(Effect.sync(() => {
        process.exitCode = 1
      })),
    )
  }),
)

run.pipe(
  Effect.provide(ControlThreadLayer),
  Effect.scoped,
  BunRuntime.runMain,
)
