import { Schema } from "effect"
import { SandboxId, SessionId, ThreadId } from "./types"

// -- Sandbox errors (Daytona SDK) --

export class SandboxCreateError extends Schema.TaggedError<SandboxCreateError>()(
  "SandboxCreateError",
  {
    sandboxId: Schema.optional(SandboxId),
    cause: Schema.Defect,
  },
) {}

export class SandboxNotFoundError extends Schema.TaggedError<SandboxNotFoundError>()(
  "SandboxNotFoundError",
  {
    sandboxId: SandboxId,
  },
) {}

export class SandboxExecError extends Schema.TaggedError<SandboxExecError>()(
  "SandboxExecError",
  {
    sandboxId: SandboxId,
    label: Schema.String,
    exitCode: Schema.Number,
    output: Schema.String,
  },
) {}

export class SandboxStartError extends Schema.TaggedError<SandboxStartError>()(
  "SandboxStartError",
  {
    sandboxId: SandboxId,
    cause: Schema.Defect,
  },
) {}

// -- OpenCode client errors --

export class HealthCheckError extends Schema.TaggedError<HealthCheckError>()(
  "HealthCheckError",
  {
    lastStatus: Schema.String,
  },
) {}

export const OpenCodeFailureKind = Schema.Literal("session-missing", "sandbox-down", "non-recoverable")
export type OpenCodeFailureKind = typeof OpenCodeFailureKind.Type

export const classifyOpenCodeFailure = (statusCode: number, body: string): OpenCodeFailureKind => {
  if (statusCode === 404) return "session-missing"
  if (statusCode === 0 || statusCode >= 500) return "sandbox-down"
  const text = body.toLowerCase()
  if (text.includes("sandbox not found") || text.includes("is the sandbox started")) return "sandbox-down"
  return "non-recoverable"
}

export class OpenCodeClientError extends Schema.TaggedError<OpenCodeClientError>()(
  "OpenCodeClientError",
  {
    operation: Schema.String,
    statusCode: Schema.Number,
    body: Schema.String,
    kind: OpenCodeFailureKind,
  },
) {}

export const isOpenCodeSandboxUnavailable = (error: OpenCodeClientError) => {
  if (error.kind === "session-missing") return true
  return error.kind === "sandbox-down"
}

export class SessionMissingError extends Schema.TaggedError<SessionMissingError>()(
  "SessionMissingError",
  {
    sessionId: SessionId,
  },
) {}

// -- Session lifecycle errors --

export class SandboxDeadError extends Schema.TaggedError<SandboxDeadError>()(
  "SandboxDeadError",
  {
    threadId: ThreadId,
    reason: Schema.String,
  },
) {}

export class ResumeFailedError extends Schema.TaggedError<ResumeFailedError>()(
  "ResumeFailedError",
  {
    threadId: ThreadId,
    sandboxId: SandboxId,
    cause: Schema.Defect,
  },
) {}

// -- Config errors --

export class ConfigEncodeError extends Schema.TaggedError<ConfigEncodeError>()(
  "ConfigEncodeError",
  {
    config: Schema.String,
    cause: Schema.Defect,
  },
) {}

// -- Database errors --

export class DatabaseError extends Schema.TaggedError<DatabaseError>()(
  "DatabaseError",
  {
    cause: Schema.Defect,
  },
) {}
