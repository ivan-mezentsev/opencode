import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Global } from "../../src/global"
import { InstructionPrompt } from "../../src/session/instruction"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

describe("InstructionPrompt.resolve", () => {
  test("returns empty when AGENTS.md is at project root (already in systemPaths)", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "AGENTS.md"), "# Root Instructions")
        await Bun.write(path.join(dir, "src", "file.ts"), "const x = 1")
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const system = await InstructionPrompt.systemPaths()
        expect(system.has(path.join(tmp.path, "AGENTS.md"))).toBe(true)

        const results = await InstructionPrompt.resolve([], path.join(tmp.path, "src", "file.ts"), "test-message-1")
        expect(results).toEqual([])
      },
    })
  })

  test("returns AGENTS.md from subdirectory (not in systemPaths)", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "subdir", "AGENTS.md"), "# Subdir Instructions")
        await Bun.write(path.join(dir, "subdir", "nested", "file.ts"), "const x = 1")
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const system = await InstructionPrompt.systemPaths()
        expect(system.has(path.join(tmp.path, "subdir", "AGENTS.md"))).toBe(false)

        const results = await InstructionPrompt.resolve(
          [],
          path.join(tmp.path, "subdir", "nested", "file.ts"),
          "test-message-2",
        )
        expect(results.length).toBe(1)
        expect(results[0].filepath).toBe(path.join(tmp.path, "subdir", "AGENTS.md"))
      },
    })
  })
})

describe("InstructionPrompt.systemPaths", () => {
  test("includes config and global AGENTS, skips CLAUDE when agents exist", async () => {
    const homeValue = process.env["OPENCODE_TEST_HOME"]
    const configValue = process.env["OPENCODE_CONFIG_DIR"]
    const disableValue = process.env["OPENCODE_DISABLE_CLAUDE_CODE_PROMPT"]

    await using config = await tmpdir()
    await using home = await tmpdir()
    await using project = await tmpdir()

    try {
      process.env["OPENCODE_CONFIG_DIR"] = config.path
      process.env["OPENCODE_TEST_HOME"] = home.path
      delete process.env["OPENCODE_DISABLE_CLAUDE_CODE_PROMPT"]

      const configAgent = path.join(config.path, "AGENTS.md")
      const globalAgent = path.join(Global.Path.config, "AGENTS.md")
      const claudeAgent = path.join(Global.Path.home, ".claude", "CLAUDE.md")

      await fs.mkdir(path.dirname(globalAgent), { recursive: true })
      await fs.mkdir(path.dirname(claudeAgent), { recursive: true })

      await Bun.write(configAgent, "# Config")
      await Bun.write(globalAgent, "# Global")
      await Bun.write(claudeAgent, "# Claude")

      await Instance.provide({
        directory: project.path,
        fn: async () => {
          const system = await InstructionPrompt.systemPaths()
          expect(system.has(path.resolve(configAgent))).toBe(true)
          expect(system.has(path.resolve(globalAgent))).toBe(true)
          expect(system.has(path.resolve(claudeAgent))).toBe(false)
        },
      })
    } finally {
      await fs.rm(path.join(Global.Path.config, "AGENTS.md"), { force: true })
      if (homeValue === undefined) delete process.env["OPENCODE_TEST_HOME"]
      if (homeValue !== undefined) process.env["OPENCODE_TEST_HOME"] = homeValue
      if (configValue === undefined) delete process.env["OPENCODE_CONFIG_DIR"]
      if (configValue !== undefined) process.env["OPENCODE_CONFIG_DIR"] = configValue
      if (disableValue === undefined) delete process.env["OPENCODE_DISABLE_CLAUDE_CODE_PROMPT"]
      if (disableValue !== undefined) process.env["OPENCODE_DISABLE_CLAUDE_CODE_PROMPT"] = disableValue
    }
  })

  test("uses CLAUDE when no agents exist", async () => {
    const homeValue = process.env["OPENCODE_TEST_HOME"]
    const configValue = process.env["OPENCODE_CONFIG_DIR"]
    const disableValue = process.env["OPENCODE_DISABLE_CLAUDE_CODE_PROMPT"]

    await using config = await tmpdir()
    await using home = await tmpdir()
    await using project = await tmpdir()

    try {
      process.env["OPENCODE_CONFIG_DIR"] = config.path
      process.env["OPENCODE_TEST_HOME"] = home.path
      delete process.env["OPENCODE_DISABLE_CLAUDE_CODE_PROMPT"]

      const globalAgent = path.join(Global.Path.config, "AGENTS.md")
      const claudeAgent = path.join(Global.Path.home, ".claude", "CLAUDE.md")

      await fs.rm(globalAgent, { force: true })
      await fs.mkdir(path.dirname(claudeAgent), { recursive: true })
      await Bun.write(claudeAgent, "# Claude")

      await Instance.provide({
        directory: project.path,
        fn: async () => {
          const system = await InstructionPrompt.systemPaths()
          expect(system.has(path.resolve(globalAgent))).toBe(false)
          expect(system.has(path.resolve(claudeAgent))).toBe(true)
        },
      })
    } finally {
      await fs.rm(path.join(Global.Path.config, "AGENTS.md"), { force: true })
      if (homeValue === undefined) delete process.env["OPENCODE_TEST_HOME"]
      if (homeValue !== undefined) process.env["OPENCODE_TEST_HOME"] = homeValue
      if (configValue === undefined) delete process.env["OPENCODE_CONFIG_DIR"]
      if (configValue !== undefined) process.env["OPENCODE_CONFIG_DIR"] = configValue
      if (disableValue === undefined) delete process.env["OPENCODE_DISABLE_CLAUDE_CODE_PROMPT"]
      if (disableValue !== undefined) process.env["OPENCODE_DISABLE_CLAUDE_CODE_PROMPT"] = disableValue
    }
  })
})
