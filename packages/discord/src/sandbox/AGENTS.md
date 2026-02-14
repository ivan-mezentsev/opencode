# Sandbox Module

Manages Daytona sandbox lifecycle and the OpenCode server running inside each sandbox.

## Three-Layer Architecture

1. **DaytonaService** (`daytona.ts`) — thin wrapper around `@daytonaio/sdk`. Creates/starts/stops/destroys sandboxes, executes commands, gets preview links. All methods return `Effect` with typed errors.
2. **SandboxProvisioner** (`provisioner.ts`) — orchestrates sandbox + OpenCode session lifecycle. Handles provision, resume, health checks, send-failure recovery.
3. **ThreadAgentPool** (`pool.ts`) — per-thread concurrency layer. Wraps provisioner with `ActorMap<ThreadId>` for serialized access per thread. Manages idle timeouts and cleanup loops.

## Sandbox Creation Flow

`provision()` uses `Effect.acquireUseRelease`:

- **acquire**: `daytonaService.create()` — creates sandbox with `Image.base("node:22-bookworm-slim")` + custom setup
- **use**: clones opencode repo, writes auth/config JSON via env vars, starts `opencode serve`, waits for health, creates session
- **release on failure**: destroys the sandbox (cleanup), marks session as errored

The `discordBotImage` in `daytona.ts` uses Daytona's `Image.base().runCommands().workdir()` builder — NOT a Dockerfile. It installs git, curl, gh CLI, opencode-ai, and bun globally.

## OpenCode Server Communication

`OpenCodeClient` (`opencode-client.ts`) uses `@effect/platform`'s `HttpClient`:

- Each request uses `scopedClient(preview)` which prepends the sandbox preview URL and adds `x-daytona-preview-token` header
- `HttpClient.filterStatusOk` auto-rejects non-2xx responses as `ResponseError`
- `mapErrors` helper converts `HttpClientError` + `ParseResult.ParseError` → `OpenCodeClientError`
- Health polling: `waitForHealthy` retries every 2s up to `maxWaitMs / 2000` attempts

## `PreviewAccess` — The Connectivity Token

`PreviewAccess` (defined in `types.ts`) carries `previewUrl` + `previewToken`. It's extracted from Daytona's `getPreviewLink(4096)` response (port 4096 is OpenCode's serve port). The token may also be embedded in the URL as `?tkn=` — `parsePreview` normalizes this.

`PreviewAccess.from(source)` factory works with any object having those two fields — used with `SandboxHandle`, `SessionInfo`.

## Resume Flow (Non-Obvious)

`provisioner.resume()` does NOT just restart. It:

1. Calls `daytonaService.start()` (re-starts the stopped Daytona sandbox)
2. Runs `restartOpenCodeServe` — a shell command that pkills old opencode processes and re-launches
3. Waits for health (120s default)
4. Calls `findOrCreateSessionId` — tries to find existing session by title (`Discord thread <threadId>`), creates new if not found
5. Returns `Resumed` or `ResumeFailed { allowRecreate }` — `allowRecreate: false` means "don't try recreating, something is fundamentally wrong"

## Send Failure Classification

`classifySendError` in provisioner maps HTTP status codes to recovery strategies:

- 404 → `session-missing` (session deleted, mark error)
- 0 or 5xx → `sandbox-down` (pause sandbox for later resume)
- body contains "sandbox not found" / "is the sandbox started" → `sandbox-down`
- anything else → `non-recoverable` (no automatic recovery)

## ThreadAgentPool — The ActorMap Bridge

`ThreadAgentPool` creates `ActorMap<ThreadId, SessionInfo>` with:

- `idleTimeout`: from config `sandboxTimeout` (default 30min)
- `onIdle`: pauses the sandbox and removes the actor
- `load`: reads from `SessionStore` on first access
- `save`: writes to `SessionStore` after state changes

`runtime(threadId, stateRef)` creates a `Runtime` object with `current/ensure/send/pause/destroy` methods. `runRuntime` submits work to the actor queue via `actors.run(threadId, (state) => ...)`.

## Background Cleanup Loop

Forked with `Effect.forkScoped` on `Schedule.spaced(config.cleanupInterval)`:

- Pauses stale-active sessions (no activity for `sandboxTimeout + graceMinutes`)
- Destroys expired-paused sessions (paused longer than `pausedTtlMinutes`)

## Files That Must Change Together

- Adding a new Daytona operation → `daytona.ts` + add error type in `errors.ts` if needed
- Changing sandbox setup (image, commands) → `daytona.ts` image builder + `provisioner.ts` exec commands
- Adding a new pool operation → `pool.ts` interface + wire into `conversation/services/conversation.ts`
