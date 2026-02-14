import { Effect } from "effect"
import { type ChatChannel } from "./conversation-channels"

const HISTORY_FETCH_LIMIT = 40
const HISTORY_LINE_CHAR_LIMIT = 500
const HISTORY_TOTAL_CHAR_LIMIT = 6000

export const buildHistoryReplayPrompt = Effect.fn("DiscordAdapter.buildHistoryReplayPrompt")(
  function* (channel: ChatChannel, latest: string) {
    const fetched = yield* Effect.tryPromise(() => channel.messages.fetch({ limit: HISTORY_FETCH_LIMIT }))
    const ordered = [...fetched.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp)
    const lines = ordered
      .filter((prior) => !prior.system)
      .flatMap((prior) => {
        const text = prior.content.replace(/\s+/g, " ").trim()
        const files = prior.attachments.size > 0
          ? `[attachments: ${[...prior.attachments.values()].map((att) => att.name ?? "file").join(", ")}]`
          : ""
        const line = text || files
        if (!line) return []
        const value = line.length > HISTORY_LINE_CHAR_LIMIT ? `${line.slice(0, HISTORY_LINE_CHAR_LIMIT)}...` : line
        return [`${prior.author.bot ? "assistant" : "user"}: ${value}`]
      })

    const prior = lines.at(-1) === `user: ${latest}` ? lines.slice(0, -1) : lines
    if (prior.length === 0) return latest

    const selected = prior.reduceRight(
      (state, candidate) => {
        if (state.stop) return state
        if (state.total + candidate.length > HISTORY_TOTAL_CHAR_LIMIT && state.list.length > 0) {
          return { ...state, stop: true }
        }
        return { list: [candidate, ...state.list], total: state.total + candidate.length, stop: false }
      },
      { list: [] as ReadonlyArray<string>, total: 0, stop: false },
    ).list

    return [
      "Conversation history from this same Discord thread (oldest to newest):",
      selected.join("\n"),
      "",
      "Continue the same conversation and respond to the latest user message:",
      latest,
    ].join("\n")
  },
)
