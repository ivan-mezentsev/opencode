import { Context, Effect, Layer } from "effect"
import type { ThreadId } from "../types"
import type { DeliveryError } from "./model/errors"
import type { Action } from "./model/schema"

export declare namespace Outbox {
  export interface Service {
    readonly publish: (action: Action) => Effect.Effect<void, DeliveryError>
    readonly withTyping: <A, E, R>(threadId: ThreadId, self: Effect.Effect<A, E, R>) => Effect.Effect<A, E | DeliveryError, R>
  }
}

export class Outbox extends Context.Tag("@discord/conversation/Outbox")<Outbox, Outbox.Service>() {
  static readonly noop = Layer.succeed(
    Outbox,
    Outbox.of({
      publish: () => Effect.void,
      withTyping: (_threadId, self) => self,
    }),
  )
}
