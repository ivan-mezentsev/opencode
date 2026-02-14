# Conversation Module

Transport-agnostic conversation engine. Discord-specific code lives in `implementations/discord/`, not here.

## Hexagonal Architecture (Ports & Adapters)

The conversation service depends on 5 port interfaces, NOT concrete implementations:

- `Inbox` — `Stream.Stream<Inbound>` of incoming events
- `Outbox` — publishes `Action` (send/reply/typing) and wraps effects with typing indicators
- `History` — rehydrates thread context when sessions change
- `Threads` — resolves channel messages to thread targets (creates Discord threads)
- `ConversationLedger` — durable dedup, state checkpointing, offset tracking

The `Conversation` service (`services/conversation.ts`) consumes these ports. Implementations are swapped at the Layer level:

- `implementations/discord/` provides all 5 ports for production via `DiscordConversationServices.portLayer`
- `implementations/local/` provides all 5 for the local CLI via `makeTui`
- Tests use `ConversationLedger.noop` and `Outbox.noop` in-memory stubs

## Event Flow (Non-Obvious)

1. Discord `messageCreate` → `onMessage` callback → `Runtime.runPromise(runtime)(ingestMessage(msg))`
   - This bridges callback-land into Effect. The runtime is captured once at Layer construction.
2. `ingestMessage` → `ledger.admit(event)` (dedup) → `input.offer(event)` (Queue)
3. `Inbox.events` = `Stream.fromQueue(input)` — consumed by `Conversation.run`
4. `Conversation.run` maps each event through `turn()` with `{ concurrency: "unbounded", unordered: true }`
5. `turn()` serializes per-key via `ActorMap` (`keyOf` = `thread:<id>` or `channel:<id>`)
6. Key insight: **unbounded concurrency across threads, serial within each thread**

## Ledger Checkpointing (Crash Recovery)

The `ConversationLedger` stores intermediate state so retries don't re-call the LLM:

- `admit` → inserts with status `pending`, returns `false` if already seen (dedup)
- `start` → atomically moves `pending` → `processing`, increments `attempts`, returns snapshot
- `setTarget` → caches resolved `thread_id`/`channel_id`
- `setPrompt` → caches the (possibly rehydrated) prompt text + `session_id`
- `setResponse` → caches the LLM response text
- `complete` → marks `completed`
- `retry` → resets to `pending` with `last_error`

On restart: `replayPending()` resets `processing` → `pending` and returns all pending events.
On recovery: if `response_text` is already set, the turn skips the LLM call and just re-publishes.

## Offset Tracking

`ConversationLedger.getOffset`/`setOffset` persist the last-seen Discord message ID per source (`channel:<id>` or `thread:<id>`). On startup, `recoverMissedMessages` in the Discord adapter fetches messages after the stored offset to catch anything missed while offline.

## Error Union Pattern

`ConversationError` is a `Schema.Union` of 6 tagged errors, each with a `retriable: boolean` field. The retry schedule (`turnRetry`) checks `error.retriable` via `Schedule.whileInput`. Non-retriable errors trigger a user-visible "try again" message before failing.

## `portLayer` Pattern (Multi-Service Layer)

`DiscordConversationServices.portLayer` uses `Layer.scopedContext` to provide **4 services in a single Layer** by building a `Context` manually:

```ts
return Context.empty().pipe(
  Context.add(Inbox, inbox),
  Context.add(Outbox, outbox),
  Context.add(History, history),
  Context.add(Threads, threads),
)
```

This is the pattern for providing multiple related ports from one implementation module.

## Turn Routing

`TurnRouter` in `src/discord/turn-routing.ts` decides whether to respond to unmentioned thread messages:

- Mode `off`: always respond
- Mode `heuristic`: regex-based rules, default respond on uncertainty
- Mode `ai`: calls Haiku via `@effect/ai-anthropic` with `max_tokens: 10` for RESPOND/SKIP
- Heuristic runs first in `ai` mode; AI is only called when heuristic returns `null`

## Files That Must Change Together

- Adding a new `Inbound` event kind → `model/schema.ts` + `implementations/discord/index.ts` + `implementations/local/index.ts`
- Adding a new `Action` kind → `model/schema.ts` + both implementations' `publish`/outbox handling
- Adding a new error type → `model/errors.ts` + update `ConversationError` union + handle in `conversation.ts`
- Adding a new port service → `services/` interface + both `implementations/` + wire in `src/index.ts` layer chain
