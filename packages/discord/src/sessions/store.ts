import { getDb } from "../db/client"
import type { SessionInfo, SessionStatus } from "../types"

type SessionRow = {
  thread_id: string
  channel_id: string
  guild_id: string
  sandbox_id: string
  session_id: string
  preview_url: string
  preview_token: string | null
  status: SessionStatus
  last_error: string | null
  resume_fail_count: number
}

export interface SessionStore {
  upsert(session: SessionInfo): Promise<void>
  getByThread(threadId: string): Promise<SessionInfo | null>
  hasTrackedThread(threadId: string): Promise<boolean>
  getActive(threadId: string): Promise<SessionInfo | null>
  markActivity(threadId: string): Promise<void>
  markHealthOk(threadId: string): Promise<void>
  updateStatus(threadId: string, status: SessionStatus, lastError?: string | null): Promise<void>
  incrementResumeFailure(threadId: string, lastError: string): Promise<void>
  listActive(): Promise<SessionInfo[]>
  listStaleActive(cutoffMinutes: number): Promise<SessionInfo[]>
  listExpiredPaused(pausedTtlMinutes: number): Promise<SessionInfo[]>
}

class SqliteSessionStore implements SessionStore {
  private readonly db = getDb()

  async upsert(session: SessionInfo): Promise<void> {
    this.db
      .query(
        `
      INSERT INTO discord_sessions (
        thread_id,
        channel_id,
        guild_id,
        sandbox_id,
        session_id,
        preview_url,
        preview_token,
        status,
        last_error,
        last_activity,
        resumed_at,
        created_at,
        updated_at
      ) VALUES (
        ?,
        ?,
        ?,
        ?,
        ?,
        ?,
        ?,
        ?,
        ?,
        CURRENT_TIMESTAMP,
        CASE WHEN ? = 'active' THEN CURRENT_TIMESTAMP ELSE NULL END,
        CURRENT_TIMESTAMP,
        CURRENT_TIMESTAMP
      )
      ON CONFLICT(thread_id)
      DO UPDATE SET
        channel_id = excluded.channel_id,
        guild_id = excluded.guild_id,
        sandbox_id = excluded.sandbox_id,
        session_id = excluded.session_id,
        preview_url = excluded.preview_url,
        preview_token = excluded.preview_token,
        status = excluded.status,
        last_error = excluded.last_error,
        last_activity = CURRENT_TIMESTAMP,
        resumed_at = CASE WHEN excluded.status = 'active' THEN CURRENT_TIMESTAMP ELSE discord_sessions.resumed_at END,
        updated_at = CURRENT_TIMESTAMP
    `,
      )
      .run(
        session.threadId,
        session.channelId,
        session.guildId,
        session.sandboxId,
        session.sessionId,
        session.previewUrl,
        session.previewToken,
        session.status,
        session.lastError ?? null,
        session.status,
      )
  }

  async getByThread(threadId: string): Promise<SessionInfo | null> {
    const row = this.db
      .query(
        `
      SELECT
        thread_id,
        channel_id,
        guild_id,
        sandbox_id,
        session_id,
        preview_url,
        preview_token,
        status,
        last_error,
        resume_fail_count
      FROM discord_sessions
      WHERE thread_id = ?
      LIMIT 1
    `,
      )
      .get(threadId) as SessionRow | null

    if (!row) return null
    return toSessionInfo(row)
  }

  async hasTrackedThread(threadId: string): Promise<boolean> {
    const row = this.db
      .query(
        `
      SELECT thread_id
      FROM discord_sessions
      WHERE thread_id = ?
      LIMIT 1
    `,
      )
      .get(threadId) as { thread_id: string } | null

    return Boolean(row)
  }

  async getActive(threadId: string): Promise<SessionInfo | null> {
    const row = this.db
      .query(
        `
      SELECT
        thread_id,
        channel_id,
        guild_id,
        sandbox_id,
        session_id,
        preview_url,
        preview_token,
        status,
        last_error,
        resume_fail_count
      FROM discord_sessions
      WHERE thread_id = ?
        AND status = 'active'
      LIMIT 1
    `,
      )
      .get(threadId) as SessionRow | null

    if (!row) return null
    return toSessionInfo(row)
  }

