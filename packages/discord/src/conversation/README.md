# Conversation Experiment

This folder contains the active Discord conversation runtime.

Goal:

- keep inbound transport as a stream (`Inbox.events`)
- keep outbound transport as actions (`Outbox.publish`)
- support first-contact channel messages by resolving a thread target through `Threads.ensure`
- move orchestration into a transport-agnostic `Conversation` service

Current status:

- `model/schema.ts`: normalized event/action schema (`thread_message` and `channel_message`)
- `services/*`: service contracts (`Inbox`, `Outbox`, `History`, `Threads`, `ConversationLedger`) + `Conversation`
- `implementations/local/index.ts`: local implementation with `send()` / `take()` for non-Discord chat loops
- `implementations/discord/index.ts`: Discord implementation mapping message events to `Inbound` and actions to Discord sends
- `control/state.ts` + `control/cli.ts` + `control/controller.ts`: local CLI state, interactive CLI, and non-interactive controller commands

This module is wired into `src/index.ts`.

Reliability semantics:

- in-memory dedup by `message_id` prevents double-processing within a session
- startup catch-up fetches missed Discord messages from tracked thread sources and allowed channels using persisted offsets
- Discord is the durable inbox — on startup we resume from where we left off per source

Local CLI notes (`bun run conversation:cli`):

- `typing` now emits as soon as a target thread is resolved (before sandbox/session resolution), so startup latency is visible.
- channel and thread modes are explicit:
  - `/channel` routes to top-level channel mode
  - `/thread [id|n]` routes directly to thread mode (`n` is 1-based index from `/threads`; without arg, uses last seen thread)
  - `/threads` lists known thread ids with indexes
  - `/pick [n]` shows/selects a thread by index
- auto-switch from channel mode now only follows newly-seen threads (prevents jumping to old threads still emitting output)
- local thread simulation now mirrors Discord intent: each channel-mode message creates a new thread root, while explicit thread mode continues an existing thread
- local thread ids are human-readable (`thread-adjective-noun-n`) to make `/threads` easy to scan

Agent CLI notes (`bun run conversation:controller` or `bun run conversation:ctl`):

- non-interactive JSON output for automation (`ok: true/false`)
- commands:
  - `active`
  - `status --thread <id>`
  - `logs --thread <id> [--lines 120]`
  - `pause --thread <id>`
  - `destroy --thread <id>`
  - `resume --thread <id> [--channel <id> --guild <id>]`
  - `restart --thread <id>`
  - `send --thread <id> --text "<message>" [--follow --wait-ms 180000 --logs-every-ms 2000 --lines 80]`
