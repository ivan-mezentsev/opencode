import { Context, Effect, Layer } from "effect"
import { ThreadEnsureError } from "./model/errors"
import type { Inbound, ThreadRef } from "./model/schema"

export declare namespace Threads {
  export interface Service {
    readonly ensure: (event: Inbound, name: string) => Effect.Effect<ThreadRef, ThreadEnsureError>
  }
}

export class Threads extends Context.Tag("@discord/conversation/Threads")<Threads, Threads.Service>() {
  static readonly empty = Layer.succeed(
    Threads,
    Threads.of({
      ensure: (event) => {
        if (event.kind === "thread_message") {
          return Effect.succeed({ threadId: event.threadId, channelId: event.channelId })
        }
        return Effect.fail(
          ThreadEnsureError.make({
            channelId: event.channelId,
            message: "threads adapter missing for channel message",
            retriable: false,
          }),
        )
      },
    }),
  )
}
