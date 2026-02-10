// @refresh reload
import { webviewZoom } from "./webview-zoom"
import { render } from "solid-js/web"
import { AppBaseProviders, AppInterface, PlatformProvider, Platform, useCommand } from "@opencode-ai/app"
import { open, save } from "@tauri-apps/plugin-dialog"
import { getCurrent, onOpenUrl } from "@tauri-apps/plugin-deep-link"
import { openPath as openerOpenPath } from "@tauri-apps/plugin-opener"
import { open as shellOpen } from "@tauri-apps/plugin-shell"
import { type as ostype } from "@tauri-apps/plugin-os"
import { check, Update } from "@tauri-apps/plugin-updater"
import { getCurrentWindow } from "@tauri-apps/api/window"
import { isPermissionGranted, requestPermission } from "@tauri-apps/plugin-notification"
import { relaunch } from "@tauri-apps/plugin-process"
import { AsyncStorage } from "@solid-primitives/storage"
import { fetch as tauriFetch } from "@tauri-apps/plugin-http"
import { Store } from "@tauri-apps/plugin-store"
import { Splash } from "@opencode-ai/ui/logo"
import { createSignal, Show, Accessor, JSX, createResource, onMount, onCleanup, createEffect } from "solid-js"
import { readImage } from "@tauri-apps/plugin-clipboard-manager"
import { createStore } from "solid-js/store"
import { listen } from "@tauri-apps/api/event"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { TextField } from "@opencode-ai/ui/text-field"
import { Button } from "@opencode-ai/ui/button"

import { UPDATER_ENABLED } from "./updater"
import { initI18n, t } from "./i18n"
import pkg from "../package.json"
import "./styles.css"
import { commands, InitStep } from "./bindings"
import { Channel, invoke } from "@tauri-apps/api/core"
import { createMenu } from "./menu"

const root = document.getElementById("root")
if (import.meta.env.DEV && !(root instanceof HTMLElement)) {
  throw new Error(t("error.dev.rootNotFound"))
}

void initI18n()

const ssh = new Map<string, string>()
const auth = new Map<string, string>()

let base = null as string | null

type SshPrompt = { id: string; prompt: string }
const sshPromptEvent = "opencode:ssh-prompt"
const sshPrompts: SshPrompt[] = []

type DesktopPlatform = Platform & {
  serverKey: (url: string) => string
  isServerLocal: (url: string) => boolean
  sshConnect: (command: string) => Promise<{ url: string; key: string; password: string | null }>
  sshDisconnect: (key: string) => Promise<void>
  wsAuth: (url: string) => { username: string; password: string } | null
}

void listen<SshPrompt>("ssh_prompt", (event) => {
  sshPrompts.push(event.payload)
  window.dispatchEvent(new CustomEvent(sshPromptEvent))
}).catch((err) => {
  console.error("Failed to listen for ssh_prompt", err)
})

const isConfirmPrompt = (prompt: string) => {
  const text = prompt.toLowerCase()
  return text.includes("yes/no") || text.includes("continue connecting")
}

const isMaskedPrompt = (prompt: string) => {
  const text = prompt.toLowerCase()
  return (
    text.includes("password") ||
    text.includes("passphrase") ||
    text.includes("verification code") ||
    text.includes("one-time") ||
    text.includes("otp")
  )
}

let update: Update | null = null

const deepLinkEvent = "opencode:deep-link"

const emitDeepLinks = (urls: string[]) => {
  if (urls.length === 0) return
  window.__OPENCODE__ ??= {}
  const pending = window.__OPENCODE__.deepLinks ?? []
  window.__OPENCODE__.deepLinks = [...pending, ...urls]
  window.dispatchEvent(new CustomEvent(deepLinkEvent, { detail: { urls } }))
}

const listenForDeepLinks = async () => {
  const startUrls = await getCurrent().catch(() => null)
  if (startUrls?.length) emitDeepLinks(startUrls)
  await onOpenUrl((urls) => emitDeepLinks(urls)).catch(() => undefined)
}

