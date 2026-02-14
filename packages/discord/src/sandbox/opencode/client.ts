import { Context, Effect, Layer, ParseResult, Schema, Schedule } from "effect"
import { HttpBody, HttpClient, HttpClientError, HttpClientRequest, HttpClientResponse } from "@effect/platform"
import { classifyOpenCodeFailure, HealthCheckError, OpenCodeClientError } from "../../errors"
import { PreviewAccess, SessionId } from "../../types"

const HealthResponse = Schema.Struct({
  healthy: Schema.Boolean,
})

const CreateSessionResponse = Schema.Struct({
  id: SessionId,
})

const ListSessionsResponse = Schema.Array(
  Schema.Struct({
    id: SessionId,
    title: Schema.optional(Schema.String),
    time: Schema.optional(Schema.Struct({ updated: Schema.optional(Schema.Number) })),
  }),
)

const SendPromptResponse = Schema.Struct({
  parts: Schema.optional(
    Schema.Array(Schema.Struct({
      type: Schema.String,
      text: Schema.optional(Schema.String),
      content: Schema.optional(Schema.String),
    })),
  ),
})

export class OpenCodeSessionSummary extends Schema.Class<OpenCodeSessionSummary>("OpenCodeSessionSummary")({
  id: SessionId,
  title: Schema.String,
  updatedAt: Schema.optional(Schema.Number),
}) {}

const parsePreview = (input: PreviewAccess): { base: string; token: string | null } => {
  const url = new URL(input.previewUrl)
  const token = input.previewToken ?? url.searchParams.get("tkn")
  url.searchParams.delete("tkn")
  return { base: url.toString().replace(/\/$/, ""), token }
}

/**
 * HTTP client for an OpenCode server running inside a Daytona sandbox.
 *
 * Each method takes a {@link PreviewAccess} to locate the sandbox's preview
 * tunnel. Typical lifecycle:
 *
 * 1. `waitForHealthy` — poll until the server is ready after creation/resume
 * 2. `createSession` — start a new chat session
 * 3. `sendPrompt` — send user messages, returns the agent's text response
 * 4. `abortSession` — cancel an in-flight generation
 */
export declare namespace OpenCodeClient {
  export interface Service {
    /** Poll the health endpoint until the server responds healthy, or timeout. */
    readonly waitForHealthy: (
      preview: PreviewAccess,
      maxWaitMs?: number,
    ) => Effect.Effect<boolean, HealthCheckError>
    /** Create a new chat session with the given title. Returns the session ID. */
    readonly createSession: (
      preview: PreviewAccess,
      title: string,
    ) => Effect.Effect<SessionId, OpenCodeClientError>
    /** Check whether a session still exists on the server. */
    readonly sessionExists: (
      preview: PreviewAccess,
      sessionId: SessionId,
    ) => Effect.Effect<boolean, OpenCodeClientError>
    /** List recent sessions, ordered by update time. */
    readonly listSessions: (
      preview: PreviewAccess,
      limit?: number,
    ) => Effect.Effect<ReadonlyArray<OpenCodeSessionSummary>, OpenCodeClientError>
    /** Send a user prompt and return the agent's text response. */
    readonly sendPrompt: (
      preview: PreviewAccess,
      sessionId: SessionId,
      text: string,
    ) => Effect.Effect<string, OpenCodeClientError>
    /** Cancel an in-flight generation. Best-effort, errors are swallowed. */
    readonly abortSession: (
      preview: PreviewAccess,
      sessionId: SessionId,
    ) => Effect.Effect<void>
  }
}

