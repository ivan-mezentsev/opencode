# Conversation Runtime

This folder contains the active conversation runtime used by the Discord bot.

## Active layout

- `model/*`: normalized inbound events + outbound actions and conversation error model.
- `conversation.ts`: core orchestration loop.
- `inbox.ts`, `outbox.ts`, `threads.ts`, `history.ts`, `dedup.ts`, `offsets.ts`: service contracts used by the runtime.
- `thread/cluster/*`: thread-scoped cluster runtime (`ThreadEntity`, `ThreadChatCluster`, `ThreadControlCluster`) for send/status/recreate/control.
- `../discord/adapter.ts`: Discord adapter implementation for inbox/outbox/thread/history ports.
- `../control/*`: local CLI/controller tooling.

## Current execution path

1. `Conversation.run` consumes `Inbox.events`.
2. `Conversation.turn` routes and resolves a thread target.
3. `Conversation` calls `ThreadChatCluster.send`.
4. `ThreadEntity` handles per-thread lifecycle/recovery/idempotent send.
5. `Outbox` publishes `typing` / `send` actions.

## Notes

- This module is wired from `packages/discord/src/index.ts`.
- Per-thread send idempotency is keyed by `messageId` in `thread/cluster` `send` RPC.
