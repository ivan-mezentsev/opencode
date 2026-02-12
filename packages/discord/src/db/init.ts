import type { Database } from "bun:sqlite"
import { getDb } from "./client"
import { logger } from "../observability/logger"

const PREFIX = "[db]"

export async function initializeDatabase(): Promise<void> {
  const db = getDb()

  db.exec(`CREATE TABLE IF NOT EXISTS discord_sessions (
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
  )`)

  addColumn(db, "preview_token", "TEXT")
  addColumn(db, "last_activity", "TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP")
  addColumn(db, "created_at", "TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP")
  addColumn(db, "updated_at", "TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP")
  addColumn(db, "pause_requested_at", "TEXT")
  addColumn(db, "paused_at", "TEXT")
  addColumn(db, "resume_attempted_at", "TEXT")
  addColumn(db, "resumed_at", "TEXT")
  addColumn(db, "destroyed_at", "TEXT")
  addColumn(db, "last_health_ok_at", "TEXT")
  addColumn(db, "last_error", "TEXT")
  addColumn(db, "resume_fail_count", "INTEGER NOT NULL DEFAULT 0")

  db.exec(`CREATE INDEX IF NOT EXISTS discord_sessions_status_last_activity_idx
    ON discord_sessions (status, last_activity)`)

  db.exec(`CREATE INDEX IF NOT EXISTS discord_sessions_status_updated_at_idx
    ON discord_sessions (status, updated_at)`)
}

function addColumn(db: Database, name: string, definition: string): void {
  if (hasColumn(db, name)) return
  db.exec(`ALTER TABLE discord_sessions ADD COLUMN ${name} ${definition}`)
}

function hasColumn(db: Database, name: string): boolean {
  const rows = db.query("PRAGMA table_info(discord_sessions)").all() as Array<{ name: string }>
  return rows.some((row) => row.name === name)
}

if (import.meta.main) {
  initializeDatabase()
    .then(() => {
      logger.info({ event: "db.schema.ready", component: "db", message: `${PREFIX} Schema is ready` })
    })
    .catch((err) => {
      logger.error({
        event: "db.schema.failed",
        component: "db",
        message: `${PREFIX} Failed to initialize schema`,
        error: err,
      })
      process.exit(1)
    })
}
