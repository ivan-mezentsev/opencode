import { describe, expect } from "bun:test"
import { Effect, Option } from "effect"
import type { OffsetStore } from "../conversation/offsets"
import { effectTest } from "../test/effect"
import { catchupFromOffset } from "./catchup"

const makeOffsets = () => {
  const map = new Map<string, string>()
  const service: OffsetStore.Service = {
    getOffset: (source_id) => Effect.succeed(Option.fromNullable(map.get(source_id))),
    setOffset: (source_id, messageId) =>
      Effect.sync(() => {
        map.set(source_id, messageId)
      }),
  }
  return { service, map }
}

describe("catchupFromOffset", () => {
  effectTest("no offset seeds latest and does not ingest", () => {
    const offsets = makeOffsets()
    const ingested: Array<string> = []
    return catchupFromOffset({
      source: "thread:t1",
      pageSize: 2,
      offsets: offsets.service,
      fetchLatest: Effect.succeed(Option.some({ id: "m9" })),
      fetchAfter: () => Effect.succeed([]),
      idOf: (message) => message.id,
      ingest: (message) =>
        Effect.sync(() => {
          ingested.push(message.id)
        }),
    }).pipe(
      Effect.tap((count) => Effect.sync(() => {
        expect(count).toBe(0)
        expect(ingested).toEqual([])
        expect(offsets.map.get("thread:t1")).toBe("m9")
      })),
    )
  })

  effectTest("existing offset replays all pages in order", () => {
    const offsets = makeOffsets()
    offsets.map.set("thread:t1", "m1")
    const ingested: Array<string> = []
    const pages = new Map<string, ReadonlyArray<{ id: string }>>([
      ["m1", [{ id: "m2" }, { id: "m3" }]],
      ["m3", [{ id: "m4" }]],
    ])

    return catchupFromOffset({
      source: "thread:t1",
      pageSize: 2,
      offsets: offsets.service,
      fetchLatest: Effect.succeed(Option.none()),
      fetchAfter: (after) => Effect.succeed(pages.get(after) ?? []),
      idOf: (message) => message.id,
      ingest: (message) =>
        Effect.sync(() => {
          ingested.push(message.id)
        }),
    }).pipe(
      Effect.tap((count) => Effect.sync(() => {
        expect(count).toBe(3)
        expect(ingested).toEqual(["m2", "m3", "m4"])
      })),
    )
  })
})