const createPlatform = (
  password: Accessor<string | null>,
  sshState: { get: Accessor<boolean>; set: (value: boolean) => void },
): DesktopPlatform => ({
  platform: "desktop",
  os: (() => {
    const type = ostype()
    if (type === "macos" || type === "windows" || type === "linux") return type
    return undefined
  })(),
  version: pkg.version,

  async openDirectoryPickerDialog(opts) {
    const result = await open({
      directory: true,
      multiple: opts?.multiple ?? false,
      title: opts?.title ?? t("desktop.dialog.chooseFolder"),
    })
    return result
  },

  async openFilePickerDialog(opts) {
    const result = await open({
      directory: false,
      multiple: opts?.multiple ?? false,
      title: opts?.title ?? t("desktop.dialog.chooseFile"),
    })
    return result
  },

  async saveFilePickerDialog(opts) {
    const result = await save({
      title: opts?.title ?? t("desktop.dialog.saveFile"),
      defaultPath: opts?.defaultPath,
    })
    return result
  },

  openLink(url: string) {
    void shellOpen(url).catch(() => undefined)
  },

  openPath(path: string, app?: string) {
    return openerOpenPath(path, app)
  },

  back() {
    window.history.back()
  },

  forward() {
    window.history.forward()
  },

  storage: (() => {
    type StoreLike = {
      get(key: string): Promise<string | null | undefined>
      set(key: string, value: string): Promise<unknown>
      delete(key: string): Promise<unknown>
      clear(): Promise<unknown>
      keys(): Promise<string[]>
      length(): Promise<number>
    }

    const WRITE_DEBOUNCE_MS = 250

    const storeCache = new Map<string, Promise<StoreLike>>()
    const apiCache = new Map<string, AsyncStorage & { flush: () => Promise<void> }>()
    const memoryCache = new Map<string, StoreLike>()

    const flushAll = async () => {
      const apis = Array.from(apiCache.values())
      await Promise.all(apis.map((api) => api.flush().catch(() => undefined)))
    }

    if ("addEventListener" in globalThis) {
      const handleVisibility = () => {
        if (document.visibilityState !== "hidden") return
        void flushAll()
      }

      window.addEventListener("pagehide", () => void flushAll())
      document.addEventListener("visibilitychange", handleVisibility)
    }

    const createMemoryStore = () => {
      const data = new Map<string, string>()
      const store: StoreLike = {
        get: async (key) => data.get(key),
        set: async (key, value) => {
          data.set(key, value)
        },
        delete: async (key) => {
          data.delete(key)
        },
        clear: async () => {
          data.clear()
        },
        keys: async () => Array.from(data.keys()),
        length: async () => data.size,
      }
      return store
    }

    const getStore = (name: string) => {
      const cached = storeCache.get(name)
      if (cached) return cached

      const store = Store.load(name).catch(() => {
        const cached = memoryCache.get(name)
        if (cached) return cached

        const memory = createMemoryStore()
        memoryCache.set(name, memory)
        return memory
      })

      storeCache.set(name, store)
      return store
    }

    const createStorage = (name: string) => {
      const pending = new Map<string, string | null>()
      let timer: ReturnType<typeof setTimeout> | undefined
      let flushing: Promise<void> | undefined

      const flush = async () => {
        if (flushing) return flushing

        flushing = (async () => {
          const store = await getStore(name)
          while (pending.size > 0) {
            const batch = Array.from(pending.entries())
            pending.clear()
            for (const [key, value] of batch) {
              if (value === null) {
                await store.delete(key).catch(() => undefined)
              } else {
                await store.set(key, value).catch(() => undefined)
              }
            }
          }
        })().finally(() => {
          flushing = undefined
        })

        return flushing
      }

      const schedule = () => {
        if (timer) return
        timer = setTimeout(() => {
          timer = undefined
          void flush()
        }, WRITE_DEBOUNCE_MS)
      }

      const api: AsyncStorage & { flush: () => Promise<void> } = {
        flush,
        getItem: async (key: string) => {
          const next = pending.get(key)
          if (next !== undefined) return next

          const store = await getStore(name)
          const value = await store.get(key).catch(() => null)
          if (value === undefined) return null
          return value
        },
        setItem: async (key: string, value: string) => {
          pending.set(key, value)
          schedule()
        },
        removeItem: async (key: string) => {
          pending.set(key, null)
          schedule()
        },
        clear: async () => {
          pending.clear()
          const store = await getStore(name)
          await store.clear().catch(() => undefined)
        },
        key: async (index: number) => {
          const store = await getStore(name)
          return (await store.keys().catch(() => []))[index]
        },
        getLength: async () => {
          const store = await getStore(name)
          return await store.length().catch(() => 0)
        },
        get length() {
          return api.getLength()
        },
      }

      return api
    }

    return (name = "default.dat") => {
      const cached = apiCache.get(name)
      if (cached) return cached

      const api = createStorage(name)
      apiCache.set(name, api)
      return api
    }
  })(),

  checkUpdate: async () => {
    if (!UPDATER_ENABLED) return { updateAvailable: false }
    const next = await check().catch(() => null)
    if (!next) return { updateAvailable: false }
    const ok = await next
      .download()
      .then(() => true)
      .catch(() => false)
    if (!ok) return { updateAvailable: false }
    update = next
    return { updateAvailable: true, version: next.version }
  },

  update: async () => {
    if (!UPDATER_ENABLED || !update) return
    if (ostype() === "windows") await commands.killSidecar().catch(() => undefined)
    await update.install().catch(() => undefined)
  },

  restart: async () => {
    const keys = Array.from(new Set(ssh.values()))
    await Promise.all(keys.map((key) => invoke<void>("ssh_disconnect", { key }).catch(() => undefined)))
    await commands.killSidecar().catch(() => undefined)
    await relaunch()
  },

  notify: async (title, description, href) => {
    const granted = await isPermissionGranted().catch(() => false)
    const permission = granted ? "granted" : await requestPermission().catch(() => "denied")
    if (permission !== "granted") return

    const win = getCurrentWindow()
    const focused = await win.isFocused().catch(() => document.hasFocus())
    if (focused) return

    await Promise.resolve()
      .then(() => {
        const notification = new Notification(title, {
          body: description ?? "",
          icon: "https://opencode.ai/favicon-96x96-v3.png",
        })
        notification.onclick = () => {
          const win = getCurrentWindow()
          void win.show().catch(() => undefined)
          void win.unminimize().catch(() => undefined)
          void win.setFocus().catch(() => undefined)
          if (href) {
            window.history.pushState(null, "", href)
            window.dispatchEvent(new PopStateEvent("popstate"))
          }
          notification.close()
        }
      })
      .catch(() => undefined)
  },

  fetch: (input, init) => {
    if (typeof input === "string" && input.startsWith("/") && base) {
      input = base + input
    }

    const origin = (() => {
      try {
        const url = input instanceof Request ? input.url : String(input)
        return new URL(url).origin
      } catch {
        return null
      }
    })()

    const pw = origin ? (auth.get(origin) ?? null) : password()

    const addHeader = (headers: Headers, password: string) => {
      headers.append("Authorization", `Basic ${btoa(`opencode:${password}`)}`)
    }

    const logError = async (url: string, res: Response) => {
      if (res.ok) return
      // keep it minimal; enough to debug auth/baseUrl issues
      const text = await res
        .clone()
        .text()
        .catch(() => "")
      console.error("fetch failed", { url, status: res.status, statusText: res.statusText, body: text.slice(0, 400) })
    }

    if (input instanceof Request) {
      if (pw) addHeader(input.headers, pw)
      return tauriFetch(input).then((res) => {
        void logError(input.url, res)
        return res
      })
    } else {
      const headers = new Headers(init?.headers)
      if (pw) addHeader(headers, pw)
      const url = String(input)
      return tauriFetch(url, {
        ...(init as any),
        headers: headers,
      }).then((res) => {
        void logError(url, res)
        return res
      })
    }
  },

  getDefaultServerUrl: async () => {
    const result = await commands.getDefaultServerUrl().catch(() => null)
    return result
  },

  setDefaultServerUrl: async (url: string | null) => {
    await commands.setDefaultServerUrl(url)
  },

  serverKey: (url) => {
    const origin = (() => {
      try {
        return new URL(url).origin
      } catch {
        return ""
      }
    })()
    const key = origin ? ssh.get(origin) : undefined
    if (key) return `ssh:${key}`
    if (origin.includes("localhost") || origin.includes("127.0.0.1") || origin.includes("[::1]")) return "local"
    return url
  },

  isServerLocal: (url) => {
    const origin = (() => {
      try {
        return new URL(url).origin
      } catch {
        return null
      }
    })()
    if (origin && ssh.has(origin)) return false
    if (!origin) return false
    return origin.includes("localhost") || origin.includes("127.0.0.1") || origin.includes("[::1]")
  },

  sshConnect: async (command) => {
    sshState.set(true)
    try {
      const result = await invoke<{ key: string; url: string; password: string; destination: string }>("ssh_connect", {
        command,
      })
      const origin = new URL(result.url).origin
      ssh.set(origin, result.key)
      auth.set(origin, result.password)
      return { url: result.url, key: result.key, password: result.password }
    } finally {
      sshState.set(false)
    }
  },

  sshDisconnect: async (key) => {
    await invoke<void>("ssh_disconnect", { key })
    for (const [origin, k] of ssh.entries()) {
      if (k !== key) continue
      ssh.delete(origin)
      auth.delete(origin)
    }
  },

  wsAuth: (url) => {
    try {
      const origin = new URL(url).origin
      const pw = auth.get(origin) ?? password()
      if (!pw) return null
      return { username: "opencode", password: pw }
    } catch {
      return null
    }
  },

  parseMarkdown: (markdown: string) => commands.parseMarkdownCommand(markdown),

  webviewZoom,

  checkAppExists: async (appName: string) => {
    return commands.checkAppExists(appName)
  },

  async readClipboardImage() {
    const image = await readImage().catch(() => null)
    if (!image) return null
    const bytes = await image.rgba().catch(() => null)
    if (!bytes || bytes.length === 0) return null
    const size = await image.size().catch(() => null)
    if (!size) return null
    const canvas = document.createElement("canvas")
    canvas.width = size.width
    canvas.height = size.height
    const ctx = canvas.getContext("2d")
    if (!ctx) return null
    const imageData = ctx.createImageData(size.width, size.height)
    imageData.data.set(bytes)
    ctx.putImageData(imageData, 0, 0)
    return new Promise<File | null>((resolve) => {
      canvas.toBlob((blob) => {
        if (!blob) return resolve(null)
        resolve(new File([blob], `pasted-image-${Date.now()}.png`, { type: "image/png" }))
      }, "image/png")
    })
  },
})

