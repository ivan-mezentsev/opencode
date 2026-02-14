import * as Client from "@effect/sql/SqlClient"
import * as SqlSchema from "@effect/sql/SqlSchema"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { SqliteDb } from "../db/client"
import { initializeSchema } from "../db/init"
import { DatabaseError } from "../errors"
import { ChannelId, GuildId, SandboxId, SessionId, SessionInfo, SessionStatus, ThreadId } from "../types"

const ROW = `thread_id AS threadId, channel_id AS channelId, guild_id AS guildId, sandbox_id AS sandboxId, session_id AS sessionId,
  preview_url AS previewUrl, preview_token AS previewToken, status, last_error AS lastError, resume_fail_count AS resumeFailCount`

class Write extends Schema.Class<Write>("Write")({
  thread_id: ThreadId,
  channel_id: ChannelId,
  guild_id: GuildId,
  sandbox_id: SandboxId,
  session_id: SessionId,
  preview_url: Schema.String,
  preview_token: Schema.Union(Schema.Null, Schema.String),
  status: SessionStatus,
  last_error: Schema.Union(Schema.Null, Schema.String),
}) {}

const Thread = Schema.Struct({ thread_id: ThreadId })
const Status = Schema.Struct({
  thread_id: ThreadId,
  status: SessionStatus,
  last_error: Schema.Union(Schema.Null, Schema.String),
})
const Resume = Schema.Struct({ thread_id: ThreadId, last_error: Schema.String })
const Minutes = Schema.Struct({ minutes: Schema.Number })

const STATUS_COLUMNS = [
  ["pausing", "pause_requested_at"],
  ["paused", "paused_at"],
  ["resuming", "resume_attempted_at"],
  ["active", "resumed_at"],
  ["destroyed", "destroyed_at"],
] as const

const toWrite = (session: SessionInfo) =>
  Write.make({
    thread_id: session.threadId,
    channel_id: session.channelId,
    guild_id: session.guildId,
    sandbox_id: session.sandboxId,
    session_id: session.sessionId,
    preview_url: session.previewUrl,
    preview_token: session.previewToken,
    status: session.status,
    last_error: session.lastError,
  })

export declare namespace SessionStore {
  export interface Service {
    readonly upsert: (session: SessionInfo) => Effect.Effect<void, DatabaseError>
    readonly getByThread: (threadId: ThreadId) => Effect.Effect<Option.Option<SessionInfo>, DatabaseError>
    readonly hasTrackedThread: (threadId: ThreadId) => Effect.Effect<boolean, DatabaseError>
    readonly getActive: (threadId: ThreadId) => Effect.Effect<Option.Option<SessionInfo>, DatabaseError>
    readonly markActivity: (threadId: ThreadId) => Effect.Effect<void, DatabaseError>
    readonly markHealthOk: (threadId: ThreadId) => Effect.Effect<void, DatabaseError>
    readonly updateStatus: (threadId: ThreadId, status: SessionStatus, lastError?: string | null) => Effect.Effect<void, DatabaseError>
    readonly incrementResumeFailure: (threadId: ThreadId, lastError: string) => Effect.Effect<void, DatabaseError>
    readonly listActive: () => Effect.Effect<ReadonlyArray<SessionInfo>, DatabaseError>
    readonly listTrackedThreads: () => Effect.Effect<ReadonlyArray<ThreadId>, DatabaseError>
    readonly listStaleActive: (cutoffMinutes: number) => Effect.Effect<ReadonlyArray<SessionInfo>, DatabaseError>
    readonly listExpiredPaused: (pausedTtlMinutes: number) => Effect.Effect<ReadonlyArray<SessionInfo>, DatabaseError>
  }
}

