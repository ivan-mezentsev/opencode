import { ChannelType } from "discord.js"
import type { GuildMember, Message, TextChannel, ThreadChannel } from "discord.js"
import { AppConfig } from "../config"

export type ChatChannel = TextChannel | ThreadChannel

export const isChannelAllowed = (channelId: string, categoryId: string | null, config: AppConfig.Service): boolean => {
  if (config.allowedChannelIds.length > 0 && config.allowedChannelIds.includes(channelId)) return true
  if (config.discordCategoryId && categoryId === config.discordCategoryId) return true
  return false
}

export const hasRequiredRole = (member: GuildMember | null, config: AppConfig.Service): boolean => {
  if (!config.discordRequiredRoleId) return true
  if (!member) return false
  return member.roles.cache.has(config.discordRequiredRoleId)
}

export const asThreadChannel = (value: unknown): ThreadChannel | null => {
  if (typeof value !== "object" || value === null) return null
  const type = (value as { type?: unknown }).type
  if (type === ChannelType.PublicThread || type === ChannelType.PrivateThread) return value as ThreadChannel
  return null
}

export const asTextChannel = (value: unknown): TextChannel | null => {
  if (typeof value !== "object" || value === null) return null
  const type = (value as { type?: unknown }).type
  if (type === ChannelType.GuildText) return value as TextChannel
  return null
}

export const isMentioned = (message: Message, botUserId: string, botRoleId: string): boolean => {
  if (botUserId.length > 0 && message.mentions.users.has(botUserId)) return true
  if (botRoleId.length > 0 && message.mentions.roles.has(botRoleId)) return true
  if (botUserId.length > 0 && message.content.includes(`<@${botUserId}>`)) return true
  if (botUserId.length > 0 && message.content.includes(`<@!${botUserId}>`)) return true
  if (botRoleId.length > 0 && message.content.includes(`<@&${botRoleId}>`)) return true
  return false
}
