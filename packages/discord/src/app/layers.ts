import { AnthropicClient, AnthropicLanguageModel } from "@effect/ai-anthropic"
import { SingleRunner, TestRunner } from "@effect/cluster"
import { FetchHttpClient } from "@effect/platform"
import { BunContext } from "@effect/platform-bun"
import { Effect, Layer, LogLevel, Logger } from "effect"
import { Conversation } from "../conversation/conversation"
import { IngressDedup } from "../conversation/dedup"
import { History } from "../conversation/history"
import { OffsetStore } from "../conversation/offsets"
import { ThreadChatClusterLive, ThreadControlClusterLive, ThreadEntityLive } from "../conversation/thread/cluster"
import { AppConfig } from "../config"
import { SqliteDb } from "../db/client"
import { DiscordConversationServicesLive } from "../discord/adapter"
import { DiscordClient } from "../discord/client"
import { TurnRouter } from "../discord/turn-routing"
import { LoggerLive } from "../observability/logger"
import { DaytonaService } from "../sandbox/daytona/service"
import { OpenCodeClient } from "../sandbox/opencode/client"
import { SandboxProvisioner } from "../sandbox/provisioner"
import { SessionStore } from "../session/store"

export const AnthropicLayer = Layer.unwrapEffect(
  Effect.gen(function* () {
    const config = yield* AppConfig
    return AnthropicLanguageModel.layer({ model: config.turnRoutingModel }).pipe(
      Layer.provide(AnthropicClient.layer({
        apiKey: config.openCodeZenApiKey,
        apiUrl: "https://opencode.ai/zen",
      })),
      Layer.provide(FetchHttpClient.layer),
    )
  }),
)

const Base = Layer.mergeAll(AppConfig.layer, FetchHttpClient.layer, BunContext.layer)

const AppBase = Layer.mergeAll(Base, LoggerLive)
const AppWithSqlite = Layer.provideMerge(SqliteDb.layer, AppBase)
const AppWithAnthropic = Layer.provideMerge(AnthropicLayer, AppWithSqlite)
const AppWithDaytona = Layer.provideMerge(DaytonaService.layer, AppWithAnthropic)
const AppWithOpenCode = Layer.provideMerge(OpenCodeClient.layer, AppWithDaytona)
const AppWithRouting = Layer.provideMerge(TurnRouter.layer, AppWithOpenCode)
const AppWithSessions = Layer.provideMerge(SessionStore.layer, AppWithRouting)
const AppWithProvisioner = Layer.provideMerge(SandboxProvisioner.layer, AppWithSessions)
const AppWithOffsets = Layer.provideMerge(OffsetStore.layer, AppWithProvisioner)
const AppWithDedup = Layer.provideMerge(IngressDedup.layer, AppWithOffsets)
const AppWithDiscordClient = Layer.provideMerge(DiscordClient.layer, AppWithDedup)
const AppWithDiscordAdapters = Layer.provideMerge(DiscordConversationServicesLive, AppWithDiscordClient)
const AppWithRunner = Layer.provideMerge(SingleRunner.layer({ runnerStorage: "memory" }), AppWithDiscordAdapters)
const AppWithThreadEntity = Layer.provideMerge(ThreadEntityLive, AppWithRunner)
const AppWithThreadChat = Layer.provideMerge(ThreadChatClusterLive, AppWithThreadEntity)
export const AppConversationLayer = Layer.provideMerge(Conversation.layer, AppWithThreadChat)

const ControlBase = Layer.mergeAll(Base, Logger.minimumLogLevel(LogLevel.None))
const ControlWithSqlite = Layer.provideMerge(SqliteDb.layer, ControlBase)
const ControlWithDaytona = Layer.provideMerge(DaytonaService.layer, ControlWithSqlite)
const ControlWithOpenCode = Layer.provideMerge(OpenCodeClient.layer, ControlWithDaytona)
const ControlWithSessions = Layer.provideMerge(SessionStore.layer, ControlWithOpenCode)
const ControlWithProvisioner = Layer.provideMerge(SandboxProvisioner.layer, ControlWithSessions)
const ControlWithRunner = Layer.provideMerge(TestRunner.layer, ControlWithProvisioner)
const ControlWithHistory = Layer.provideMerge(History.passthrough, ControlWithRunner)
const ControlWithThreadEntity = Layer.provideMerge(ThreadEntityLive, ControlWithHistory)
const ControlWithThreadChat = Layer.provideMerge(ThreadChatClusterLive, ControlWithThreadEntity)
export const ControlThreadLayer = Layer.provideMerge(ThreadControlClusterLive, ControlWithThreadChat)

const CliBase = Layer.mergeAll(Base, Logger.minimumLogLevel(LogLevel.Warning))
const CliWithSqlite = Layer.provideMerge(SqliteDb.layer, CliBase)
const CliWithAnthropic = Layer.provideMerge(AnthropicLayer, CliWithSqlite)
const CliWithDaytona = Layer.provideMerge(DaytonaService.layer, CliWithAnthropic)
const CliWithOpenCode = Layer.provideMerge(OpenCodeClient.layer, CliWithDaytona)
const CliWithRouting = Layer.provideMerge(TurnRouter.layer, CliWithOpenCode)
const CliWithSessions = Layer.provideMerge(SessionStore.layer, CliWithRouting)
const CliWithProvisioner = Layer.provideMerge(SandboxProvisioner.layer, CliWithSessions)
const CliWithRunner = Layer.provideMerge(TestRunner.layer, CliWithProvisioner)
const CliWithHistory = Layer.provideMerge(History.passthrough, CliWithRunner)
const CliWithThreadEntity = Layer.provideMerge(ThreadEntityLive, CliWithHistory)
const CliWithThreadChat = Layer.provideMerge(ThreadChatClusterLive, CliWithThreadEntity)
const CliWithThreadControl = Layer.provideMerge(ThreadControlClusterLive, CliWithThreadChat)
export const CliConversationStaticLayer = Layer.provideMerge(IngressDedup.noop, CliWithThreadControl)