export class SessionStore extends Context.Tag("@discord/SessionStore")<SessionStore, SessionStore.Service>() {
  static readonly layer = Layer.effect(
    SessionStore,
    Effect.gen(function* () {
      const sql = yield* SqliteDb
      const db = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(Effect.mapError((cause) => new DatabaseError({ cause })))

      yield* db(initializeSchema.pipe(Effect.provideService(Client.SqlClient, sql)))

      const statusSet = (status: SessionStatus) =>
        sql.join(",\n", false)(STATUS_COLUMNS.map(([value, column]) =>
          sql`${sql(column)} = CASE WHEN ${status} = ${value} THEN CURRENT_TIMESTAMP ELSE ${sql(column)} END`
        ))

      const touch = (column: "last_activity" | "last_health_ok_at") =>
        SqlSchema.void({
          Request: Thread,
          execute: ({ thread_id }) =>
            sql`UPDATE discord_sessions
                SET ${sql(column)} = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
                WHERE thread_id = ${thread_id}`,
        })

      const upsertQ = SqlSchema.void({
        Request: Write,
        execute: (session) =>
          sql`INSERT INTO discord_sessions (
              thread_id, channel_id, guild_id, sandbox_id, session_id,
              preview_url, preview_token, status, last_error,
              last_activity, resumed_at, created_at, updated_at
            ) VALUES (
              ${session.thread_id}, ${session.channel_id}, ${session.guild_id}, ${session.sandbox_id}, ${session.session_id},
              ${session.preview_url}, ${session.preview_token}, ${session.status}, ${session.last_error},
              CURRENT_TIMESTAMP,
              CASE WHEN ${session.status} = 'active' THEN CURRENT_TIMESTAMP ELSE NULL END,
              CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
            )
            ON CONFLICT(thread_id) DO UPDATE SET
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
              updated_at = CURRENT_TIMESTAMP`,
      })

      const byThreadQ = SqlSchema.findOne({
        Request: Thread,
        Result: SessionInfo,
        execute: ({ thread_id }) => sql`SELECT ${sql.literal(ROW)} FROM discord_sessions WHERE thread_id = ${thread_id} LIMIT 1`,
      })

      const activeQ = SqlSchema.findOne({
        Request: Thread,
        Result: SessionInfo,
        execute: ({ thread_id }) =>
          sql`SELECT ${sql.literal(ROW)} FROM discord_sessions WHERE thread_id = ${thread_id} AND status = 'active' LIMIT 1`,
      })

      const markActivityQ = touch("last_activity")

      const markHealthOkQ = touch("last_health_ok_at")

      const updateStatusQ = SqlSchema.void({
        Request: Status,
        execute: ({ thread_id, status, last_error }) =>
          sql`UPDATE discord_sessions SET
              status = ${status}, last_error = ${last_error},
              ${statusSet(status)},
              updated_at = CURRENT_TIMESTAMP
              WHERE thread_id = ${thread_id}`,
      })

      const incrementResumeFailureQ = SqlSchema.void({
        Request: Resume,
        execute: ({ thread_id, last_error }) =>
          sql`UPDATE discord_sessions SET
              resume_fail_count = resume_fail_count + 1, last_error = ${last_error}, updated_at = CURRENT_TIMESTAMP
              WHERE thread_id = ${thread_id}`,
      })

      const listActiveQ = SqlSchema.findAll({
        Request: Schema.Void,
        Result: SessionInfo,
        execute: () =>
          sql`SELECT ${sql.literal(ROW)}
              FROM discord_sessions
              WHERE status = 'active'
              ORDER BY last_activity DESC`,
      })

      const listTrackedThreadsQ = SqlSchema.findAll({
        Request: Schema.Void,
        Result: Schema.Struct({ threadId: ThreadId }),
        execute: () =>
          sql`SELECT thread_id AS threadId
              FROM discord_sessions
              WHERE status != 'destroyed'
              ORDER BY updated_at DESC`,
      })

      const listStaleActiveQ = SqlSchema.findAll({
        Request: Minutes,
        Result: SessionInfo,
        execute: ({ minutes }) =>
          sql`SELECT ${sql.literal(ROW)}
              FROM discord_sessions
              WHERE status = 'active' AND last_activity < datetime('now', '-' || ${minutes} || ' minutes')
              ORDER BY last_activity ASC`,
      })

      const listExpiredPausedQ = SqlSchema.findAll({
        Request: Minutes,
        Result: SessionInfo,
        execute: ({ minutes }) =>
          sql`SELECT ${sql.literal(ROW)}
              FROM discord_sessions
              WHERE status = 'paused' AND paused_at IS NOT NULL
                AND paused_at < datetime('now', '-' || ${minutes} || ' minutes')
              ORDER BY paused_at ASC`,
      })

      const upsert = Effect.fn("SessionStore.upsert")(function* (session: SessionInfo) {
        yield* db(upsertQ(toWrite(session)))
      })

      const getByThread = Effect.fn("SessionStore.getByThread")(function* (threadId: ThreadId) {
        return yield* db(byThreadQ({ thread_id: threadId }))
      })

      const hasTrackedThread = Effect.fn("SessionStore.hasTrackedThread")(function* (threadId: ThreadId) {
        const row = yield* db(byThreadQ({ thread_id: threadId }))
        return Option.isSome(row)
      })

      const getActive = Effect.fn("SessionStore.getActive")(function* (threadId: ThreadId) {
        return yield* db(activeQ({ thread_id: threadId }))
      })

      const markActivity = Effect.fn("SessionStore.markActivity")(function* (threadId: ThreadId) {
        yield* db(markActivityQ({ thread_id: threadId }))
      })

      const markHealthOk = Effect.fn("SessionStore.markHealthOk")(function* (threadId: ThreadId) {
        yield* db(markHealthOkQ({ thread_id: threadId }))
      })

      const updateStatus = Effect.fn("SessionStore.updateStatus")(function* (threadId: ThreadId, status: SessionStatus, lastError?: string | null) {
        yield* db(updateStatusQ({ thread_id: threadId, status, last_error: lastError ?? null }))
      })

      const incrementResumeFailure = Effect.fn("SessionStore.incrementResumeFailure")(function* (threadId: ThreadId, lastError: string) {
        yield* db(incrementResumeFailureQ({ thread_id: threadId, last_error: lastError }))
      })

      const listActive = Effect.fn("SessionStore.listActive")(function* () {
        return yield* db(listActiveQ(undefined))
      })

      const listTrackedThreads = Effect.fn("SessionStore.listTrackedThreads")(function* () {
        return (yield* db(listTrackedThreadsQ(undefined))).map((row) => row.threadId)
      })

      const listStaleActive = Effect.fn("SessionStore.listStaleActive")(function* (cutoffMinutes: number) {
        return yield* db(listStaleActiveQ({ minutes: cutoffMinutes }))
      })

      const listExpiredPaused = Effect.fn("SessionStore.listExpiredPaused")(function* (pausedTtlMinutes: number) {
        return yield* db(listExpiredPausedQ({ minutes: pausedTtlMinutes }))
      })

      return SessionStore.of({
        upsert,
        getByThread,
        hasTrackedThread,
        getActive,
        markActivity,
        markHealthOk,
        updateStatus,
        incrementResumeFailure,
        listActive,
        listTrackedThreads,
        listStaleActive,
        listExpiredPaused,
      })
    }),
  )

  static readonly defaultLayer = SessionStore.layer.pipe(
    Layer.provide(SqliteDb.layer),
  )
}
