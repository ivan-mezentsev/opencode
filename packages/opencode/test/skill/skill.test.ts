import { test, expect } from "bun:test"
import { Skill } from "../../src/skill"
import { SystemPrompt } from "../../src/session/system"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"
import path from "path"

test("discovers skills from .opencode/skill/ directory", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      const skillDir = path.join(dir, ".opencode", "skill", "test-skill")
      await Bun.write(
        path.join(skillDir, "SKILL.md"),
        `---
name: test-skill
description: A test skill for verification.
---

# Test Skill

Instructions here.
`,
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const skills = await Skill.all()
      expect(skills.length).toBe(1)
      expect(skills[0].name).toBe("test-skill")
      expect(skills[0].description).toBe("A test skill for verification.")
      expect(skills[0].location).toContain("skill/test-skill/SKILL.md")
    },
  })
})

test("discovers multiple skills from .opencode/skill/ directory", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      const skillDir = path.join(dir, ".opencode", "skill", "my-skill")
      await Bun.write(
        path.join(skillDir, "SKILL.md"),
        `---
name: my-skill
description: Another test skill.
---

# My Skill
`,
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const skills = await Skill.all()
      expect(skills.length).toBe(1)
      expect(skills[0].name).toBe("my-skill")
    },
  })
})

test("skips skills with missing frontmatter", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      const skillDir = path.join(dir, ".opencode", "skill", "no-frontmatter")
      await Bun.write(
        path.join(skillDir, "SKILL.md"),
        `# No Frontmatter

Just some content without YAML frontmatter.
`,
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const skills = await Skill.all()
      expect(skills).toEqual([])
    },
  })
})

test("returns empty array when no skills exist", async () => {
  await using tmp = await tmpdir({ git: true })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const skills = await Skill.all()
      expect(skills).toEqual([])
    },
  })
})

test("SystemPrompt.skills() returns empty array when no skills", async () => {
  await using tmp = await tmpdir({ git: true })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const result = await SystemPrompt.skills()
      expect(result).toEqual([])
    },
  })
})

test("SystemPrompt.skills() returns XML block with skills", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      const skillDir = path.join(dir, ".opencode", "skill", "example-skill")
      await Bun.write(
        path.join(skillDir, "SKILL.md"),
        `---
name: example-skill
description: An example skill for testing XML output.
---

# Example
`,
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const result = await SystemPrompt.skills()
      expect(result.length).toBe(1)
      expect(result[0]).toContain("<available_skills>")

      expect(result[0]).toContain("<name>example-skill</name>")
      expect(result[0]).toContain("<description>An example skill for testing XML output.</description>")
      expect(result[0]).toContain("</available_skills>")
      expect(result[0]).toContain("use the skill tool")
    },
  })
})

// test("discovers skills from .claude/skills/ directory", async () => {
//   await using tmp = await tmpdir({
//     git: true,
//     init: async (dir) => {
//       const skillDir = path.join(dir, ".claude", "skills", "claude-skill")
//       await Bun.write(
//         path.join(skillDir, "SKILL.md"),
//         `---
// name: claude-skill
// description: A skill in the .claude/skills directory.
// ---

// # Claude Skill
// `,
//       )
//     },
//   })

//   await Instance.provide({
//     directory: tmp.path,
//     fn: async () => {
//       const skills = await Skill.all()
//       expect(skills.length).toBe(1)
//       expect(skills[0].name).toBe("claude-skill")
//       expect(skills[0].location).toContain(".claude/skills/claude-skill/SKILL.md")
//     },
//   })
// })
