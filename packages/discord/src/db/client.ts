import { Database } from "bun:sqlite"
import { getEnv } from "../config"

let _db: Database | null = null

export function getDb(): Database {
  if (!_db) {
    _db = new Database(getEnv().DATABASE_PATH, { create: true })
    _db.exec("PRAGMA journal_mode = WAL;")
    _db.exec("PRAGMA busy_timeout = 5000;")
  }
  return _db
}
