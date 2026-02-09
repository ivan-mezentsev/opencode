import { Prompt, type PromptRef } from "@tui/component/prompt"
import { createMemo, For, Match, onMount, Show, Switch } from "solid-js"
import { useTheme } from "@tui/context/theme"
import { useKeybind } from "@tui/context/keybind"
import { Locale } from "@/util/locale"
import { useSync } from "../context/sync"
import { Toast } from "../ui/toast"
import { useArgs } from "../context/args"
import { useDirectory } from "../context/directory"
import { useRoute, useRouteData } from "@tui/context/route"
import { usePromptRef } from "../context/prompt"
import { Installation } from "@/installation"
import { useKV } from "../context/kv"
import { useCommandDialog } from "../component/dialog-command"
import { useLocal } from "../context/local"
import { RoundedBorder } from "../component/border"
import { useTerminalDimensions } from "@opentui/solid"

// TODO: what is the best way to do this?
let once = false

const STARTER_TIPS = [
  "Type @ followed by a filename to attach files",
  "Start a message with ! to run shell commands",
  "Press Tab to cycle between Build and Plan agents",
  "Run /init to create an AGENTS.md with instructions",
]

export function Home() {
  const sync = useSync()
  const kv = useKV()
  const { theme } = useTheme()
  const route = useRouteData("home")
  const promptRef = usePromptRef()
  const command = useCommandDialog()
  const local = useLocal()
  const { navigate } = useRoute()
  const dimensions = useTerminalDimensions()
  const mcp = createMemo(() => Object.keys(sync.data.mcp).length > 0)
  const mcpError = createMemo(() => {
    return Object.values(sync.data.mcp).some((x) => x.status === "failed")
  })

  const connectedMcpCount = createMemo(() => {
    return Object.values(sync.data.mcp).filter((x) => x.status === "connected").length
  })

  const isFirstTimeUser = createMemo(() => sync.data.session.length === 0)
  const tipsHidden = createMemo(() => kv.get("tips_hidden", false))
  const showTips = createMemo(() => {
    if (isFirstTimeUser()) return false
    return !tipsHidden()
  })

  command.register(() => [
    {
      title: tipsHidden() ? "Show tips" : "Hide tips",
      value: "tips.toggle",
      keybind: "tips_toggle",
      category: "System",
      onSelect: (dialog) => {
        kv.set("tips_hidden", !tipsHidden())
        dialog.clear()
      },
    },
  ])

  const recentSessions = createMemo(() => {
    return sync.data.session
      .filter((x) => !x.parentID)
      .toSorted((a, b) => b.time.updated - a.time.updated)
      .slice(0, 5)
  })

  const wide = createMemo(() => dimensions().width > 80)

  let prompt: PromptRef
  const args = useArgs()
  onMount(() => {
    if (once) return
    if (route.initialPrompt) {
      prompt.set(route.initialPrompt)
      once = true
    } else if (args.prompt) {
      prompt.set({ input: args.prompt, parts: [] })
      once = true
      prompt.submit()
    }
  })
  const directory = useDirectory()

  return (
    <>
      <box flexGrow={1} justifyContent="center" alignItems="center" paddingLeft={2} paddingRight={2} gap={1}>
        <box height={2} />
        {/* Bordered welcome box */}
        <box
          width="100%"
          maxWidth={90}
          border={["top", "bottom", "left", "right"]}
          customBorderChars={RoundedBorder}
          borderColor={theme.border}
          title={` OpenCode v${Installation.VERSION} `}
          titleAlignment="left"
        >
          <box
            flexDirection={wide() ? "row" : "column"}
            paddingTop={1}
            paddingBottom={1}
            paddingLeft={2}
            paddingRight={2}
            gap={wide() ? 4 : 2}
          >
            {/* Left column */}
            <box flexGrow={1}>
              <text fg={theme.text}>
                <b>Welcome back!</b>
              </text>
              <box paddingTop={1}>
                <text fg={theme.textMuted}>
                  {local.model.parsed().model} · {local.model.parsed().provider}
                </text>
                <Show when={mcp()}>
                  <text fg={theme.text}>
                    <Switch>
                      <Match when={mcpError()}>
                        <span style={{ fg: theme.error }}>●</span> {connectedMcpCount()} MCP · errors
                      </Match>
                      <Match when={true}>
                        <span style={{ fg: theme.success }}>●</span>{" "}
                        {Locale.pluralize(connectedMcpCount(), "{} MCP server", "{} MCP servers")}
                      </Match>
                    </Switch>
                  </text>
                </Show>
                <text fg={theme.textMuted}>{directory()}</text>
              </box>
            </box>
            {/* Right column */}
            <box flexGrow={1}>
              <Show when={showTips()}>
                <text fg={theme.primary}>
                  <b>Tips for getting started</b>
                </text>
                <For each={STARTER_TIPS}>{(tip) => <text fg={theme.textMuted}>{tip}</text>}</For>
              </Show>
              <box paddingTop={showTips() ? 1 : 0}>
                <text fg={theme.primary}>
                  <b>Recent activity</b>
                </text>
                <Show when={recentSessions().length === 0}>
                  <text fg={theme.textMuted}>No recent activity</text>
                </Show>
                <For each={recentSessions()}>
                  {(session) => (
                    <box
                      flexDirection="row"
                      gap={1}
                      onMouseUp={() => navigate({ type: "session", sessionID: session.id })}
                    >
                      <text fg={theme.textMuted} wrapMode="none">
                        {Locale.truncate(session.title, wide() ? 35 : 50)}
                      </text>
                    </box>
                  )}
                </For>
              </box>
            </box>
          </box>
        </box>
        <box width="100%" maxWidth={90} zIndex={1000} paddingTop={1}>
          <Prompt
            ref={(r) => {
              prompt = r
              promptRef.set(r)
            }}
          />
        </box>
        <Toast />
      </box>
    </>
  )
}
