import { afterEach, expect, test } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { TuiConfig } from "../../src/config/tui"
import { Global } from "../../src/global"

afterEach(async () => {
  delete process.env.OPENCODE_CONFIG
  await fs.rm(path.join(Global.Path.config, "tui.json"), { force: true }).catch(() => {})
  await fs.rm(path.join(Global.Path.config, "tui.jsonc"), { force: true }).catch(() => {})
})

test("loads tui config with the same precedence order as server config paths", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(path.join(Global.Path.config, "tui.json"), JSON.stringify({ theme: "global" }, null, 2))
      await Bun.write(path.join(dir, "tui.json"), JSON.stringify({ theme: "project" }, null, 2))
      await fs.mkdir(path.join(dir, ".opencode"), { recursive: true })
      await Bun.write(
        path.join(dir, ".opencode", "tui.json"),
        JSON.stringify({ theme: "local", tui: { diff_style: "stacked" } }, null, 2),
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await TuiConfig.get()
      expect(config.theme).toBe("local")
      expect(config.tui?.diff_style).toBe("stacked")
    },
  })
})

test("migrates tui-specific keys from opencode.json when tui.json does not exist", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify(
          {
            theme: "migrated-theme",
            tui: { scroll_speed: 5 },
            keybinds: { app_exit: "ctrl+q" },
          },
          null,
          2,
        ),
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await TuiConfig.get()
      expect(config.theme).toBe("migrated-theme")
      expect(config.tui?.scroll_speed).toBe(5)
      expect(config.keybinds?.app_exit).toBe("ctrl+q")
      expect(await Bun.file(path.join(tmp.path, "tui.json")).exists()).toBe(true)
    },
  })
})

test("only reads plugin list from tui.json", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(path.join(dir, "opencode.json"), JSON.stringify({ plugin: ["server-only"] }, null, 2))
      await Bun.write(path.join(dir, "tui.json"), JSON.stringify({ plugin: ["tui-only"] }, null, 2))
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await TuiConfig.get()
      expect(config.plugin).toEqual(["tui-only"])
    },
  })
})
