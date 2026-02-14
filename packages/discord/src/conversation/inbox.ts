import { Context, Layer, Stream } from "effect"
import type { Inbound } from "./model/schema"

export declare namespace Inbox {
  export interface Service {
    readonly events: Stream.Stream<Inbound>
  }
}

export class Inbox extends Context.Tag("@discord/conversation/Inbox")<Inbox, Inbox.Service>() {
  static readonly empty = Layer.succeed(
    Inbox,
    Inbox.of({
      events: Stream.empty as Stream.Stream<Inbound>,
    }),
  )
}
