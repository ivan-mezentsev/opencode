import path from "path"
import { existsSync } from "fs"
import z from "zod"
import { parse as parseJsonc } from "jsonc-parser"
import { mergeDeep, unique } from "remeda"
import { Config } from "./config"
import { ConfigPaths } from "./paths"
import { Instance } from "@/project/instance"
import { Flag } from "@/flag/flag"
import { Log } from "@/util/log"
import { Global } from "@/global"

export namespace TuiConfig {
  const log = Log.create({ service: "tui.config" })

  export const Info = z
    .object({
      $schema: z.string().optional(),
      theme: z.string().optional(),
      keybinds: Config.Keybinds.optional(),
      tui: Config.TUI.optional(),
      plugin: z.array(z.union([z.string(), z.tuple([z.string(), z.record(z.string(), z.unknown())])])).optional(),
    })
    .strict()

  export type Info = z.output<typeof Info>

  function mergeInfo(target: Info, source: Info): Info {
    const merged = mergeDeep(target, source)
    if (target.plugin && source.plugin) {
      merged.plugin = [...target.plugin, ...source.plugin]
    }
    return merged
  }

  function customPath() {
    if (!Flag.OPENCODE_CONFIG) return
    const file = path.basename(Flag.OPENCODE_CONFIG)
    if (file === "tui.json" || file === "tui.jsonc") return Flag.OPENCODE_CONFIG
    if (file === "opencode.jsonc") return path.join(path.dirname(Flag.OPENCODE_CONFIG), "tui.jsonc")
    return path.join(path.dirname(Flag.OPENCODE_CONFIG), "tui.json")
  }

  const state = Instance.state(async () => {
    let projectFiles = Flag.OPENCODE_DISABLE_PROJECT_CONFIG
      ? []
      : await ConfigPaths.projectFiles("tui", Instance.directory, Instance.worktree)
    const directories = await ConfigPaths.directories(Instance.directory, Instance.worktree)
    const custom = customPath()
    const managed = Config.managedConfigDir()
    await migrateFromOpencode({ projectFiles, directories, custom, managed })
    projectFiles = Flag.OPENCODE_DISABLE_PROJECT_CONFIG
      ? []
      : await ConfigPaths.projectFiles("tui", Instance.directory, Instance.worktree)

    let result: Info = {}

    for (const file of ConfigPaths.fileInDirectory(Global.Path.config, "tui")) {
      result = mergeInfo(result, await loadFile(file))
    }

    if (custom) {
      result = mergeInfo(result, await loadFile(custom))
      log.debug("loaded custom tui config", { path: custom })
    }

    for (const file of projectFiles) {
      result = mergeInfo(result, await loadFile(file))
    }

    for (const dir of unique(directories)) {
      if (!dir.endsWith(".opencode") && dir !== Flag.OPENCODE_CONFIG_DIR) continue
      for (const file of ConfigPaths.fileInDirectory(dir, "tui")) {
        result = mergeInfo(result, await loadFile(file))
      }
    }

    if (existsSync(managed)) {
      for (const file of ConfigPaths.fileInDirectory(managed, "tui")) {
        result = mergeInfo(result, await loadFile(file))
      }
    }

    result.keybinds ??= Config.Keybinds.parse({})
    result.plugin = Config.deduplicatePlugins(result.plugin ?? [])

    const deps: Promise<void>[] = []
    for (const dir of unique(directories)) {
      if (!dir.endsWith(".opencode") && dir !== Flag.OPENCODE_CONFIG_DIR) continue
      deps.push(
        (async () => {
          const shouldInstall = await Config.needsInstall(dir)
          if (!shouldInstall) return
          await Config.installDependencies(dir)
        })(),
      )
    }

    return {
      config: result,
      deps,
    }
  })

  export async function get() {
    return state().then((x) => x.config)
  }

  export async function waitForDependencies() {
    const deps = await state().then((x) => x.deps)
    await Promise.all(deps)
  }

