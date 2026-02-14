import { Context, Effect, Layer } from "effect"
import type { ThreadId } from "../types"
import type { HistoryError } from "./model/errors"

export declare namespace History {
  export interface Service {
    readonly rehydrate: (threadId: ThreadId, latest: string) => Effect.Effect<string, HistoryError>
  }
}

export class History extends Context.Tag("@discord/conversation/History")<History, History.Service>() {
  static readonly passthrough = Layer.succeed(
    History,
    History.of({
      rehydrate: (_threadId: ThreadId, latest: string) => Effect.succeed(latest),
    }),
  )
}
