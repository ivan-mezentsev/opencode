# OpenCord

Discord bot that provisions [Daytona](https://daytona.io) sandboxes running [OpenCode](https://opencode.ai) sessions. Each Discord thread gets its own isolated sandbox with full conversational context.

## How It Works

1. Mention the bot in an allowed channel
2. Bot creates a Discord thread and provisions a Daytona sandbox
3. OpenCode runs inside the sandbox, responding to messages in the thread
4. Inactive threads pause their sandbox automatically; activity resumes them
5. Conversational context is preserved across bot restarts

## Setup

### Prerequisites

- [Bun](https://bun.sh) installed
- A Discord bot application (see below)
- A [Daytona](https://daytona.io) account with API access
- An [OpenCode](https://opencode.ai) API key

### 1. Create a Discord Bot

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications)
2. Create a new application
3. Go to **Bot** and click **Reset Token** — save this as `DISCORD_TOKEN`
4. Enable **Message Content Intent** under **Privileged Gateway Intents**
5. Go to **OAuth2 > URL Generator**, select scopes `bot` and `applications.commands` with permissions: **Send Messages**, **Create Public Threads**, **Send Messages in Threads**, **Read Message History**
6. Use the generated URL to invite the bot to your server

### 2. Get Your API Keys

- **Daytona**: Sign up at [daytona.io](https://daytona.io) and generate an API key from your dashboard
- **OpenCode**: Get an API key from [opencode.ai](https://opencode.ai)
- **GitHub Token** (optional): A personal access token — enables authenticated `gh` CLI inside sandboxes

### 3. Configure and Run

```bash
bun install
cp .env.example .env
# Fill in required values (see below)
bun run db:init
bun run dev
```

### 4. Run with Docker

Build the image from the package directory (or from repo root using the same path as context):

```bash
docker build -t opencode-discord packages/discord
```

Create an env file from the template and set the required values (`DISCORD_TOKEN`, `DAYTONA_API_KEY`, `OPENCODE_ZEN_API_KEY`):

```bash
cp packages/discord/.env.example .env
```

Run the container with a persistent volume for SQLite data:

```bash
docker run --name opencode-discord \
  --env-file .env \
  -e DATABASE_PATH=/data/discord.sqlite \
  -p 8787:8787 \
  -v opencode-discord-data:/data \
  opencode-discord
```

This image does not require Docker Compose or special network wiring; only outbound access to Discord, Daytona, and OpenCode APIs.

### Environment Variables

#### Required

| Variable               | Description                                 |
| ---------------------- | ------------------------------------------- |
| `DISCORD_TOKEN`        | Bot token from the Discord Developer Portal |
| `DAYTONA_API_KEY`      | API key from your Daytona dashboard         |
| `OPENCODE_ZEN_API_KEY` | API key from OpenCode                       |

#### Optional — Discord

| Variable                   | Default   | Description                                                             |
| -------------------------- | --------- | ----------------------------------------------------------------------- |
| `ALLOWED_CHANNEL_IDS`      | _(empty)_ | Comma-separated channel IDs where the bot listens. Empty = all channels |
| `DISCORD_CATEGORY_ID`      | _(empty)_ | Restrict the bot to a specific channel category                         |
| `DISCORD_ROLE_ID`          | _(empty)_ | Role ID that triggers the bot via @role mentions                        |
| `DISCORD_REQUIRED_ROLE_ID` | _(empty)_ | Role users must have to interact with the bot                           |
| `DISCORD_COMMAND_GUILD_ID` | _(empty)_ | Register slash commands in one guild for instant updates (dev-friendly) |

#### Optional — Storage & Runtime

| Variable         | Default                      | Description                                        |
| ---------------- | ---------------------------- | -------------------------------------------------- |
| `DATABASE_PATH`  | `discord.sqlite`             | Path to the local SQLite file                      |
| `GITHUB_TOKEN`   | _(empty)_                    | Injected into sandboxes for authenticated `gh` CLI |
| `DAYTONA_SNAPSHOT` | _(empty)_                  | Prebuilt Daytona snapshot name for faster startup  |
| `OPENCODE_MODEL` | `opencode/claude-sonnet-4-5` | Model used inside OpenCode sessions                |

#### Optional — Bot Behavior

| Variable                   | Default            | Description                                                                    |
| -------------------------- | ------------------ | ------------------------------------------------------------------------------ |
| `SANDBOX_REUSE_POLICY`     | `resume_preferred` | `resume_preferred` or `recreate`                                               |
| `SANDBOX_TIMEOUT_MINUTES`  | `30`               | Minutes of inactivity before pausing a sandbox                                 |
| `PAUSED_TTL_MINUTES`       | `180`              | Minutes a paused sandbox lives before being destroyed                          |
| `RESUME_HEALTH_TIMEOUT_MS` | `120000`           | Timeout (ms) when waiting for a sandbox to resume                              |
| `SANDBOX_CREATION_TIMEOUT` | `180`              | Timeout (s) for sandbox creation                                               |
| `TURN_ROUTING_MODE`        | `ai`               | How the bot decides if a message needs a response: `off`, `heuristic`, or `ai` |
| `TURN_ROUTING_MODEL`       | `claude-haiku-4-5` | Model used for AI turn routing                                                 |

#### Optional — Observability

| Variable      | Default   | Description                         |
| ------------- | --------- | ----------------------------------- |
| `LOG_LEVEL`   | `info`    | `debug`, `info`, `warn`, or `error` |
| `LOG_PRETTY`  | `false`   | Pretty-print JSON logs              |
| `HEALTH_HOST` | `0.0.0.0` | Host for the health HTTP server     |
| `HEALTH_PORT` | `8787`    | Port for the health HTTP server     |

## Commands

| Command             | Description                 |
| ------------------- | --------------------------- |
| `bun run dev`       | Watch mode                  |
| `bun run start`     | Production run              |
| `bun run db:init`   | Initialize/migrate database |
| `bun run snapshot:create` | Build/activate a Daytona snapshot |
| `bun run typecheck` | TypeScript checks           |
| `bun run build`     | Bundle for deployment       |
| `bun run check`     | Typecheck + build           |

### Faster Sandbox Startup (Snapshot)

Build and activate a reusable Daytona snapshot once:

```bash
bun run snapshot:create opencode-discord-v1
```

Then set this in `.env`:

```bash
DAYTONA_SNAPSHOT=opencode-discord-v1
```

### Discord Slash Commands

- `/status` — show current sandbox session for the thread
- `/reset` — destroy session so next message provisions a fresh sandbox

These map to the existing `!status` / `!reset` behavior.

## Health Endpoints

- `GET /healthz` — Liveness check (uptime, Discord status, active sessions)
- `GET /readyz` — Readiness check (200 when Discord connected, 503 otherwise)

## Architecture

```
Discord / CLI
  └─ Conversation service (Inbox → turn logic → Outbox)
       ├─ IngressDedup (message-id dedup in conversation path)
       ├─ OffsetStore (durable Discord catch-up offsets)
       └─ ThreadChatCluster.send(threadId)
            └─ ThreadEntity (cluster actor per thread)
                 ├─ active? → health check → reuse
                 ├─ paused? → SandboxProvisioner.resume() → reattach session
                 └─ missing? → SandboxProvisioner.provision() → new sandbox + session
```

Sessions are persisted in a local SQLite file. Sandbox filesystem (including OpenCode session state) survives pause/resume cycles via Daytona stop/start.
