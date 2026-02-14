# ActorMap

Per-key serialized execution primitive. Think of it as a `Map<K, SerialQueue>` with optional idle timeouts and persistent state.

## Core Semantics

- `run(key, effect)` enqueues work onto the key's serial queue. Creates the actor (fiber + queue) on first access.
- Effects for the **same key** execute sequentially (FIFO). Effects for **different keys** run concurrently.
- `run` returns a `Deferred` result — the caller suspends until the work completes on the actor's fiber.
- `touch: false` option skips resetting the idle timer (used for bookkeeping reads that shouldn't extend session lifetime)

## State Management

`ActorMap<K, S>` supports optional per-key state (`Ref<Option<S>>`):

- `load(key)` hook runs on actor creation to hydrate from persistence (e.g. `SessionStore`)
- `save(key, state)` hook runs after `run` completes if state changed (reference equality check: `stateBefore !== stateAfter`)
- `run` can accept a function `(state: Ref<Option<S>>) => Effect<A, E>` instead of a bare Effect — this gives the callback access to the actor's state ref

## Idle Timeout Mechanics

When `idleTimeout` + `onIdle` are configured:

- Each `run` (with `touch: true`, the default) replaces the key's timer fiber in a `FiberMap`
- Timer fires `onIdle(key)` after the idle duration — typically pauses the sandbox and calls `actors.remove(key)`
- `cancelIdle(key)` cancels the timer without removing the actor

## Internal Structure

- `FiberMap<K>` for worker fibers (one per actor)
- `FiberMap<K>` for idle timer fibers (one per actor)
- `SynchronizedRef<Map<K, Entry<S>>>` for the actor registry
- `Queue.unbounded<Job>` per actor for the serial work queue
- Jobs use `Effect.uninterruptibleMask` + `Deferred` for safe completion signaling

## Gotchas

- `remove(key)` cancels all pending work (interrupts via `Deferred.interrupt`) and shuts down the queue. The key can be re-created by a subsequent `run`.
- State save is best-effort: `options.save` errors are silently caught (`Effect.catchAll(() => Effect.void)`)
- `load` errors are also silently caught — returns `Option.none()` on failure
- The `run` overload detection uses `Effect.isEffect(effectOrFn)` to distinguish bare effects from state-accessing functions
