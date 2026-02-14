export const EMPTY_MENTION_REPLY = "Tag me with a question!"
export const SETUP_FAILURE_REPLY = "Something went wrong setting up the thread."
export const COMMAND_NOT_THREAD_REPLY = "Use this command inside a Discord thread."
export const COMMAND_FORBIDDEN_REPLY = "You don't have the required role for this command."
export const COMMAND_CHANNEL_REPLY = "This thread is not allowed for the bot."
export const COMMAND_ACK = "Running command in this thread..."

export const COMMANDS = [
  {
    name: "status",
    description: "Show sandbox status for this thread",
  },
  {
    name: "reset",
    description: "Destroy the sandbox session for this thread",
  },
] as const

export const commandText = (name: string): string => {
  if (name === "status") return "!status"
  if (name === "reset") return "!reset"
  return ""
}
