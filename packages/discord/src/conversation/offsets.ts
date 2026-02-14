import * as Client from "@effect/sql/SqlClient"
import { Context, Effect, Layer, Option } from "effect"
import { SqliteDb } from "../db/client"
import { initializeSchema } from "../db/init"
import { DatabaseError } from "../errors"

const db = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.mapError((cause) => new DatabaseError({ cause })))

export declare namespace OffsetStore {
  export interface Service {
    readonly getOffset: (source_id: string) => Effect.Effect<Option.Option<string>, DatabaseError>
    readonly setOffset: (source_id: string, messageId: string) => Effect.Effect<void, DatabaseError>
  }
}

export class OffsetStore extends Context.Tag("@discord/conversation/OffsetStore")<OffsetStore, OffsetStore.Service>() {
  static readonly noop = Layer.succeed(
    OffsetStore,
    OffsetStore.of({
      getOffset: () => Effect.succeed(Option.none()),
      setOffset: () => Effect.void,
    }),
  )

  static readonly layer = Layer.effect(
    OffsetStore,
    Effect.gen(function* () {
      const sql = yield* SqliteDb
      yield* db(initializeSchema.pipe(Effect.provideService(Client.SqlClient, sql)))

      const getOffset = Effect.fn("OffsetStore.getOffset")(function* (source_id: string) {
        const rows = yield* db(
          sql<{ last_message_id: string }>`SELECT last_message_id
              FROM conversation_offsets
              WHERE source_id = ${source_id}
              LIMIT 1`,
        )
        const row = rows[0]
        if (!row) return Option.none<string>()
        return Option.some(row.last_message_id)
      })

      const setOffset = Effect.fn("OffsetStore.setOffset")(function* (source_id: string, messageId: string) {
        yield* db(
          sql`INSERT INTO conversation_offsets (source_id, last_message_id, updated_at)
              VALUES (${source_id}, ${messageId}, CURRENT_TIMESTAMP)
              ON CONFLICT(source_id) DO UPDATE SET
                last_message_id = excluded.last_message_id,
                updated_at = CURRENT_TIMESTAMP`,
        )
      })

      return OffsetStore.of({ getOffset, setOffset })
    }),
  )
}