  async markActivity(threadId: string): Promise<void> {
    this.db
      .query(
        `
      UPDATE discord_sessions
      SET last_activity = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE thread_id = ?
    `,
      )
      .run(threadId)
  }

  async markHealthOk(threadId: string): Promise<void> {
    this.db
      .query(
        `
      UPDATE discord_sessions
      SET last_health_ok_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE thread_id = ?
    `,
      )
      .run(threadId)
  }

  async updateStatus(threadId: string, status: SessionStatus, lastError?: string | null): Promise<void> {
    this.db
      .query(
        `
      UPDATE discord_sessions
      SET
        status = ?,
        last_error = ?,
        pause_requested_at = CASE WHEN ? = 'pausing' THEN CURRENT_TIMESTAMP ELSE pause_requested_at END,
        paused_at = CASE WHEN ? = 'paused' THEN CURRENT_TIMESTAMP ELSE paused_at END,
        resume_attempted_at = CASE WHEN ? = 'resuming' THEN CURRENT_TIMESTAMP ELSE resume_attempted_at END,
        resumed_at = CASE WHEN ? = 'active' THEN CURRENT_TIMESTAMP ELSE resumed_at END,
        destroyed_at = CASE WHEN ? = 'destroyed' THEN CURRENT_TIMESTAMP ELSE destroyed_at END,
        updated_at = CURRENT_TIMESTAMP
      WHERE thread_id = ?
    `,
      )
      .run(status, lastError ?? null, status, status, status, status, status, threadId)
  }

  async incrementResumeFailure(threadId: string, lastError: string): Promise<void> {
    this.db
      .query(
        `
      UPDATE discord_sessions
      SET
        resume_fail_count = resume_fail_count + 1,
        last_error = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE thread_id = ?
    `,
      )
      .run(lastError, threadId)
  }

  async listActive(): Promise<SessionInfo[]> {
    const rows = this.db
      .query(
        `
      SELECT
        thread_id,
        channel_id,
        guild_id,
        sandbox_id,
        session_id,
        preview_url,
        preview_token,
        status,
        last_error,
        resume_fail_count
      FROM discord_sessions
      WHERE status = 'active'
      ORDER BY last_activity DESC
    `,
      )
      .all() as SessionRow[]

    return rows.map(toSessionInfo)
  }

  async listStaleActive(cutoffMinutes: number): Promise<SessionInfo[]> {
    const rows = this.db
      .query(
        `
      SELECT
        thread_id,
        channel_id,
        guild_id,
        sandbox_id,
        session_id,
        preview_url,
        preview_token,
        status,
        last_error,
        resume_fail_count
      FROM discord_sessions
      WHERE status = 'active'
        AND last_activity < datetime('now', '-' || ? || ' minutes')
      ORDER BY last_activity ASC
    `,
      )
      .all(cutoffMinutes) as SessionRow[]

    return rows.map(toSessionInfo)
  }

  async listExpiredPaused(pausedTtlMinutes: number): Promise<SessionInfo[]> {
    const rows = this.db
      .query(
        `
      SELECT
        thread_id,
        channel_id,
        guild_id,
        sandbox_id,
        session_id,
        preview_url,
        preview_token,
        status,
        last_error,
        resume_fail_count
      FROM discord_sessions
      WHERE status = 'paused'
        AND paused_at IS NOT NULL
        AND paused_at < datetime('now', '-' || ? || ' minutes')
      ORDER BY paused_at ASC
    `,
      )
      .all(pausedTtlMinutes) as SessionRow[]

    return rows.map(toSessionInfo)
  }
}

function toSessionInfo(row: SessionRow): SessionInfo {
  return {
    threadId: row.thread_id,
    channelId: row.channel_id,
    guildId: row.guild_id,
    sandboxId: row.sandbox_id,
    sessionId: row.session_id,
    previewUrl: row.preview_url,
    previewToken: row.preview_token,
    status: row.status,
    lastError: row.last_error,
    resumeFailCount: row.resume_fail_count,
  }
}

const sessionStore: SessionStore = new SqliteSessionStore()

export function getSessionStore(): SessionStore {
  return sessionStore
}
