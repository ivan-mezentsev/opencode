import { Effect, Layer, Option } from "effect"
import { DatabaseError } from "../../../errors"
import type { ThreadId } from "../../../types"
import { SendInput, ThreadChatCluster, ThreadChatError } from "./contracts"
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

export const ThreadChatClusterLive = Layer.effect(
  ThreadChatCluster,
  Effect.gen(function* () {
    const make = yield* ThreadEntity.client

    const send = Effect.fn("ThreadChatCluster.send")(function* (input) {
      const rpc = make(input.threadId)
      const out = yield* rpc
        .send(
          SendInput.make({
            channelId: input.channelId,
            guildId: input.guildId,
            messageId: input.messageId,
            text: input.text,
          }),
        )
        .pipe(
        Effect.mapError((cause) => asThreadError(input.threadId, cause)),
      )
      return {
        text: out.text,
        session: out.session,
        changedSession: out.changedSession,
      }
    })

    const status = Effect.fn("ThreadChatCluster.status")(function* (threadId) {
      const rpc = make(threadId)
      const row = yield* rpc.status(undefined).pipe(Effect.mapError(asDatabaseError))
      if (row === null) return Option.none()
      return Option.some(row)
    })

    const recreate = Effect.fn("ThreadChatCluster.recreate")(function* (threadId) {
      const rpc = make(threadId)
      yield* rpc.recreate(undefined).pipe(Effect.mapError(asDatabaseError))
    })

    return ThreadChatCluster.of({ send, status, recreate })
  }),
)
