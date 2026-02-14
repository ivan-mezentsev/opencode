import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Reactivity } from "@effect/experimental"
import * as Client from "@effect/sql/SqlClient"
import { Context, Effect, Layer } from "effect"
import { AppConfig } from "../config"

export class SqliteDb extends Context.Tag("@discord/SqliteDb")<SqliteDb, Client.SqlClient>() {
  static readonly layer = Layer.scopedContext(
    Effect.gen(function* () {
      const config = yield* AppConfig
      const db = yield* SqliteClient.make({ filename: config.databasePath }).pipe(
        Effect.provide(Reactivity.layer),
      )
      yield* db`PRAGMA busy_timeout = 5000`
      return Context.empty().pipe(
        Context.add(SqliteDb, db),
        Context.add(Client.SqlClient, db),
      )
    }),
  ).pipe(Layer.orDie)
}
