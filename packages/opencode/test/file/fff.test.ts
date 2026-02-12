import { describe, expect, test } from "bun:test"
import path from "path"
import { tmpdir } from "../fixture/fixture"
import { FFF } from "../../src/file/fff"
import { File } from "../../src/file"
import { Instance } from "../../src/project/instance"

describe("file.fff", () => {
  test("returns files and supports directory search via File.search", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "src", "app", "index.ts"), "export const app = true")
        await Bun.write(path.join(dir, "src", "app", "util.ts"), "export const util = true")
        await Bun.write(path.join(dir, "docs", "guide.md"), "# guide")
      },
    })

    const files = await FFF.search({
      cwd: tmp.path,
      query: "index",
      limit: 20,
    })
    expect(files.includes(path.join("src", "app", "index.ts"))).toBe(true)

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const found = await File.search({
          query: "index",
          type: "file",
          limit: 20,
        })
        expect(found.includes(path.join("src", "app", "index.ts"))).toBe(true)

        const dirs = await File.search({
          query: "app",
          type: "directory",
          limit: 20,
        })
        expect(dirs.includes("src/app/")).toBe(true)

        const all = await File.search({
          query: "app",
          type: "all",
          limit: 20,
        })
        expect(all.includes(path.join("src", "app", "index.ts"))).toBe(true)
        expect(all.includes("src/app/")).toBe(true)
      },
    })
  })
})
