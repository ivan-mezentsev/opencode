import { ThreadId } from "../types"
import type { Action } from "../conversation/model/schema"

const LOCAL_CHANNEL = "local-channel" as const

export type Scope =
  | { kind: "channel"; channelId: typeof LOCAL_CHANNEL }
  | { kind: "thread"; threadId: ThreadId; channelId: typeof LOCAL_CHANNEL }

export type Command =
  | { kind: "channel" }
  | { kind: "help" }
  | { kind: "threads" }
  | { kind: "pick"; index: number | null }
  | { kind: "active" }
  | { kind: "thread"; threadId: ThreadId | null }
  | { kind: "status"; threadId: ThreadId | null }
  | { kind: "logs"; threadId: ThreadId | null; lines: number }
  | { kind: "pause"; threadId: ThreadId | null }
  | { kind: "recreate"; threadId: ThreadId | null }
  | { kind: "resume"; threadId: ThreadId | null }
  | { kind: "unknown"; name: string }

export const base = (): Scope => ({ kind: "channel", channelId: LOCAL_CHANNEL })

const target = (value: string | undefined) => {
  const raw = value?.trim() ?? ""
  if (!raw) return null
  return ThreadId.make(raw)
}

const parseLines = (raw: string | undefined) => {
  const n = Number(raw)
  if (!Number.isFinite(n)) return null
  if (!Number.isInteger(n)) return null
  if (n <= 0) return null
  return n
}

const parseIndex = (raw: string | undefined) => {
  const n = Number(raw)
  if (!Number.isInteger(n) || n <= 0) return null
  return n
}

export const parse = (line: string): Command | null => {
  const text = line.trim()
  if (!text.startsWith("/")) return null
  const parts = text.slice(1).split(/\s+/)
  const head = parts.at(0)?.toLowerCase() ?? ""
  const args = parts.slice(1)

  if (head === "channel") return { kind: "channel" }
  if (head === "help") return { kind: "help" }
  if (head === "threads") return { kind: "threads" }
  if (head === "pick") return { kind: "pick", index: parseIndex(args.at(0)) }
  if (head === "active") return { kind: "active" }
  if (head === "thread") return { kind: "thread", threadId: target(args.at(0)) }
  if (head === "status") return { kind: "status", threadId: target(args.at(0)) }

  if (head === "logs") {
    const lines = parseLines(args.at(0))
    if (lines === null) {
      return { kind: "logs", lines: 120, threadId: target(args.at(0)) }
    }
    return { kind: "logs", lines, threadId: target(args.at(1)) }
  }

  if (head === "pause") return { kind: "pause", threadId: target(args.at(0)) }
  if (head === "recreate" || head === "destroy") return { kind: "recreate", threadId: target(args.at(0)) }
  if (head === "resume") return { kind: "resume", threadId: target(args.at(0)) }

  return { kind: "unknown", name: head }
}

export const scopeText = (scope: Scope) => scope.kind === "channel"
  ? `channel:${scope.channelId}`
  : `thread:${scope.threadId}`

export const prompt = (scope: Scope) => scope.kind === "channel"
  ? "channel> "
  : `thread:${scope.threadId}> `

export const queueTarget = (scope: Scope) => scope.kind === "channel" ? "channel" : "thread"

export const threadFrom = (scope: Scope, threadId: ThreadId): Scope => ({
  kind: "thread",
  channelId: scope.channelId,
  threadId,
})

export const channelFrom = (scope: Scope): Scope => ({
  kind: "channel",
  channelId: scope.channelId,
})

export const autoThread = (scope: Scope, action: Action, known = false): Scope => {
  if (scope.kind === "thread") return scope
  if (action.kind !== "typing" && action.kind !== "send" && action.kind !== "reply") return scope
  if (known) return scope
  return threadFrom(scope, action.threadId)
}
