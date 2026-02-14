import { Schedule } from "effect"
import { DeliveryError, messageOf } from "../conversation/model/errors"

const statusOf = (cause: unknown): number | null => {
  if (typeof cause !== "object" || cause === null) return null
  const status = (cause as { status?: unknown }).status
  if (typeof status === "number") return status
  const code = (cause as { code?: unknown }).code
  if (typeof code === "number") return code
  return null
}

export const deliveryRetriable = (cause: unknown): boolean => {
  const status = statusOf(cause)
  if (status === 429) return true
  if (status !== null && status >= 500) return true
  return false
}

export const catchupBenign = (cause: unknown): boolean => {
  const text = messageOf(cause).toLowerCase()
  if (text.includes("missing access")) return true
  if (text.includes("missing permissions")) return true
  if (text.includes("unknown channel")) return true
  if (text.includes("50001")) return true
  if (text.includes("50013")) return true
  return false
}

export const deliveryRetry = Schedule.exponential("200 millis").pipe(
  Schedule.intersect(Schedule.recurs(3)),
  Schedule.whileInput((error: DeliveryError) => error.retriable),
)