export class OpenCodeClient extends Context.Tag("@discord/OpenCodeClient")<OpenCodeClient, OpenCodeClient.Service>() {
  static readonly layer = Layer.effect(
    OpenCodeClient,
    Effect.gen(function* () {
      const baseClient = yield* HttpClient.HttpClient

      /** Build a scoped client for a specific preview, with auth header and 2xx filtering. */
      const scopedClient = (preview: PreviewAccess) => {
        const { base, token } = parsePreview(preview)
        return baseClient.pipe(
          HttpClient.mapRequest((req) =>
            token ? HttpClientRequest.setHeader(req, "x-daytona-preview-token", token) : req
          ),
          HttpClient.mapRequest(HttpClientRequest.prependUrl(base)),
          HttpClient.filterStatusOk,
        )
      }

      /** Map HttpClientError + ParseError to OpenCodeClientError for a given operation. */
      const openCodeError = (operation: string, statusCode: number, body: string) =>
        OpenCodeClientError.make({
          operation,
          statusCode,
          body,
          kind: classifyOpenCodeFailure(statusCode, body),
        })

      const mapErrors = <A, R>(
        operation: string,
        effect: Effect.Effect<A, HttpClientError.HttpClientError | ParseResult.ParseError, R>,
      ) =>
        effect.pipe(
          Effect.catchTags({
            ResponseError: (err) =>
              openCodeError(operation, err.response.status, err.message),
            RequestError: (err) =>
              openCodeError(operation, 0, err.message),
            ParseError: (err) =>
              openCodeError(operation, 0, `Decode: ${err.message}`),
          }),
        )

      const waitForHealthy = Effect.fn("OpenCodeClient.waitForHealthy")(
        function* (preview: PreviewAccess, maxWaitMs = 120_000) {
          const maxAttempts = Math.max(1, Math.ceil(maxWaitMs / 2000))
          const api = scopedClient(preview)

          const poll = api.get("/global/health").pipe(
            Effect.flatMap(HttpClientResponse.schemaBodyJson(HealthResponse)),
            Effect.scoped,
            Effect.flatMap((body) =>
              body.healthy
                ? Effect.succeed(true)
                : new HealthCheckError({ lastStatus: `200 but healthy=${body.healthy}` }),
            ),
            Effect.catchAll((cause) => new HealthCheckError({ lastStatus: String(cause) })),
          )

          return yield* poll.pipe(
            Effect.retry(
              Schedule.intersect(
                Schedule.spaced("2 seconds"),
                Schedule.recurs(maxAttempts - 1),
              ),
            ),
            Effect.catchAll(() => Effect.succeed(false)),
          )
        },
      )

      const createSession = (preview: PreviewAccess, title: string) =>
        mapErrors(
          "createSession",
          scopedClient(preview)
            .post("/session", { body: HttpBody.unsafeJson({ title }) })
            .pipe(
              Effect.flatMap(HttpClientResponse.schemaBodyJson(CreateSessionResponse)),
              Effect.scoped,
              Effect.map((body) => body.id),
            ),
        )

      const sessionExists = (preview: PreviewAccess, sessionId: SessionId) =>
        scopedClient(preview)
          .get(`/session/${sessionId}`)
          .pipe(
            Effect.scoped,
            Effect.as(true),
            Effect.catchTag("ResponseError", (err) =>
              err.response.status === 404
                ? Effect.succeed(false)
                : openCodeError("sessionExists", err.response.status, err.message),
            ),
            Effect.catchTag("RequestError", (err) =>
              openCodeError("sessionExists", 0, err.message),
            ),
          )

      const listSessions = (preview: PreviewAccess, limit = 50) =>
        mapErrors(
          "listSessions",
          scopedClient(preview)
            .get(`/session${limit > 0 ? `?limit=${limit}` : ""}`)
            .pipe(
              Effect.flatMap(HttpClientResponse.schemaBodyJson(ListSessionsResponse)),
              Effect.scoped,
              Effect.map((sessions) =>
                sessions.map((s) =>
                  OpenCodeSessionSummary.make({
                    id: s.id,
                    title: s.title ?? "",
                    ...(s.time?.updated != null ? { updatedAt: s.time.updated } : {}),
                  }),
                ),
              ),
            ),
        )

      const sendPrompt = (preview: PreviewAccess, sessionId: SessionId, text: string) =>
        mapErrors(
          "sendPrompt",
          scopedClient(preview)
            .post(`/session/${sessionId}/message`, {
              body: HttpBody.unsafeJson({ parts: [{ type: "text", text }] }),
            })
            .pipe(
              Effect.flatMap(HttpClientResponse.schemaBodyJson(SendPromptResponse)),
              Effect.scoped,
              Effect.map((result) => {
                const parts = result.parts ?? []
                const textContent = parts
                  .filter((p) => p.type === "text")
                  .map((p) => p.text || p.content || "")
                  .filter(Boolean)
                return textContent.join("\n\n") || "(No response from agent)"
              }),
            ),
        )

      const abortSession = (preview: PreviewAccess, sessionId: SessionId) =>
        scopedClient(preview)
          .post(`/session/${sessionId}/abort`)
          .pipe(
            Effect.scoped,
            Effect.asVoid,
            Effect.catchAll(() => Effect.void),
          )

      return OpenCodeClient.of({
        waitForHealthy,
        createSession,
        sessionExists,
        listSessions,
        sendPrompt,
        abortSession,
      })
    }),
  )
}
