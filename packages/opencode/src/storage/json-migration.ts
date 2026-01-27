import { Database } from "bun:sqlite"
import { drizzle } from "drizzle-orm/bun-sqlite"
import { Global } from "../global"
import { Log } from "../util/log"
import { ProjectTable } from "../project/project.sql"
import { SessionTable, MessageTable, PartTable, TodoTable, PermissionTable } from "../session/session.sql"
import { SessionShareTable } from "../share/share.sql"
import path from "path"

export namespace JsonMigration {
  const log = Log.create({ service: "json-migration" })

  export async function run(sqlite: Database) {
    const storageDir = path.join(Global.Path.data, "storage")

    log.info("starting json to sqlite migration", { storageDir })

    const db = drizzle({ client: sqlite })
    const stats = {
      projects: 0,
      sessions: 0,
      messages: 0,
      parts: 0,
      todos: 0,
      permissions: 0,
      shares: 0,
      errors: [] as string[],
    }

    const limit = 32

    async function list(pattern: string) {
      const items: string[] = []
      const scan = new Bun.Glob(pattern)
      for await (const file of scan.scan({ cwd: storageDir, absolute: true })) {
        items.push(file)
      }
      return items
    }

    async function read(files: string[]) {
      const results = await Promise.allSettled(files.map((file) => Bun.file(file).json()))
      const items: { file: string; data: any }[] = []
      for (let i = 0; i < results.length; i++) {
        const result = results[i]
        const file = files[i]
        if (result.status === "fulfilled") {
          items.push({ file, data: result.value })
          continue
        }
        stats.errors.push(`failed to read ${file}: ${result.reason}`)
      }
      return items
    }

    // Migrate projects first (no FK deps)
    const projectFiles = await list("project/*.json")
    for (let i = 0; i < projectFiles.length; i += limit) {
      const batch = await read(projectFiles.slice(i, i + limit))
      const values = [] as any[]
      for (const item of batch) {
        const data = item.data
        if (!data?.id) {
          stats.errors.push(`project missing id: ${item.file}`)
          continue
        }
        values.push({
          id: data.id,
          worktree: data.worktree ?? "/",
          vcs: data.vcs,
          name: data.name ?? undefined,
          icon_url: data.icon?.url,
          icon_color: data.icon?.color,
          time_created: data.time?.created ?? Date.now(),
          time_updated: data.time?.updated ?? Date.now(),
          time_initialized: data.time?.initialized,
          sandboxes: data.sandboxes ?? [],
        })
      }
      if (values.length === 0) continue
      try {
        db.insert(ProjectTable).values(values).onConflictDoNothing().run()
        stats.projects += values.length
      } catch (e) {
        stats.errors.push(`failed to migrate project batch: ${e}`)
      }
    }
    log.info("migrated projects", { count: stats.projects })

    const projectRows = db.select({ id: ProjectTable.id }).from(ProjectTable).all()
    const projectIds = new Set(projectRows.map((item) => item.id))

    // Migrate sessions (depends on projects)
    const sessionFiles = await list("session/*/*.json")
    for (let i = 0; i < sessionFiles.length; i += limit) {
      const batch = await read(sessionFiles.slice(i, i + limit))
      const values = [] as any[]
      for (const item of batch) {
        const data = item.data
        if (!data?.id || !data?.projectID) {
          stats.errors.push(`session missing id or projectID: ${item.file}`)
          continue
        }
        if (!projectIds.has(data.projectID)) {
          log.warn("skipping orphaned session", { sessionID: data.id, projectID: data.projectID })
          continue
        }
        values.push({
          id: data.id,
          project_id: data.projectID,
          parent_id: data.parentID ?? null,
          slug: data.slug ?? "",
          directory: data.directory ?? "",
          title: data.title ?? "",
          version: data.version ?? "",
          share_url: data.share?.url ?? null,
          summary_additions: data.summary?.additions ?? null,
          summary_deletions: data.summary?.deletions ?? null,
          summary_files: data.summary?.files ?? null,
          summary_diffs: data.summary?.diffs ?? null,
          revert_message_id: data.revert?.messageID ?? null,
          revert_part_id: data.revert?.partID ?? null,
          revert_snapshot: data.revert?.snapshot ?? null,
          revert_diff: data.revert?.diff ?? null,
          permission: data.permission ?? null,
          time_created: data.time?.created ?? Date.now(),
          time_updated: data.time?.updated ?? Date.now(),
          time_compacting: data.time?.compacting ?? null,
          time_archived: data.time?.archived ?? null,
        })
      }
      if (values.length === 0) continue
      try {
        db.insert(SessionTable).values(values).onConflictDoNothing().run()
        stats.sessions += values.length
      } catch (e) {
        stats.errors.push(`failed to migrate session batch: ${e}`)
      }
    }
    log.info("migrated sessions", { count: stats.sessions })

    const sessionRows = db.select({ id: SessionTable.id }).from(SessionTable).all()
    const sessionIds = new Set(sessionRows.map((item) => item.id))

    // Migrate messages + parts per session
    const sessionList = Array.from(sessionIds)
    for (let i = 0; i < sessionList.length; i += limit) {
      const batch = sessionList.slice(i, i + limit)
      await Promise.allSettled(
        batch.map(async (sessionID) => {
          const messageFiles = await list(`message/${sessionID}/*.json`)
          const messageIds = new Set<string>()
          for (let j = 0; j < messageFiles.length; j += limit) {
            const chunk = await read(messageFiles.slice(j, j + limit))
            const values = [] as any[]
            for (const item of chunk) {
              const data = item.data
              if (!data?.id) {
                stats.errors.push(`message missing id: ${item.file}`)
                continue
              }
              values.push({
                id: data.id,
                session_id: sessionID,
                created_at: data.time?.created ?? Date.now(),
                data,
              })
              messageIds.add(data.id)
            }
            if (values.length === 0) continue
            try {
              db.insert(MessageTable).values(values).onConflictDoNothing().run()
              stats.messages += values.length
            } catch (e) {
              stats.errors.push(`failed to migrate message batch: ${e}`)
            }
          }

          const messageList = Array.from(messageIds)
          for (let j = 0; j < messageList.length; j += limit) {
            const messageBatch = messageList.slice(j, j + limit)
            await Promise.allSettled(
              messageBatch.map(async (messageID) => {
                const partFiles = await list(`part/${messageID}/*.json`)
                for (let k = 0; k < partFiles.length; k += limit) {
                  const chunk = await read(partFiles.slice(k, k + limit))
                  const values = [] as any[]
                  for (const item of chunk) {
                    const data = item.data
                    if (!data?.id || !data?.messageID) {
                      stats.errors.push(`part missing id or messageID: ${item.file}`)
                      continue
                    }
                    values.push({
                      id: data.id,
                      message_id: data.messageID,
                      session_id: sessionID,
                      data,
                    })
                  }
                  if (values.length === 0) continue
                  try {
                    db.insert(PartTable).values(values).onConflictDoNothing().run()
                    stats.parts += values.length
                  } catch (e) {
                    stats.errors.push(`failed to migrate part batch: ${e}`)
                  }
                }
              }),
            )
          }
        }),
      )
    }
    log.info("migrated messages", { count: stats.messages })
    log.info("migrated parts", { count: stats.parts })

    // Migrate todos
    const todoFiles = await list("todo/*.json")
    for (let i = 0; i < todoFiles.length; i += limit) {
      const batch = await read(todoFiles.slice(i, i + limit))
      const values = [] as any[]
      for (const item of batch) {
        const data = item.data
        const sessionID = path.basename(item.file, ".json")
        if (!sessionIds.has(sessionID)) {
          log.warn("skipping orphaned todo", { sessionID })
          continue
        }
        if (!Array.isArray(data)) {
          stats.errors.push(`todo not an array: ${item.file}`)
          continue
        }
        for (let position = 0; position < data.length; position++) {
          const todo = data[position]
          if (!todo?.id || !todo?.content || !todo?.status || !todo?.priority) continue
          values.push({
            session_id: sessionID,
            id: todo.id,
            content: todo.content,
            status: todo.status,
            priority: todo.priority,
            position,
          })
        }
      }
      if (values.length === 0) continue
      try {
        db.insert(TodoTable).values(values).onConflictDoNothing().run()
        stats.todos += values.length
      } catch (e) {
        stats.errors.push(`failed to migrate todo batch: ${e}`)
      }
    }
    log.info("migrated todos", { count: stats.todos })

    // Migrate permissions
    const permFiles = await list("permission/*.json")
    for (let i = 0; i < permFiles.length; i += limit) {
      const batch = await read(permFiles.slice(i, i + limit))
      const values = [] as any[]
      for (const item of batch) {
        const data = item.data
        const projectID = path.basename(item.file, ".json")
        if (!projectIds.has(projectID)) {
          log.warn("skipping orphaned permission", { projectID })
          continue
        }
        values.push({ project_id: projectID, data })
      }
      if (values.length === 0) continue
      try {
        db.insert(PermissionTable).values(values).onConflictDoNothing().run()
        stats.permissions += values.length
      } catch (e) {
        stats.errors.push(`failed to migrate permission batch: ${e}`)
      }
    }
    log.info("migrated permissions", { count: stats.permissions })

    // Migrate session shares
    const shareFiles = await list("session_share/*.json")
    for (let i = 0; i < shareFiles.length; i += limit) {
      const batch = await read(shareFiles.slice(i, i + limit))
      const values = [] as any[]
      for (const item of batch) {
        const data = item.data
        const sessionID = path.basename(item.file, ".json")
        if (!sessionIds.has(sessionID)) {
          log.warn("skipping orphaned session_share", { sessionID })
          continue
        }
        if (!data?.id || !data?.secret || !data?.url) {
          stats.errors.push(`session_share missing id/secret/url: ${item.file}`)
          continue
        }
        values.push({ session_id: sessionID, id: data.id, secret: data.secret, url: data.url })
      }
      if (values.length === 0) continue
      try {
        db.insert(SessionShareTable).values(values).onConflictDoNothing().run()
        stats.shares += values.length
      } catch (e) {
        stats.errors.push(`failed to migrate session_share batch: ${e}`)
      }
    }
    log.info("migrated session shares", { count: stats.shares })

    log.info("json migration complete", {
      projects: stats.projects,
      sessions: stats.sessions,
      messages: stats.messages,
      parts: stats.parts,
      todos: stats.todos,
      permissions: stats.permissions,
      shares: stats.shares,
      errorCount: stats.errors.length,
    })

    if (stats.errors.length > 0) {
      log.warn("migration errors", { errors: stats.errors.slice(0, 20) })
    }

    return stats
  }
}
