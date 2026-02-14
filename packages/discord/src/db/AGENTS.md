# Database Module

SQLite via `@effect/sql-sqlite-bun` with Effect's `Migrator` system.

## SqliteDb Tag — Not Just SqlClient

`SqliteDb` (`client.ts`) is a custom `Context.Tag` wrapping `Client.SqlClient`. It's NOT a direct re-export. The layer:

1. Uses `Layer.unwrapEffect` to read `AppConfig.databasePath` at construction time
2. Provides `SqliteClient.layer({ filename })` underneath
3. Sets `PRAGMA busy_timeout = 5000` on initialization

This means `SqliteDb` is what services depend on, not raw `Client.SqlClient`.

## Migration System

Uses `@effect/sql/Migrator` with `Migrator.fromRecord` (not file-based).
Migrations are imported as modules in `init.ts` and keyed by name.

Each migration is idempotent:

- `CREATE TABLE IF NOT EXISTS`
- Checks existing columns via `PRAGMA table_info(...)`, only adds missing ones via `ALTER TABLE`
- Creates indexes with `IF NOT EXISTS`

## Schema Initialization at Service Level

`initializeSchema` is called by BOTH `SessionStore.layer` and `ConversationLedger.layer` individually. It's idempotent, but this means schema init runs multiple times — once per service that needs the DB. The pattern is:

```ts
yield * db(initializeSchema.pipe(Effect.provideService(Client.SqlClient, sql)))
```

Note: `initializeSchema` needs `Client.SqlClient` in its requirements, so each caller provides it manually.

## SqlSchema Typed Queries

`SessionStore` uses `@effect/sql`'s `SqlSchema` module for type-safe queries:

- `SqlSchema.void({ Request, execute })` — for writes (insert/update)
- `SqlSchema.findOne({ Request, Result, execute })` — returns `Option<Result>`
- `SqlSchema.findAll({ Request, Result, execute })` — returns `ReadonlyArray<Result>`

The `Request` and `Result` schemas handle encode/decode automatically. Column aliasing (`thread_id AS threadId`) maps snake_case DB columns to camelCase TS fields.

## Adding a New Migration

1. Create `src/db/migrations/NNNN_name.ts` exporting a default `Effect.gen` that uses `yield* Client.SqlClient`
2. Import and register it in `src/db/init.ts` in the `Migrator.fromRecord({...})` call
3. Both files must change together

## Status Timestamp Pattern

`SessionStore` uses a dynamic `statusSet` helper that updates status-specific timestamp columns (`paused_at`, `resumed_at`, etc.) based on the new status value — a single UPDATE touches the right column via CASE expressions.
