import { batch, createMemo } from "solid-js"
import { createStore, produce, reconcile } from "solid-js/store"
import { Binary } from "@opencode-ai/util/binary"
import { retry } from "@opencode-ai/util/retry"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { useGlobalSync } from "./global-sync"
import { useSDK } from "./sdk"
import type { Message, Part } from "@opencode-ai/sdk/v2/client"

function sortParts(parts: Part[]) {
  return parts.filter((part) => !!part?.id).sort((a, b) => cmp(a.id, b.id))
}

function runInflight(map: Map<string, Promise<void>>, key: string, task: () => Promise<void>) {
  const pending = map.get(key)
  if (pending) return pending
  const promise = task().finally(() => {
    map.delete(key)
  })
  map.set(key, promise)
  return promise
}

const keyFor = (directory: string, id: string) => `${directory}\n${id}`

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

type OptimisticStore = {
  message: Record<string, Message[] | undefined>
  part: Record<string, Part[] | undefined>
}

type OptimisticAddInput = {
  sessionID: string
  message: Message
  parts: Part[]
}

type OptimisticRemoveInput = {
  sessionID: string
  messageID: string
}

export function applyOptimisticAdd(draft: OptimisticStore, input: OptimisticAddInput) {
  const messages = draft.message[input.sessionID]
  if (!messages) {
    draft.message[input.sessionID] = [input.message]
  }
  if (messages) {
    const result = Binary.search(messages, input.message.id, (m) => m.id)
    messages.splice(result.index, 0, input.message)
  }
  draft.part[input.message.id] = sortParts(input.parts)
}

export function applyOptimisticRemove(draft: OptimisticStore, input: OptimisticRemoveInput) {
  const messages = draft.message[input.sessionID]
  if (messages) {
    const result = Binary.search(messages, input.messageID, (m) => m.id)
    if (result.found) messages.splice(result.index, 1)
  }
  delete draft.part[input.messageID]
}

function setOptimisticAdd(setStore: (...args: unknown[]) => void, input: OptimisticAddInput) {
  setStore("message", input.sessionID, (messages: Message[] | undefined) => {
    if (!messages) return [input.message]
    const result = Binary.search(messages, input.message.id, (m) => m.id)
    const next = [...messages]
    next.splice(result.index, 0, input.message)
    return next
  })
  setStore("part", input.message.id, sortParts(input.parts))
}

function setOptimisticRemove(setStore: (...args: unknown[]) => void, input: OptimisticRemoveInput) {
  setStore("message", input.sessionID, (messages: Message[] | undefined) => {
    if (!messages) return messages
    const result = Binary.search(messages, input.messageID, (m) => m.id)
    if (!result.found) return messages
    const next = [...messages]
    next.splice(result.index, 1)
    return next
  })
  setStore("part", (part: Record<string, Part[] | undefined>) => {
    if (!(input.messageID in part)) return part
    const next = { ...part }
    delete next[input.messageID]
    return next
  })
}

