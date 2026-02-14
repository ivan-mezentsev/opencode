import { Context, Effect, Layer } from "effect"

const DEDUP_LIMIT = 4_000

const makeDedupSet = () => {
  const seen = new Set<string>()
  const order: Array<string> = []
  return (messageId: string): boolean => {
    if (seen.has(messageId)) return false
    seen.add(messageId)
    order.push(messageId)
    if (order.length > DEDUP_LIMIT) {
      const oldest = order.shift()
      if (oldest) seen.delete(oldest)
    }
    return true
  }
}

export declare namespace IngressDedup {
  export interface Service {
    readonly dedup: (messageId: string) => Effect.Effect<boolean>
  }
}

export class IngressDedup extends Context.Tag("@discord/conversation/IngressDedup")<IngressDedup, IngressDedup.Service>() {
  static readonly noop = Layer.sync(IngressDedup, () => {
    const check = makeDedupSet()
    return IngressDedup.of({
      dedup: (messageId) => Effect.sync(() => check(messageId)),
    })
  })

  static readonly layer = IngressDedup.noop
}
