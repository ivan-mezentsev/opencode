import { Context, Effect, Option, PrimaryKey, Schema } from "effect"
import { DatabaseError } from "../../../errors"
import { ChannelId, GuildId, SandboxId, SessionInfo, ThreadId } from "../../../types"

export class ThreadChatError extends Schema.TaggedError<ThreadChatError>()(
  "ThreadChatError",
  {
    threadId: ThreadId,
    cause: Schema.Defect,
    retriable: Schema.Boolean,
  },
) {}

export class SendInput extends Schema.Class<SendInput>("ClusterMode/SendInput")({
  channelId: ChannelId,
  guildId: GuildId,
  messageId: Schema.String,
  text: Schema.String,
}) {
  [PrimaryKey.symbol]() {
    return this.messageId
  }
}

export class SendOutput extends Schema.Class<SendOutput>("ClusterMode/SendOutput")({
  text: Schema.String,
  session: SessionInfo,
  changedSession: Schema.Boolean,
}) {}

export class PauseInput extends Schema.Class<PauseInput>("ClusterMode/PauseInput")({
  reason: Schema.String,
}) {}

export class ResumeInput extends Schema.Class<ResumeInput>("ClusterMode/ResumeInput")({
  channelId: Schema.NullOr(ChannelId),
  guildId: Schema.NullOr(GuildId),
}) {}

export class LogsInput extends Schema.Class<LogsInput>("ClusterMode/LogsInput")({
  lines: Schema.Number.pipe(
    Schema.int(),
    Schema.between(1, 500),
  ),
}) {}

export class LogsOutput extends Schema.Class<LogsOutput>("ClusterMode/LogsOutput")({
  sandboxId: SandboxId,
  output: Schema.String,
}) {}

export declare namespace ThreadChatCluster {
  export interface Service {
    readonly send: (input: {
      threadId: ThreadId
      channelId: ChannelId
      guildId: GuildId
      messageId: string
      text: string
    }) => Effect.Effect<{
      text: string
      session: SessionInfo
      changedSession: boolean
    }, ThreadChatError>
    readonly status: (threadId: ThreadId) => Effect.Effect<Option.Option<SessionInfo>, DatabaseError>
    readonly recreate: (threadId: ThreadId) => Effect.Effect<void, DatabaseError>
  }
}

export class ThreadChatCluster extends Context.Tag("@discord/conversation/thread/cluster/ThreadChatCluster")<
  ThreadChatCluster,
  ThreadChatCluster.Service
>() {}

export declare namespace ThreadControlCluster {
  export interface Service {
    readonly active: Effect.Effect<ReadonlyArray<SessionInfo>, DatabaseError>
    readonly pause: (input: {
      threadId: ThreadId
      reason: string
    }) => Effect.Effect<Option.Option<SessionInfo>, ThreadChatError>
    readonly resume: (input: {
      threadId: ThreadId
      channelId: ChannelId | null
      guildId: GuildId | null
    }) => Effect.Effect<SessionInfo, ThreadChatError>
    readonly logs: (input: {
      threadId: ThreadId
      lines: number
    }) => Effect.Effect<Option.Option<{ sandboxId: SandboxId; output: string }>, ThreadChatError>
  }
}

export class ThreadControlCluster extends Context.Tag("@discord/conversation/thread/cluster/ThreadControlCluster")<
  ThreadControlCluster,
  ThreadControlCluster.Service
>() {}
