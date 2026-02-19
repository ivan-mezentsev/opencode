import { describe, expect, test } from "bun:test"
import { relativizeProjectPaths } from "./relativize-project-paths"

describe("relativizeProjectPaths", () => {
  test("keeps urls unchanged when directory is linux root", () => {
    const text = "Use https://github.com/anomalyco/opencode for details"
    expect(relativizeProjectPaths(text, "/")).toBe(text)
  })

  test("keeps urls unchanged when directory is backslash root", () => {
    const text = "Use https://github.com/anomalyco/opencode for details"
    expect(relativizeProjectPaths(text, "\\")).toBe(text)
  })

  test("strips a non-root project directory", () => {
    const text = "open /home/user/repo/src/app.ts"
    expect(relativizeProjectPaths(text, "/home/user/repo")).toBe("open /src/app.ts")
  })

  test("returns original text when directory is missing", () => {
    const text = "https://github.com/anomalyco/opencode"
    expect(relativizeProjectPaths(text)).toBe(text)
    expect(relativizeProjectPaths(text, "")).toBe(text)
  })

  test("preserves url slashes while stripping project paths", () => {
    const text = "See /home/user/repo/docs and https://github.com/anomalyco/opencode"
    expect(relativizeProjectPaths(text, "/home/user/repo")).toBe("See /docs and https://github.com/anomalyco/opencode")
  })
})
