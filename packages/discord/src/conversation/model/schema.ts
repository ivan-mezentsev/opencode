import { Schema } from "effect"
import { ThreadId, ChannelId, GuildId } from "../../types"

export class Mention extends Schema.Class<Mention>("Mention")({
  userIds: Schema.Array(Schema.String),
  roleIds: Schema.Array(Schema.String),
}) {}

export class ThreadMessage extends Schema.Class<ThreadMessage>("ThreadMessage")({
  kind: Schema.Literal("thread_message"),
  threadId: ThreadId,
  channelId: ChannelId,
  messageId: Schema.String,
  guildId: GuildId,
  botUserId: Schema.String,
  botRoleId: Schema.String,
  authorId: Schema.String,
  authorIsBot: Schema.Boolean,
  mentionsEveryone: Schema.Boolean,
  mentions: Mention,
  content: Schema.String,
}) {}

export class ChannelMessage extends Schema.Class<ChannelMessage>("ChannelMessage")({
  kind: Schema.Literal("channel_message"),
  channelId: ChannelId,
  messageId: Schema.String,
  guildId: GuildId,
  botUserId: Schema.String,
  botRoleId: Schema.String,
  authorId: Schema.String,
  authorIsBot: Schema.Boolean,
  mentionsEveryone: Schema.Boolean,
  mentions: Mention,
  content: Schema.String,
}) {}

export const Inbound = Schema.Union(
  ThreadMessage,
  ChannelMessage,
)

export type Inbound = typeof Inbound.Type

export class ThreadRef extends Schema.Class<ThreadRef>("ThreadRef")({
  threadId: ThreadId,
  channelId: ChannelId,
}) {}

export class Send extends Schema.Class<Send>("Send")({
  kind: Schema.Literal("send"),
  threadId: ThreadId,
  text: Schema.String,
}) {}

export class Reply extends Schema.Class<Reply>("Reply")({
  kind: Schema.Literal("reply"),
  threadId: ThreadId,
  text: Schema.String,
}) {}

export class Typing extends Schema.Class<Typing>("Typing")({
  kind: Schema.Literal("typing"),
  threadId: ThreadId,
}) {}

export const Action = Schema.Union(
  Send,
  Reply,
  Typing,
)

export type Action = typeof Action.Type
