import { describe, expect, test, beforeAll, afterAll } from "bun:test"
import path from "path"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { Log } from "../../src/util/log"
import { Instance } from "../../src/project/instance"
import { MessageV2 } from "../../src/session/message-v2"

const projectRoot = path.join(__dirname, "../..")
Log.init({ print: false })

// Skip tests if no API key is available
const hasApiKey = !!process.env.ANTHROPIC_API_KEY

// Helper to run test within Instance context
async function withInstance<T>(fn: () => Promise<T>): Promise<T> {
  return Instance.provide({
    directory: projectRoot,
    fn,
  })
}

describe("StructuredOutput Integration", () => {
  test.skipIf(!hasApiKey)("produces structured output with simple schema", async () => {
    await withInstance(async () => {
      const session = await Session.create({ title: "Structured Output Test" })

      const result = await SessionPrompt.prompt({
        sessionID: session.id,
        parts: [
          {
            type: "text",
            text: "What is 2 + 2? Provide a simple answer.",
          },
        ],
        outputFormat: {
          type: "json_schema",
          schema: {
            type: "object",
            properties: {
              answer: { type: "number", description: "The numerical answer" },
              explanation: { type: "string", description: "Brief explanation" },
            },
            required: ["answer"],
          },
        },
      })

      // Verify structured output was captured
      expect(result.info.structured_output).toBeDefined()
      expect(typeof result.info.structured_output).toBe("object")

      const output = result.info.structured_output as any
      expect(output.answer).toBe(4)

      // Verify no error was set
      expect(result.info.error).toBeUndefined()

      // Clean up
      // Note: Not removing session to avoid race with background SessionSummary.summarize
    })
  }, 60000)

  test.skipIf(!hasApiKey)("produces structured output with nested objects", async () => {
    await withInstance(async () => {
      const session = await Session.create({ title: "Nested Schema Test" })

      const result = await SessionPrompt.prompt({
        sessionID: session.id,
        parts: [
          {
            type: "text",
            text: "Tell me about Anthropic company in a structured format.",
          },
        ],
        outputFormat: {
          type: "json_schema",
          schema: {
            type: "object",
            properties: {
              company: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  founded: { type: "number" },
                },
                required: ["name", "founded"],
              },
              products: {
                type: "array",
                items: { type: "string" },
              },
            },
            required: ["company"],
          },
        },
      })

      // Verify structured output was captured
      expect(result.info.structured_output).toBeDefined()
      const output = result.info.structured_output as any

      expect(output.company).toBeDefined()
      expect(output.company.name).toBe("Anthropic")
      expect(typeof output.company.founded).toBe("number")

      if (output.products) {
        expect(Array.isArray(output.products)).toBe(true)
      }

      // Verify no error was set
      expect(result.info.error).toBeUndefined()

      // Clean up
      // Note: Not removing session to avoid race with background SessionSummary.summarize
    })
  }, 60000)

  test.skipIf(!hasApiKey)("works with text outputFormat (default)", async () => {
    await withInstance(async () => {
      const session = await Session.create({ title: "Text Output Test" })

      const result = await SessionPrompt.prompt({
        sessionID: session.id,
        parts: [
          {
            type: "text",
            text: "Say hello.",
          },
        ],
        outputFormat: {
          type: "text",
        },
      })

      // Verify no structured output (text mode)
      expect(result.info.structured_output).toBeUndefined()

      // Verify we got a response with parts
      expect(result.parts.length).toBeGreaterThan(0)

      // Verify no error was set
      expect(result.info.error).toBeUndefined()

      // Clean up
      // Note: Not removing session to avoid race with background SessionSummary.summarize
    })
  }, 60000)

  test.skipIf(!hasApiKey)("stores outputFormat on user message", async () => {
    await withInstance(async () => {
      const session = await Session.create({ title: "OutputFormat Storage Test" })

      await SessionPrompt.prompt({
        sessionID: session.id,
        parts: [
          {
            type: "text",
            text: "What is 1 + 1?",
          },
        ],
        outputFormat: {
          type: "json_schema",
          schema: {
            type: "object",
            properties: {
              result: { type: "number" },
            },
            required: ["result"],
          },
          retryCount: 3,
        },
      })

      // Get all messages from session
      const messages = await Session.messages({ sessionID: session.id })
      const userMessage = messages.find((m) => m.info.role === "user")

      // Verify outputFormat was stored on user message
      expect(userMessage).toBeDefined()
      if (userMessage?.info.role === "user") {
        expect(userMessage.info.outputFormat).toBeDefined()
        expect(userMessage.info.outputFormat?.type).toBe("json_schema")
        if (userMessage.info.outputFormat?.type === "json_schema") {
          expect(userMessage.info.outputFormat.retryCount).toBe(3)
        }
      }

      // Clean up
      // Note: Not removing session to avoid race with background SessionSummary.summarize
    })
  }, 60000)

  test("unit test: StructuredOutputError is properly structured", () => {
    const error = new MessageV2.StructuredOutputError({
      message: "Failed to produce valid structured output after 3 attempts",
      retries: 3,
    })

    expect(error.name).toBe("StructuredOutputError")
    expect(error.data.message).toContain("3 attempts")
    expect(error.data.retries).toBe(3)

    const obj = error.toObject()
    expect(obj.name).toBe("StructuredOutputError")
    expect(obj.data.retries).toBe(3)
  })
})
