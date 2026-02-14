import { describe, expect, it } from "bun:test"
import { ThreadId } from "../types"
import { Send, Typing } from "../conversation/model/schema"
import { autoThread, base, channelFrom, parse, prompt, queueTarget, scopeText, threadFrom } from "./state"

describe("cli-state", () => {
  it("parses commands", () => {
    expect(parse("hello")).toBeNull()
    expect(parse("/help")).toEqual({ kind: "help" })
    expect(parse("/channel")).toEqual({ kind: "channel" })
    expect(parse("/threads")).toEqual({ kind: "threads" })
    expect(parse("/pick")).toEqual({ kind: "pick", index: null })
    expect(parse("/pick 2")).toEqual({ kind: "pick", index: 2 })
    expect(parse("/active")).toEqual({ kind: "active" })
    expect(parse("/thread")).toEqual({ kind: "thread", threadId: null })
    expect(parse("/thread abc")).toEqual({ kind: "thread", threadId: ThreadId.make("abc") })
    expect(parse("/status")).toEqual({ kind: "status", threadId: null })
    expect(parse("/status abc")).toEqual({ kind: "status", threadId: ThreadId.make("abc") })
    expect(parse("/logs")).toEqual({ kind: "logs", lines: 120, threadId: null })
    expect(parse("/logs 80")).toEqual({ kind: "logs", lines: 80, threadId: null })
    expect(parse("/logs abc")).toEqual({ kind: "logs", lines: 120, threadId: ThreadId.make("abc") })
    expect(parse("/logs 80 abc")).toEqual({ kind: "logs", lines: 80, threadId: ThreadId.make("abc") })
    expect(parse("/pause")).toEqual({ kind: "pause", threadId: null })
    expect(parse("/recreate")).toEqual({ kind: "recreate", threadId: null })
    expect(parse("/destroy")).toEqual({ kind: "recreate", threadId: null })
    expect(parse("/resume")).toEqual({ kind: "resume", threadId: null })
    expect(parse("/nope")).toEqual({ kind: "unknown", name: "nope" })
  })

  it("formats scope and prompt", () => {
    const a = base()
    const b = threadFrom(a, ThreadId.make("t1"))
    expect(scopeText(a)).toBe("channel:local-channel")
    expect(scopeText(b)).toBe("thread:t1")
    expect(prompt(a)).toBe("channel> ")
    expect(prompt(b)).toBe("thread:t1> ")
    expect(queueTarget(a)).toBe("channel")
    expect(queueTarget(b)).toBe("thread")
    expect(channelFrom(b)).toEqual(a)
  })

  it("auto switches from channel to thread on action", () => {
    const a = base()
    const typing = Typing.make({ kind: "typing", threadId: ThreadId.make("t-a") })
    const send = Send.make({ kind: "send", threadId: ThreadId.make("t-b"), text: "ok" })

    expect(autoThread(a, typing)).toEqual(threadFrom(a, ThreadId.make("t-a")))
    expect(autoThread(a, send)).toEqual(threadFrom(a, ThreadId.make("t-b")))
    expect(autoThread(a, send, true)).toEqual(a)
    expect(autoThread(threadFrom(a, ThreadId.make("t0")), send)).toEqual(threadFrom(a, ThreadId.make("t0")))
  })
})
