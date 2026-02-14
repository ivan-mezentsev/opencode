import { stdin, stdout } from "node:process"
import readline from "node:readline/promises"
import { BunRuntime } from "@effect/platform-bun"
import { Effect, Layer, LogLevel, Logger, Option, Stream } from "effect"
import { CliConversationStaticLayer } from "../app/layers"
import { ThreadChatCluster, ThreadControlCluster } from "../conversation/thread/cluster"
import { ThreadId } from "../types"
import type { Action } from "../conversation/model/schema"
import { makeTui } from "./local-adapter"
import { Conversation } from "../conversation/conversation"
import { autoThread, base, channelFrom, parse, prompt, scopeText, threadFrom } from "./state"

const colors = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  red: "\x1b[31m",
} as const

const now = () => new Date().toLocaleTimeString("en-US", { hour12: false })

const run = Effect.gen(function* () {
  const tui = yield* makeTui
  const layer = Conversation.layer.pipe(
    Layer.provideMerge(tui.layer),
    Layer.provideMerge(CliConversationStaticLayer),
  )

  yield* Effect.gen(function* () {
    const conversation = yield* Conversation
    const threadChat = yield* ThreadChatCluster
    const threadControl = yield* ThreadControlCluster
    const rl = readline.createInterface({ input: stdin, output: stdout, terminal: true })
    let scope = base()
    let pending = 0
    let last: ThreadId | null = null
    const seen = new Set<ThreadId>()
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        rl.close()
      }),
    )

    const draw = (line: string, keep = true): Effect.Effect<void> =>
      Effect.sync(() => {
        stdout.write(`\r\x1b[2K${line}\n`)
        if (keep) {
          stdout.write(`${prompt(scope)}${rl.line}`)
        }
      })

    const stamp = (label: string, color: string, text: string) =>
      `${colors.dim}${now()}${colors.reset} ${color}${label}${colors.reset} ${text}`

    const info = (text: string): Effect.Effect<void> => draw(stamp("info", colors.blue, text), false)

    const block = (head: string, body: string): Effect.Effect<void> =>
      Effect.sync(() => {
        stdout.write(`\r\x1b[2K${head}\n${body}\n`)
        stdout.write(`${prompt(scope)}${rl.line}`)
      })

    const noteThread = (threadId: ThreadId): Effect.Effect<void> =>
      Effect.sync(() => {
        seen.add(threadId)
        last = threadId
      })

    const pick = (threadId: ThreadId | null): ThreadId | null => {
      if (threadId) return threadId
      if (scope.kind === "thread") return scope.threadId
      return last
    }
    const list = () => Array.from(seen)
    const byIndex = (index: number) => list().at(index - 1) ?? null
    const fromRef = (threadId: ThreadId | null) => {
      if (!threadId) return null
      const raw = `${threadId}`.trim()
      if (!/^\d+$/.test(raw)) return threadId
      const index = Number(raw)
      if (!Number.isInteger(index) || index <= 0) return null
      return byIndex(index)
    }

    const tracked = (threadId: ThreadId) =>
      threadChat.status(threadId).pipe(
        Effect.map((row) => Option.isSome(row) ? row.value : null),
        Effect.catchAll(() => Effect.succeed(null)),
      )

    const sessionText = (threadId: ThreadId, session: {
      status: string
      sandboxId: string
      sessionId: string
      resumeFailCount: number
      lastError: string | null
    }) =>
      `${colors.dim}${threadId}${colors.reset} status=${session.status} sandbox=${session.sandboxId} session=${session.sessionId} resume_failures=${session.resumeFailCount}${session.lastError ? ` error=${session.lastError.slice(0, 120)}` : ""}`

    const render = (action: Action) => {
      if (action.kind === "typing") {
        return stamp("typing", colors.yellow, `${colors.dim}[${action.threadId}]${colors.reset}`)
      }
      return stamp("assistant", colors.cyan, `${colors.dim}[${action.threadId}]${colors.reset} ${action.text}`)
    }

    yield* draw(
      stamp(
        "ready",
        colors.yellow,
        `${colors.dim}Type messages. /thread [id|n], /pick [n], /channel, /threads, /status, /logs, /pause, /recreate, /resume, /active, /help, /exit${colors.reset}`,
      ),
      false,
    )

    yield* Effect.forkScoped(
      Stream.runForEach(
        tui.actions,
        (action) =>
          Effect.gen(function* () {
            const known = seen.has(action.threadId)
            yield* noteThread(action.threadId)
            const next = autoThread(scope, action, known)
            const switched = scope.kind === "channel" && next.kind === "thread"
            scope = next
            if (switched) {
              yield* info(`${colors.dim}using ${scopeText(scope)} (/channel to go back)${colors.reset}`)
            }
            if ((action.kind === "send" || action.kind === "reply") && pending > 0) {
              pending -= 1
            }
            yield* draw(render(action))
          }),
      ),
    )

    yield* Effect.forkScoped(conversation.run)

    const queue = (text: string) =>
      Effect.gen(function* () {
        const target = scopeText(scope)
        if (scope.kind === "channel") {
          yield* tui.send(text)
        } else {
          yield* tui.sendTo(scope.threadId, text)
        }
        pending += 1
        yield* draw(stamp("queued", colors.green, `${colors.dim}[${target}]${colors.reset} ${text}`), false)
        yield* Effect.fork(
          Effect.suspend(() =>
            pending > 0
              ? draw(stamp("waiting", colors.yellow, `${colors.dim}[${target}] preparing sandbox/session...${colors.reset}`), false)
              : Effect.void,
          ).pipe(
            Effect.delay("2 seconds"),
          ),
        )
      })

    const command = (text: string) =>
      Effect.gen(function* () {
        const cmd = parse(text)
        if (!cmd) return false

        if (cmd.kind === "help") {
          yield* info(
            `${colors.dim}/thread [id|n], /pick [n], /channel, /threads, /status [thread], /logs [lines] [thread], /pause [thread], /recreate [thread], /resume [thread], /active, /exit${colors.reset}`,
          )
          return true
        }

        if (cmd.kind === "threads") {
          if (seen.size === 0) {
            yield* info(`${colors.dim}no known threads yet${colors.reset}`)
            return true
          }
          yield* info(`${colors.dim}${list().map((id, i) => `${i + 1}:${id}`).join(", ")}${colors.reset}`)
          return true
        }

        if (cmd.kind === "pick") {
          if (seen.size === 0) {
            yield* info(`${colors.dim}no known threads yet${colors.reset}`)
            return true
          }
          if (!cmd.index) {
            yield* info(`${colors.dim}${list().map((id, i) => `${i + 1}:${id}`).join(", ")}${colors.reset}`)
            yield* info(`${colors.dim}pick one with /pick <n>${colors.reset}`)
            return true
          }
          const threadId = byIndex(cmd.index)
          if (!threadId) {
            yield* info(`${colors.dim}invalid thread index ${cmd.index}${colors.reset}`)
            return true
          }
          scope = threadFrom(scope, threadId)
          yield* info(`${colors.dim}using ${scopeText(scope)}${colors.reset}`)
          return true
        }

        if (cmd.kind === "active") {
          yield* threadControl.active.pipe(
            Effect.matchEffect({
              onFailure: (error) =>
                info(`${colors.red}active query failed${colors.reset} ${String(error)}`),
              onSuccess: (active) =>
                active.length === 0
                  ? info(`${colors.dim}no active sessions${colors.reset}`)
                  : info(`${colors.dim}${active.map((s) => `${s.threadId}(${s.status})`).join(", ")}${colors.reset}`),
            }),
          )
          return true
        }

        if (cmd.kind === "channel") {
          scope = channelFrom(scope)
          yield* info(`${colors.dim}using ${scopeText(scope)}${colors.reset}`)
          return true
        }

        if (cmd.kind === "thread") {
          const selected = fromRef(cmd.threadId)
          if (selected) {
            scope = threadFrom(scope, selected)
            yield* noteThread(selected)
            yield* info(`${colors.dim}using ${scopeText(scope)}${colors.reset}`)
            return true
          }
          if (cmd.threadId) {
            yield* info(`${colors.dim}invalid thread id/index${colors.reset}`)
            return true
          }
          if (last) {
            scope = threadFrom(scope, last)
            yield* info(`${colors.dim}using ${scopeText(scope)}${colors.reset}`)
            return true
          }
          yield* info(`${colors.dim}no thread id yet. use /thread <id>${colors.reset}`)
          return true
        }

        if (cmd.kind === "status") {
          const threadId = pick(cmd.threadId)
          if (!threadId) {
            yield* info(`${colors.dim}no thread selected. use /thread <id>${colors.reset}`)
            return true
          }
          yield* noteThread(threadId)
          const session = yield* tracked(threadId)
          if (!session) {
            yield* info(`${colors.dim}no tracked session for ${threadId}${colors.reset}`)
            return true
          }
          yield* info(sessionText(threadId, session))
          return true
        }

        if (cmd.kind === "logs") {
          const threadId = pick(cmd.threadId)
          if (!threadId) {
            yield* info(`${colors.dim}no thread selected. use /thread <id>${colors.reset}`)
            return true
          }
          yield* noteThread(threadId)
          const row = yield* threadControl.logs({ threadId, lines: cmd.lines }).pipe(
            Effect.catchAll(() => Effect.succeed(Option.none())),
          )
          if (Option.isNone(row)) {
            yield* info(`${colors.dim}no tracked session for ${threadId}${colors.reset}`)
            return true
          }
          yield* block(
            stamp("logs", colors.blue, `${colors.dim}[${threadId}]${colors.reset}`),
            row.value.output.trim() || "(empty log)",
          )
          return true
        }

        if (cmd.kind === "pause") {
          const threadId = pick(cmd.threadId)
          if (!threadId) {
            yield* info(`${colors.dim}no thread selected. use /thread <id>${colors.reset}`)
            return true
          }
          yield* noteThread(threadId)
          const row = yield* threadControl.pause({ threadId, reason: "manual-cli" }).pipe(
            Effect.catchAll(() => Effect.succeed(Option.none())),
          )
          if (Option.isNone(row)) {
            yield* info(`${colors.dim}no tracked session for ${threadId}${colors.reset}`)
            return true
          }
          yield* info(`${colors.dim}paused ${threadId}${colors.reset}`)
          return true
        }

        if (cmd.kind === "recreate") {
          const threadId = pick(cmd.threadId)
          if (!threadId) {
            yield* info(`${colors.dim}no thread selected. use /thread <id>${colors.reset}`)
            return true
          }
          yield* noteThread(threadId)
          yield* threadChat.recreate(threadId).pipe(
            Effect.matchEffect({
              onFailure: (error) =>
                info(`${colors.red}recreate failed${colors.reset} ${String(error)}`),
              onSuccess: () =>
                info(`${colors.dim}recreated ${threadId}${colors.reset}`),
            }),
          )
          return true
        }

        if (cmd.kind === "resume") {
          const threadId = pick(cmd.threadId)
          if (!threadId) {
            yield* info(`${colors.dim}no thread selected. use /thread <id>${colors.reset}`)
            return true
          }
          const session = yield* tracked(threadId)
          if (session === null) {
            yield* info(`${colors.dim}no tracked session for ${threadId}${colors.reset}`)
            return true
          }
          yield* noteThread(threadId)
          yield* threadControl.resume({
            threadId,
            channelId: session.channelId,
            guildId: session.guildId,
          }).pipe(
            Effect.matchEffect({
              onFailure: (error) =>
                info(`${colors.red}resume failed${colors.reset} ${String(error)}`),
              onSuccess: (current) =>
                info(
                  `${colors.dim}resumed ${threadId} sandbox=${current.sandboxId} session=${current.sessionId}${colors.reset}`,
                ),
            }),
          )
          return true
        }

        yield* info(`${colors.dim}unknown command: /${cmd.name}${colors.reset}`)
        return true
      })

    const loop: Effect.Effect<void> = Effect.gen(function* () {
      const text = (yield* Effect.promise(() => rl.question(prompt(scope)))).trim()
      if (!text) return yield* loop
      if (text === "/exit" || text === "exit" || text === "quit") return
      const handled = yield* command(text)
      if (handled) return yield* loop
      yield* queue(text)
      return yield* loop
    })

    yield* loop
  }).pipe(
    Effect.provide(layer),
    Effect.scoped,
  )
})

run.pipe(
  Logger.withMinimumLogLevel(LogLevel.Warning),
  BunRuntime.runMain,
)
