import type { TuiPlugin as TuiPluginFn, TuiPluginInput } from "@opencode-ai/plugin"
import { Config } from "@/config/config"
import { TuiConfig } from "@/config/tui"
import { Log } from "@/util/log"
import { BunProc } from "@/bun"
import { Instance } from "@/project/instance"
import { registerThemes } from "./context/theme"
import { existsSync } from "fs"

export namespace TuiPlugin {
  const log = Log.create({ service: "tui.plugin" })
  let loaded: Promise<void> | undefined

  export async function init(input: TuiPluginInput) {
    if (loaded) return loaded
    loaded = load(input)
    return loaded
  }

  async function load(input: TuiPluginInput) {
    const base = input.directory ?? process.cwd()
    const dir = existsSync(base) ? base : process.cwd()
    if (dir !== base) {
      log.info("tui plugin directory not found, using local cwd", { requested: base, directory: dir })
    }
    await Instance.provide({
      directory: dir,
      fn: async () => {
        const config = await TuiConfig.get()
        const plugins = config.plugin ?? []
        if (plugins.length) await TuiConfig.waitForDependencies()

        async function resolve(spec: string) {
          if (spec.startsWith("file://")) return spec
          const lastAtIndex = spec.lastIndexOf("@")
          const pkg = lastAtIndex > 0 ? spec.substring(0, lastAtIndex) : spec
          const version = lastAtIndex > 0 ? spec.substring(lastAtIndex + 1) : "latest"
          return BunProc.install(pkg, version)
        }

        for (const item of plugins) {
          const spec = Config.pluginSpecifier(item)
          log.info("loading tui plugin", { path: spec })
          const path = await resolve(spec)
          const mod = await import(path)
          const seen = new Set<unknown>()
          for (const [_name, entry] of Object.entries(mod)) {
            if (seen.has(entry)) continue
            seen.add(entry)
            const themes = (() => {
              if (!entry || typeof entry !== "object") return
              if (!("themes" in entry)) return
              if (!entry.themes || typeof entry.themes !== "object") return
              return entry.themes as Record<string, unknown>
            })()
            if (themes) registerThemes(themes)
            const tui = (() => {
              if (typeof entry === "function") return
              if (!entry || typeof entry !== "object") return
              if ("tui" in entry && typeof entry.tui === "function") return entry.tui as TuiPluginFn
              return
            })()
            if (!tui) continue
            await tui(input, Config.pluginOptions(item))
          }
        }
      },
    }).catch((error) => {
      log.error("failed to load tui plugins", { directory: dir, error })
    })
  }
}
