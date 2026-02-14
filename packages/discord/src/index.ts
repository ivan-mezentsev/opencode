import { BunRuntime } from "@effect/platform-bun"
import { Effect, Layer } from "effect"
import { AppConversationLayer } from "./app/layers"
import { Conversation } from "./conversation/conversation"
import { DiscordClient } from "./discord/client"
import { HealthServer } from "./http/health"

const AppLayer = Layer.provideMerge(HealthServer.layer, AppConversationLayer)

const main = Effect.gen(function* () {
  const client = yield* DiscordClient
  const conversation = yield* Conversation
  yield* HealthServer

  yield* Effect.forkScoped(conversation.run)
  yield* Effect.logInfo("Discord bot ready").pipe(
    Effect.annotateLogs({ event: "discord.ready", tag: client.user?.tag }),
  )

  yield* Effect.logInfo("Discord bot started")
  return yield* Effect.never
})

main.pipe(
  Effect.provide(AppLayer),
  Effect.scoped,
  BunRuntime.runMain,
)
