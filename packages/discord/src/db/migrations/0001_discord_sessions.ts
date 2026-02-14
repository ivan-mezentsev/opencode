import * as Client from "@effect/sql/SqlClient"
import { Effect } from "effect"

const TABLE = `CREATE TABLE IF NOT EXISTS discord_sessions (
  thread_id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  guild_id TEXT NOT NULL,
  sandbox_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  preview_url TEXT NOT NULL,
  preview_token TEXT,
  status TEXT NOT NULL CHECK (status IN ('creating', 'active', 'pausing', 'paused', 'resuming', 'destroying', 'destroyed', 'error')),
  last_activity TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  pause_requested_at TEXT,
  paused_at TEXT,
  resume_attempted_at TEXT,
  resumed_at TEXT,
  destroyed_at TEXT,
  last_health_ok_at TEXT,
  last_error TEXT,
  resume_fail_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)`

const OFFSETS_TABLE = `CREATE TABLE IF NOT EXISTS conversation_offsets (
  source_id TEXT PRIMARY KEY,
  last_message_id TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)`

const COLUMNS = [
  ["preview_token", "TEXT"],
  ["last_activity", "TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP"],
  ["created_at", "TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP"],
  ["updated_at", "TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP"],
  ["pause_requested_at", "TEXT"],
  ["paused_at", "TEXT"],
  ["resume_attempted_at", "TEXT"],
  ["resumed_at", "TEXT"],
  ["destroyed_at", "TEXT"],
  ["last_health_ok_at", "TEXT"],
  ["last_error", "TEXT"],
  ["resume_fail_count", "INTEGER NOT NULL DEFAULT 0"],
] as const

const OFFSET_COLUMNS = [
  ["last_message_id", "TEXT NOT NULL"],
  ["updated_at", "TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP"],
] as const

const INDEXES = [
  `CREATE INDEX IF NOT EXISTS discord_sessions_status_last_activity_idx
    ON discord_sessions (status, last_activity)`,
  `CREATE INDEX IF NOT EXISTS discord_sessions_status_updated_at_idx
    ON discord_sessions (status, updated_at)`,
] as const

const OFFSET_INDEXES = [
  `CREATE INDEX IF NOT EXISTS conversation_offsets_updated_at_idx
    ON conversation_offsets (updated_at)`,
] as const

export default Effect.gen(function* () {
  const db = yield* Client.SqlClient
  yield* db.unsafe(TABLE)
  yield* db.unsafe(OFFSETS_TABLE)

  const names = new Set((yield* db<{ name: string }>`PRAGMA table_info(discord_sessions)`).map((row) => row.name))
  const missing = COLUMNS.filter(([name]) => !names.has(name))
  yield* Effect.forEach(missing, ([name, definition]) => db.unsafe(`ALTER TABLE discord_sessions ADD COLUMN ${name} ${definition}`), {
    discard: true,
  })

  const offsetNames = new Set((yield* db<{ name: string }>`PRAGMA table_info(conversation_offsets)`).map((row) => row.name))
  const offsetMissing = OFFSET_COLUMNS.filter(([name]) => !offsetNames.has(name))
  yield* Effect.forEach(offsetMissing, ([name, definition]) => db.unsafe(`ALTER TABLE conversation_offsets ADD COLUMN ${name} ${definition}`), {
    discard: true,
  })

  yield* Effect.forEach(INDEXES, (index) => db.unsafe(index), { discard: true })
  yield* Effect.forEach(OFFSET_INDEXES, (index) => db.unsafe(index), { discard: true })
})
