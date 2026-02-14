import { Effect, Option } from "effect"
import { OffsetStore } from "../conversation/offsets"

export const catchupFromOffset = <M>(input: {
  source: string
  pageSize: number
  offsets: OffsetStore.Service
  fetchLatest: Effect.Effect<Option.Option<M>, unknown>
  fetchAfter: (after: string) => Effect.Effect<ReadonlyArray<M>, unknown>
  idOf: (message: M) => string
  ingest: (message: M) => Effect.Effect<void, unknown>
}): Effect.Effect<number, unknown> => {
  const pull = (after: string): Effect.Effect<number, unknown> =>
    input.fetchAfter(after).pipe(
      Effect.flatMap((rows) => {
        if (rows.length === 0) return Effect.succeed(0)
        const last = rows.at(-1)
        if (!last) return Effect.succeed(0)
        return Effect.forEach(rows, input.ingest, { discard: true }).pipe(
          Effect.zipRight(
            rows.length < input.pageSize
              ? Effect.succeed(rows.length)
              : pull(input.idOf(last)).pipe(Effect.map((tail) => rows.length + tail)),
          ),
        )
      }),
    )

  return input.offsets.getOffset(input.source).pipe(
    Effect.flatMap((offset) => {
      if (Option.isNone(offset)) {
        return input.fetchLatest.pipe(
          Effect.flatMap((latest) => {
            if (Option.isNone(latest)) return Effect.succeed(0)
            return input.offsets.setOffset(input.source, input.idOf(latest.value)).pipe(Effect.as(0))
          }),
        )
      }
      return pull(offset.value)
    }),
  )
}
