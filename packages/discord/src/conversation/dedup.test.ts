import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { effectTest } from "../test/effect"
import { IngressDedup } from "./dedup"

describe("IngressDedup", () => {
  effectTest("dedup returns true first time, false second time", () =>
    Effect.gen(function* () {
      const dedup = yield* IngressDedup
      expect(yield* dedup.dedup("m1")).toBe(true)
      expect(yield* dedup.dedup("m1")).toBe(false)
      expect(yield* dedup.dedup("m2")).toBe(true)
      expect(yield* dedup.dedup("m2")).toBe(false)
    }).pipe(Effect.provide(IngressDedup.noop)),
  )

  effectTest("layer mode behaves as memory dedup", () =>
    Effect.gen(function* () {
      const dedup = yield* IngressDedup
      expect(yield* dedup.dedup("m1")).toBe(true)
      expect(yield* dedup.dedup("m1")).toBe(false)
      expect(yield* dedup.dedup("m2")).toBe(true)
    }).pipe(Effect.provide(IngressDedup.layer)),
  )
})