  async function migrateFromOpencode(input: {
    projectFiles: string[]
    directories: string[]
    custom?: string
    managed: string
  }) {
    const existing = await hasAnyTuiConfig(input)
    if (existing) return

    const opencode = await opencodeFiles(input)
    for (const file of opencode) {
      const source = await Bun.file(file)
        .text()
        .catch(() => undefined)
      if (!source) continue
      const data = parseJsonc(source)
      if (!data || typeof data !== "object" || Array.isArray(data)) continue

      const extracted = {
        theme: "theme" in data ? (data.theme as string | undefined) : undefined,
        keybinds: "keybinds" in data ? (data.keybinds as Info["keybinds"]) : undefined,
        tui: "tui" in data ? (data.tui as Info["tui"]) : undefined,
      }
      if (!extracted.theme && !extracted.keybinds && !extracted.tui) continue

      const target = path.join(path.dirname(file), "tui.json")
      const targetExists = await Bun.file(target).exists()
      if (targetExists) continue

      const payload: Info = {
        $schema: "https://opencode.ai/config.json",
      }
      if (extracted.theme) payload.theme = extracted.theme
      if (extracted.keybinds) payload.keybinds = extracted.keybinds
      if (extracted.tui) payload.tui = extracted.tui

      await Bun.write(target, JSON.stringify(payload, null, 2))
      log.info("migrated tui config", { from: file, to: target })
    }
  }

  async function hasAnyTuiConfig(input: {
    projectFiles: string[]
    directories: string[]
    custom?: string
    managed: string
  }) {
    for (const file of ConfigPaths.fileInDirectory(Global.Path.config, "tui")) {
      if (await Bun.file(file).exists()) return true
    }
    if (input.projectFiles.length) return true
    for (const dir of unique(input.directories)) {
      if (!dir.endsWith(".opencode") && dir !== Flag.OPENCODE_CONFIG_DIR) continue
      for (const file of ConfigPaths.fileInDirectory(dir, "tui")) {
        if (await Bun.file(file).exists()) return true
      }
    }
    if (input.custom && (await Bun.file(input.custom).exists())) return true
    for (const file of ConfigPaths.fileInDirectory(input.managed, "tui")) {
      if (await Bun.file(file).exists()) return true
    }
    return false
  }

  async function opencodeFiles(input: { directories: string[]; managed: string }) {
    const project = Flag.OPENCODE_DISABLE_PROJECT_CONFIG
      ? []
      : await ConfigPaths.projectFiles("opencode", Instance.directory, Instance.worktree)
    const files = [...project, ...ConfigPaths.fileInDirectory(Global.Path.config, "opencode")]
    for (const dir of unique(input.directories)) {
      files.push(...ConfigPaths.fileInDirectory(dir, "opencode"))
    }
    if (Flag.OPENCODE_CONFIG) files.push(Flag.OPENCODE_CONFIG)
    files.push(...ConfigPaths.fileInDirectory(input.managed, "opencode"))

    const existing = await Promise.all(
      unique(files).map(async (file) => {
        const ok = await Bun.file(file).exists()
        return ok ? file : undefined
      }),
    )
    return existing.filter((file): file is string => !!file)
  }

  async function loadFile(filepath: string): Promise<Info> {
    let text = await Bun.file(filepath)
      .text()
      .catch(() => undefined)
    if (!text) return {}
    return load(text, filepath)
  }

  async function load(text: string, configFilepath: string): Promise<Info> {
    text = await Config.substitute(text, configFilepath, "empty")

    const parsed = Info.safeParse(parseJsonc(text))
    if (!parsed.success) return {}

    const data = parsed.data
    if (data.plugin) {
      for (let i = 0; i < data.plugin.length; i++) {
        data.plugin[i] = Config.resolvePluginSpec(data.plugin[i], configFilepath)
      }
    }
    return data
  }
}
