import * as Client from "@effect/sql/SqlClient"
import { Context, Effect, Layer, Option } from "effect"
import { SqliteDb } from "../../db/client"
import { initializeSchema } from "../../db/init"
import { DatabaseError } from "../../errors"

const DEDUP_LIMIT = 4_000

const db = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.mapError((cause) => new DatabaseError({ cause })))

const makeDedupSet = () => {
  const seen = new Set<string>()
  const order: Array<string> = []
  return (message_id: string): boolean => {
    if (seen.has(message_id)) return false
    seen.add(message_id)
    order.push(message_id)
    if (order.length > DEDUP_LIMIT) {
      const oldest = order.shift()
      if (oldest) seen.delete(oldest)
    }
    return true
  }
}

export declare namespace ConversationLedger {
  export interface Service {
    readonly dedup: (message_id: string) => Effect.Effect<boolean>
    readonly getOffset: (source_id: string) => Effect.Effect<Option.Option<string>, DatabaseError>
    readonly setOffset: (source_id: string, message_id: string) => Effect.Effect<void, DatabaseError>
  }
}

export class ConversationLedger extends Context.Tag("@discord/conversation/ConversationLedger")<
  ConversationLedger,
  ConversationLedger.Service
>() {
  static readonly noop = Layer.sync(ConversationLedger, () => {
    const check = makeDedupSet()
    return ConversationLedger.of({
      dedup: (message_id) => Effect.sync(() => check(message_id)),
      getOffset: () => Effect.succeed(Option.none()),
      setOffset: () => Effect.void,
    })
  })

  static readonly layer = Layer.effect(
    ConversationLedger,
    Effect.gen(function* () {
      const sql = yield* SqliteDb
      yield* db(initializeSchema.pipe(Effect.provideService(Client.SqlClient, sql)))

      const check = makeDedupSet()

      const getOffset = Effect.fn("ConversationLedger.getOffset")(function* (source_id: string) {
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

      const setOffset = Effect.fn("ConversationLedger.setOffset")(function* (source_id: string, message_id: string) {
        yield* db(
          sql`INSERT INTO conversation_offsets (source_id, last_message_id, updated_at)
              VALUES (${source_id}, ${message_id}, CURRENT_TIMESTAMP)
              ON CONFLICT(source_id) DO UPDATE SET
                last_message_id = excluded.last_message_id,
                updated_at = CURRENT_TIMESTAMP`,
        )
      })

      return ConversationLedger.of({
        dedup: (message_id) => Effect.sync(() => check(message_id)),
        getOffset,
        setOffset,
      })
    }),
  )
}