let menuTrigger = null as null | ((id: string) => void)
createMenu((id) => {
  menuTrigger?.(id)
})
void listenForDeepLinks()

render(() => {
  const [serverPassword, setServerPassword] = createSignal<string | null>(null)
  const [sshConnecting, setSshConnecting] = createSignal(false)
  const platform = createPlatform(() => serverPassword(), { get: sshConnecting, set: setSshConnecting })

  function SshPromptDialog(props: {
    prompt: Accessor<string>
    pending: Accessor<boolean>
    onSubmit: (value: string) => void
    onCancel: () => void
  }) {
    const confirm = () => isConfirmPrompt(props.prompt())
    const masked = () => isMaskedPrompt(props.prompt())
    const [value, setValue] = createSignal("")

    return (
      <Dialog title="SSH" fit>
        <div class="flex flex-col gap-3 px-3 pb-3">
          <div class="text-14-regular text-text-base whitespace-pre-wrap px-1">{props.prompt()}</div>

          <Show when={!confirm()}>
            <TextField
              type={masked() ? "password" : "text"}
              hideLabel
              placeholder={masked() ? "Password" : "Response"}
              value={value()}
              autofocus
              disabled={props.pending()}
              onChange={(v) => setValue(v)}
              onKeyDown={(event: KeyboardEvent) => {
                event.stopPropagation()
                if (event.key === "Escape") {
                  event.preventDefault()
                  props.onCancel()
                  return
                }
                if (event.key !== "Enter" || event.isComposing) return
                event.preventDefault()
                props.onSubmit(value())
              }}
            />
          </Show>

          <div class="flex items-center justify-end gap-2">
            <Show
              when={confirm()}
              fallback={
                <>
                  <Button variant="secondary" onClick={props.onCancel} disabled={props.pending()}>
                    Cancel
                  </Button>
                  <Button variant="primary" onClick={() => props.onSubmit(value())} disabled={props.pending()}>
                    {props.pending() ? "Connecting..." : "Continue"}
                  </Button>
                </>
              }
            >
              <Button variant="secondary" onClick={() => props.onSubmit("no")} disabled={props.pending()}>
                No
              </Button>
              <Button variant="primary" onClick={() => props.onSubmit("yes")} disabled={props.pending()}>
                {props.pending() ? "Connecting..." : "Yes"}
              </Button>
            </Show>
          </div>
        </div>
      </Dialog>
    )
  }

  function SshPromptHandler(props: { connecting: Accessor<boolean> }) {
    const dialog = useDialog()
    const [store, setStore] = createStore({
      prompt: null as SshPrompt | null,
      pending: false,
      open: false,
    })

    const open = () => {
      if (store.open) return
      setStore("open", true)
      dialog.show(
        () => (
          <SshPromptDialog
            prompt={() => store.prompt?.prompt ?? ""}
            pending={() => store.pending}
            onSubmit={async (value) => {
              const current = store.prompt
              if (!current) return
              setStore({ pending: true })
              await invoke<void>("ssh_prompt_reply", { id: current.id, value }).catch((err) => {
                console.error("Failed to send ssh_prompt_reply", err)
              })
            }}
            onCancel={async () => {
              const current = store.prompt
              setStore({ pending: true })
              if (current) {
                await invoke<void>("ssh_prompt_reply", { id: current.id, value: "" }).catch((err) => {
                  console.error("Failed to send ssh_prompt_reply", err)
                })
              }
              close()
            }}
          />
        ),
        () => close(),
      )
    }

    const close = () => {
      if (!store.open) return
      dialog.close()
      setStore({ open: false, pending: false, prompt: null })
    }

    const showNext = () => {
      const next = sshPrompts.shift()
      if (!next) return
      setStore({ prompt: next, pending: false })
      open()
    }

    onMount(() => {
      const onPrompt = () => showNext()
      window.addEventListener(sshPromptEvent, onPrompt)
      showNext()
      onCleanup(() => {
        window.removeEventListener(sshPromptEvent, onPrompt)
      })
    })

    createEffect(() => {
      if (props.connecting()) return
      close()
    })

    return null
  }

  function handleClick(e: MouseEvent) {
    const link = (e.target as HTMLElement).closest("a.external-link") as HTMLAnchorElement | null
    if (link?.href) {
      e.preventDefault()
      platform.openLink(link.href)
    }
  }

  onMount(() => {
    document.addEventListener("click", handleClick)
    onCleanup(() => {
      document.removeEventListener("click", handleClick)
    })
  })

  return (
    <PlatformProvider value={platform}>
      <AppBaseProviders>
        <ServerGate>
          {(data) => {
            setServerPassword(data().password)
            try {
              const origin = new URL(data().url).origin
              base = origin
              const pw = data().password
              if (pw) auth.set(origin, pw)
              if (!pw) auth.delete(origin)
            } catch {
              // ignore
            }
            window.__OPENCODE__ ??= {}
            window.__OPENCODE__.serverPassword = data().password ?? undefined

            function Inner() {
              const cmd = useCommand()

              menuTrigger = (id) => cmd.trigger(id)

              return null
            }

            return (
              <>
                <AppInterface defaultUrl={data().url} isSidecar>
                  <Inner />
                  <SshPromptHandler connecting={() => sshConnecting()} />
                </AppInterface>
              </>
            )
          }}
        </ServerGate>
      </AppBaseProviders>
    </PlatformProvider>
  )
}, root!)

type ServerReadyData = { url: string; password: string | null }

// Gate component that waits for the server to be ready
function ServerGate(props: { children: (data: Accessor<ServerReadyData>) => JSX.Element }) {
  const [serverData] = createResource(() => commands.awaitInitialization(new Channel<InitStep>() as any))

  if (serverData.state === "errored") throw serverData.error

  return (
    // Not using suspense as not all components are compatible with it (undefined refs)
    <Show
      when={serverData.state !== "pending" && serverData()}
      fallback={
        <div class="h-screen w-screen flex flex-col items-center justify-center bg-background-base">
          <Splash class="w-16 h-20 opacity-50 animate-pulse" />
          <div data-tauri-decorum-tb class="flex flex-row absolute top-0 right-0 z-10 h-10" />
        </div>
      }
    >
      {(data) => props.children(data)}
    </Show>
  )
}
