import { Schema } from "effect"
import { ChannelId, ThreadId } from "../../types"

const DeliveryAction = Schema.Literal("typing", "send", "reply")

export class ThreadEnsureError extends Schema.TaggedError<ThreadEnsureError>()(
  "ThreadEnsureError",
  {
    channelId: ChannelId,
    message: Schema.String,
    retriable: Schema.Boolean,
  },
) {}

export class HistoryError extends Schema.TaggedError<HistoryError>()(
  "HistoryError",
  {
    threadId: ThreadId,
    message: Schema.String,
    retriable: Schema.Boolean,
  },
) {}

export class DeliveryError extends Schema.TaggedError<DeliveryError>()(
  "DeliveryError",
  {
    threadId: ThreadId,
    action: DeliveryAction,
    message: Schema.String,
    retriable: Schema.Boolean,
  },
) {}

export class RoutingError extends Schema.TaggedError<RoutingError>()(
  "RoutingError",
  {
    message: Schema.String,
    retriable: Schema.Boolean,
  },
) {}

export class SandboxSendError extends Schema.TaggedError<SandboxSendError>()(
  "SandboxSendError",
  {
    threadId: ThreadId,
    message: Schema.String,
    retriable: Schema.Boolean,
  },
) {}

export const ConversationError = Schema.Union(
  ThreadEnsureError,
  HistoryError,
  DeliveryError,
  RoutingError,
  SandboxSendError,
)

export type ConversationError = typeof ConversationError.Type

const messageFrom = (value: unknown, depth: number): string => {
  if (depth > 4) return String(value)
  if (typeof value === "string") return value

  if (value instanceof Error) {
    const nested = Reflect.get(value, "cause")
    if (nested === undefined) return value.message
    const inner = messageFrom(nested, depth + 1)
    if (inner.length === 0 || inner === value.message) return value.message
    return `${value.message}: ${inner}`
  }

  if (typeof value === "object" && value !== null) {
    const message = Reflect.get(value, "message")
    const nested = Reflect.get(value, "cause")
    if (typeof message === "string" && nested === undefined) return message
    if (typeof message === "string") {
      const inner = messageFrom(nested, depth + 1)
      if (inner.length === 0 || inner === message) return message
      return `${message}: ${inner}`
    }
    if (nested !== undefined) return messageFrom(nested, depth + 1)
  }

  return String(value)
}

export const messageOf = (cause: unknown): string => messageFrom(cause, 0)
