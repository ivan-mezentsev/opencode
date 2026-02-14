import { Effect, Layer, Option } from "effect"
import { DatabaseError } from "../../../errors"
import { SessionStore } from "../../../session/store"
import type { ThreadId } from "../../../types"
import { LogsInput, PauseInput, ResumeInput, ThreadChatError, ThreadControlCluster } from "./contracts"
import { ThreadEntity } from "./entity"

const asThreadError = (threadId: ThreadId, cause: unknown): ThreadChatError => {
  if (cause instanceof ThreadChatError) return cause
  return ThreadChatError.make({
    threadId,
    cause,
    retriable: false,
  })
}

const asDatabaseError = (cause: unknown): DatabaseError => {
  if (cause instanceof DatabaseError) return cause
  return DatabaseError.make({ cause })
}

export const ThreadControlClusterLive = Layer.effect(
  ThreadControlCluster,
  Effect.gen(function* () {
    const make = yield* ThreadEntity.client
    const store = yield* SessionStore

    const active = store.listActive().pipe(Effect.mapError(asDatabaseError))

    const pause = Effect.fn("ThreadControlCluster.pause")(function* (input) {
      const rpc = make(input.threadId)
      const row = yield* rpc.pause(PauseInput.make({ reason: input.reason })).pipe(
        Effect.mapError((cause) => asThreadError(input.threadId, cause)),
      )
      if (row === null) return Option.none()
      return Option.some(row)
    })

    const resume = Effect.fn("ThreadControlCluster.resume")(function* (input) {
      const rpc = make(input.threadId)
      return yield* rpc.resume(
        ResumeInput.make({
          channelId: input.channelId,
          guildId: input.guildId,
        }),
      ).pipe(
        Effect.mapError((cause) => asThreadError(input.threadId, cause)),
      )
    })

    const logs = Effect.fn("ThreadControlCluster.logs")(function* (input) {
      const rpc = make(input.threadId)
      const row = yield* rpc.logs(LogsInput.make({ lines: input.lines })).pipe(
        Effect.mapError((cause) => asThreadError(input.threadId, cause)),
      )
      if (row === null) return Option.none()
      return Option.some({
        sandboxId: row.sandboxId,
        output: row.output,
      })
    })

    return ThreadControlCluster.of({ active, pause, resume, logs })
  }),
)