export const { use: useSync, provider: SyncProvider } = createSimpleContext({
  name: "Sync",
  init: () => {
    const globalSync = useGlobalSync()
    const sdk = useSDK()

    type Child = ReturnType<(typeof globalSync)["child"]>
    type Setter = Child[1]

    const current = createMemo(() => globalSync.child(sdk.directory))
    const target = (directory?: string) => {
      if (!directory || directory === sdk.directory) return current()
      return globalSync.child(directory)
    }
    const absolute = (path: string) => (current()[0].path.directory + "/" + path).replace("//", "/")
    const messagePageSize = 400
    const trimPageSize = 80
    const fullSessionLimit = 5
    const full = new Map<string, true>()
    const inflight = new Map<string, Promise<void>>()
    const inflightDiff = new Map<string, Promise<void>>()
    const inflightTodo = new Map<string, Promise<void>>()
    const [meta, setMeta] = createStore({
      limit: {} as Record<string, number>,
      complete: {} as Record<string, boolean>,
      loading: {} as Record<string, boolean>,
    })

    const touch = (key: string) => {
      if (full.has(key)) full.delete(key)
      full.set(key, true)
      while (full.size > fullSessionLimit) {
        const oldest = full.keys().next().value as string | undefined
        if (!oldest) return
        full.delete(oldest)
      }
    }

    const evict = (input: { directory: string; store: Child[0]; setStore: Setter; keep?: string }) => {
      const keep = new Set<string>()
      if (input.keep) keep.add(input.keep)
      for (const session of input.store.session) {
        if (session?.id) keep.add(session.id)
      }

      const warm = new Set<string>()
      for (const sessionID of keep) {
        if (full.has(keyFor(input.directory, sessionID))) warm.add(sessionID)
      }
      if (input.keep) warm.add(input.keep)

      const drop = new Set<string>()
      const trim = new Set<string>()
      for (const sessionID of Object.keys(input.store.message)) {
        if (!keep.has(sessionID)) {
          drop.add(sessionID)
          continue
        }
        if (!warm.has(sessionID)) trim.add(sessionID)
      }
      for (const sessionID of Object.keys(input.store.session_diff)) {
        if (!keep.has(sessionID) || !warm.has(sessionID)) drop.add(sessionID)
      }
      for (const sessionID of Object.keys(input.store.todo)) {
        if (!keep.has(sessionID) || !warm.has(sessionID)) drop.add(sessionID)
      }
      for (const sessionID of Object.keys(input.store.permission)) {
        if (!keep.has(sessionID)) drop.add(sessionID)
      }
      for (const sessionID of Object.keys(input.store.question)) {
        if (!keep.has(sessionID)) drop.add(sessionID)
      }
      for (const sessionID of Object.keys(input.store.session_status)) {
        if (!keep.has(sessionID)) drop.add(sessionID)
      }
      if (drop.size === 0 && trim.size === 0) return

      input.setStore(
        produce((draft) => {
          for (const sessionID of drop) {
            const messages = draft.message[sessionID]
            if (messages) {
              for (const message of messages) {
                const id = message?.id
                if (!id) continue
                delete draft.part[id]
              }
            }

            delete draft.message[sessionID]
            delete draft.session_diff[sessionID]
            delete draft.todo[sessionID]
            delete draft.permission[sessionID]
            delete draft.question[sessionID]
            delete draft.session_status[sessionID]
            full.delete(keyFor(input.directory, sessionID))
          }

          for (const sessionID of trim) {
            const messages = draft.message[sessionID]
            if (!messages) continue
            const count = messages.length - trimPageSize
            if (count <= 0) continue
            for (const message of messages.slice(0, count)) {
              const id = message?.id
              if (!id) continue
              delete draft.part[id]
            }
            draft.message[sessionID] = messages.slice(count)
          }
        }),
      )

      setMeta(
        produce((draft) => {
          for (const sessionID of drop) {
            const key = keyFor(input.directory, sessionID)
            delete draft.limit[key]
            delete draft.complete[key]
            delete draft.loading[key]
          }
          for (const sessionID of trim) {
            const key = keyFor(input.directory, sessionID)
            if (draft.limit[key] !== undefined && draft.limit[key] > trimPageSize) {
              draft.limit[key] = trimPageSize
            }
            if (draft.complete[key] !== undefined) {
              draft.complete[key] = false
            }
          }
        }),
      )
    }

    const getSession = (sessionID: string) => {
      const store = current()[0]
      const match = Binary.search(store.session, sessionID, (s) => s.id)
      if (match.found) return store.session[match.index]
      return undefined
    }

    const limitFor = (count: number) => {
      if (count <= messagePageSize) return messagePageSize
      return Math.ceil(count / messagePageSize) * messagePageSize
    }

    const fetchMessages = async (input: { client: typeof sdk.client; sessionID: string; limit: number }) => {
      const messages = await retry(() =>
        input.client.session.messages({ sessionID: input.sessionID, limit: input.limit }),
      )
      const items = (messages.data ?? []).filter((x) => !!x?.info?.id)
      const session = items
        .map((x) => x.info)
        .filter((m) => !!m?.id)
        .sort((a, b) => cmp(a.id, b.id))
      const part = items.map((message) => ({ id: message.info.id, part: sortParts(message.parts) }))
      return {
        session,
        part,
        complete: session.length < input.limit,
      }
    }

    const loadMessages = async (input: {
      directory: string
      client: typeof sdk.client
      setStore: Setter
      sessionID: string
      limit: number
    }) => {
      const key = keyFor(input.directory, input.sessionID)
      if (meta.loading[key]) return

      setMeta("loading", key, true)
      await fetchMessages(input)
        .then((next) => {
          batch(() => {
            input.setStore("message", input.sessionID, reconcile(next.session, { key: "id" }))
            for (const message of next.part) {
              input.setStore("part", message.id, reconcile(message.part, { key: "id" }))
            }
            setMeta("limit", key, input.limit)
            setMeta("complete", key, next.complete)
          })
        })
        .finally(() => {
          setMeta("loading", key, false)
        })
    }

    return {
      get data() {
        return current()[0]
      },
      get set(): Setter {
        return current()[1]
      },
      get status() {
        return current()[0].status
      },
      get ready() {
        return current()[0].status !== "loading"
      },
      get project() {
        const store = current()[0]
        const match = Binary.search(globalSync.data.project, store.project, (p) => p.id)
        if (match.found) return globalSync.data.project[match.index]
        return undefined
      },
      session: {
        get: getSession,
        optimistic: {
          add(input: { directory?: string; sessionID: string; message: Message; parts: Part[] }) {
            const [, setStore] = target(input.directory)
            setOptimisticAdd(setStore as (...args: unknown[]) => void, input)
          },
          remove(input: { directory?: string; sessionID: string; messageID: string }) {
            const [, setStore] = target(input.directory)
            setOptimisticRemove(setStore as (...args: unknown[]) => void, input)
          },
        },
        addOptimisticMessage(input: {
          sessionID: string
          messageID: string
          parts: Part[]
          agent: string
          model: { providerID: string; modelID: string }
        }) {
          const message: Message = {
            id: input.messageID,
            sessionID: input.sessionID,
            role: "user",
            time: { created: Date.now() },
            agent: input.agent,
            model: input.model,
          }
          const [, setStore] = target()
          setOptimisticAdd(setStore as (...args: unknown[]) => void, {
            sessionID: input.sessionID,
            message,
            parts: input.parts,
          })
        },
        async sync(sessionID: string) {
          const directory = sdk.directory
          const client = sdk.client
          const [store, setStore] = globalSync.child(directory)
          const key = keyFor(directory, sessionID)
          const hasSession = (() => {
            const match = Binary.search(store.session, sessionID, (s) => s.id)
            return match.found
          })()

          const hasMessages = store.message[sessionID] !== undefined
          const hydrated = meta.limit[key] !== undefined
          if (hasSession && hasMessages && hydrated && full.has(key)) {
            touch(key)
            evict({ directory, store, setStore, keep: sessionID })
            return
          }

          const count = store.message[sessionID]?.length ?? 0
          const limit = hydrated ? Math.max(meta.limit[key] ?? messagePageSize, messagePageSize) : limitFor(count)

          const sessionReq = hasSession
            ? Promise.resolve()
            : retry(() => client.session.get({ sessionID })).then((session) => {
                const data = session.data
                if (!data) return
                setStore(
                  "session",
                  produce((draft) => {
                    const match = Binary.search(draft, sessionID, (s) => s.id)
                    if (match.found) {
                      draft[match.index] = data
                      return
                    }
                    draft.splice(match.index, 0, data)
                  }),
                )
              })

          const messagesReq =
            hasMessages && hydrated && full.has(key)
              ? Promise.resolve()
              : loadMessages({
                  directory,
                  client,
                  setStore,
                  sessionID,
                  limit,
                })

          return runInflight(inflight, key, () =>
            Promise.all([sessionReq, messagesReq]).then(() => {
              touch(key)
              evict({ directory, store, setStore, keep: sessionID })
            }),
          )
        },
        async diff(sessionID: string) {
          const directory = sdk.directory
          const client = sdk.client
          const [store, setStore] = globalSync.child(directory)
          if (store.session_diff[sessionID] !== undefined) return

          const key = keyFor(directory, sessionID)
          return runInflight(inflightDiff, key, () =>
            retry(() => client.session.diff({ sessionID })).then((diff) => {
              setStore("session_diff", sessionID, reconcile(diff.data ?? [], { key: "file" }))
            }),
          )
        },
        async todo(sessionID: string) {
          const directory = sdk.directory
          const client = sdk.client
          const [store, setStore] = globalSync.child(directory)
          const existing = store.todo[sessionID]
          if (existing !== undefined) {
            if (globalSync.data.session_todo[sessionID] === undefined) {
              globalSync.todo.set(sessionID, existing)
            }
            return
          }

          const cached = globalSync.data.session_todo[sessionID]
          if (cached !== undefined) {
            setStore("todo", sessionID, reconcile(cached, { key: "id" }))
            return
          }

          const key = keyFor(directory, sessionID)
          return runInflight(inflightTodo, key, () =>
            retry(() => client.session.todo({ sessionID })).then((todo) => {
              const list = todo.data ?? []
              setStore("todo", sessionID, reconcile(list, { key: "id" }))
              globalSync.todo.set(sessionID, list)
            }),
          )
        },
        history: {
          more(sessionID: string) {
            const store = current()[0]
            const key = keyFor(sdk.directory, sessionID)
            if (store.message[sessionID] === undefined) return false
            if (meta.limit[key] === undefined) return false
            if (meta.complete[key]) return false
            return true
          },
          loading(sessionID: string) {
            const key = keyFor(sdk.directory, sessionID)
            return meta.loading[key] ?? false
          },
          async loadMore(sessionID: string, count = messagePageSize) {
            const directory = sdk.directory
            const client = sdk.client
            const [, setStore] = globalSync.child(directory)
            const key = keyFor(directory, sessionID)
            if (meta.loading[key]) return
            if (meta.complete[key]) return

            const currentLimit = meta.limit[key] ?? messagePageSize
            await loadMessages({
              directory,
              client,
              setStore,
              sessionID,
              limit: currentLimit + count,
            })
          },
        },
        fetch: async (count = 10) => {
          const directory = sdk.directory
          const client = sdk.client
          const [store, setStore] = globalSync.child(directory)
          setStore("limit", (x) => x + count)
          await client.session.list().then((x) => {
            const sessions = (x.data ?? [])
              .filter((s) => !!s?.id)
              .sort((a, b) => cmp(a.id, b.id))
              .slice(0, store.limit)
            setStore("session", reconcile(sessions, { key: "id" }))
          })
        },
        more: createMemo(() => current()[0].session.length >= current()[0].limit),
        archive: async (sessionID: string) => {
          const directory = sdk.directory
          const client = sdk.client
          const [, setStore] = globalSync.child(directory)
          await client.session.update({ sessionID, time: { archived: Date.now() } })
          setStore(
            produce((draft) => {
              const match = Binary.search(draft.session, sessionID, (s) => s.id)
              if (match.found) draft.session.splice(match.index, 1)
            }),
          )
        },
      },
      absolute,
      get directory() {
        return current()[0].path.directory
      },
    }
  },
})
