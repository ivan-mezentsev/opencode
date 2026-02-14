import { Reactivity } from "@effect/experimental"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import * as Migrator from "@effect/sql/Migrator"
import * as Client from "@effect/sql/SqlClient"
import { Effect } from "effect"
import migration0001 from "./migrations/0001_discord_sessions"

const run = Migrator.make({})({
  loader: Migrator.fromRecord({
    "0001_discord_sessions": migration0001,
  }),
})

export const initializeSchema = run

export const initializeSchemaForFile = (filename: string) =>
  SqliteClient.make({ filename }).pipe(
    Effect.provide(Reactivity.layer),
    Effect.flatMap((db) => run.pipe(Effect.provideService(Client.SqlClient, db))),
    Effect.scoped
  )
