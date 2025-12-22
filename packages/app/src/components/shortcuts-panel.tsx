import { For, createSignal, Show, onMount, onCleanup } from "solid-js"
import { Tabs } from "@opencode-ai/ui/tabs"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { parseKeybind } from "@/context/command"

const IS_MAC = typeof navigator === "object" && /(Mac|iPod|iPhone|iPad)/.test(navigator.platform)

const SPECIAL_CHAR_NAMES: Record<string, string> = {
  "^": "Control",
  "⌥": "Option",
  "⇧": "Shift",
  "⌘": "Command",
  "↑": "Arrow Up",
  "↓": "Arrow Down",
  "`": "Backtick",
  "'": "Quote",
  ".": "Period",
  ",": "Comma",
  "/": "Slash",
  "\\": "Backslash",
  "[": "Left Bracket",
  "]": "Right Bracket",
  "-": "Minus",
  "=": "Equals",
  ";": "Semicolon",
}

const KEY_DISPLAY_MAP: Record<string, string> = {
  arrowup: "↑",
  arrowdown: "↓",
  arrowleft: "←",
  arrowright: "→",
  backspace: "⌫",
}

interface Shortcut {
  title: string
  keybind: string
}

interface ShortcutCategory {
  name: string
  shortcuts: Shortcut[]
}

function isLetter(char: string): boolean {
  return /^[A-Za-z]$/.test(char)
}

function getKeyChars(config: string): string[] {
  const keybinds = parseKeybind(config)
  if (keybinds.length === 0) return []

  const kb = keybinds[0]
  const chars: string[] = []

  if (kb.ctrl) chars.push(IS_MAC ? "^" : "Ctrl")
  if (kb.alt) chars.push(IS_MAC ? "⌥" : "Alt")
  if (kb.shift) chars.push(IS_MAC ? "⇧" : "Shift")
  if (kb.meta) chars.push(IS_MAC ? "⌘" : "Meta")

  if (kb.key) {
    const mapped = KEY_DISPLAY_MAP[kb.key.toLowerCase()]
    if (mapped) {
      chars.push(mapped)
    } else {
      const displayKey = kb.key.length === 1 ? kb.key.toUpperCase() : kb.key.charAt(0).toUpperCase() + kb.key.slice(1)
      for (const char of displayKey) {
        chars.push(char)
      }
    }
  }

  return chars
}

const SHORTCUT_CATEGORIES: ShortcutCategory[] = [
  {
    name: "General",
    shortcuts: [
      { title: "Command palette", keybind: "mod+shift+p" },
      { title: "Toggle sidebar", keybind: "mod+b" },
      { title: "Toggle shortcuts", keybind: "ctrl+/" },
      { title: "Open file", keybind: "mod+p" },
      { title: "Open project", keybind: "mod+o" },
    ],
  },
  {
    name: "Session",
    shortcuts: [
      { title: "New session", keybind: "mod+shift+s" },
      { title: "Previous session", keybind: "alt+arrowup" },
      { title: "Next session", keybind: "alt+arrowdown" },
      { title: "Archive session", keybind: "mod+shift+backspace" },
      { title: "Undo", keybind: "mod+z" },
      { title: "Redo", keybind: "mod+shift+z" },
    ],
  },
  {
    name: "Navigation",
    shortcuts: [
      { title: "Previous message", keybind: "mod+arrowup" },
      { title: "Next message", keybind: "mod+arrowdown" },
      { title: "Toggle steps", keybind: "mod+e" },
    ],
  },
  {
    name: "Model and Agent",
    shortcuts: [
      { title: "Choose model", keybind: "mod+'" },
      { title: "Cycle agent", keybind: "mod+." },
    ],
  },
  {
    name: "Terminal",
    shortcuts: [
      { title: "Toggle terminal", keybind: "ctrl+`" },
      { title: "New terminal", keybind: "ctrl+shift+`" },
    ],
  },
]

const USED_SHORTCUTS_KEY = "opencode:used-shortcuts"

function getUsedShortcuts(): Set<string> {
  const stored = localStorage.getItem(USED_SHORTCUTS_KEY)
  return stored ? new Set(JSON.parse(stored)) : new Set()
}

const [usedShortcuts, setUsedShortcuts] = createSignal(getUsedShortcuts())

function formatKeybindForCopy(config: string): string {
  const chars = getKeyChars(config)
  return chars.join("")
}

function ShortcutItem(props: { shortcut: Shortcut }) {
  const [copied, setCopied] = createSignal(false)
  const used = () => usedShortcuts().has(props.shortcut.keybind)

  function copyToClipboard() {
    const text = formatKeybindForCopy(props.shortcut.keybind)
    navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <Tooltip value="Copy to clipboard" placement="top">
      <button type="button" class="shortcut-item" classList={{ "shortcut-used": used() }} onClick={copyToClipboard}>
        <span class="text-14-regular text-text-base">{props.shortcut.title}</span>
        <Show
          when={!copied()}
          fallback={
            <div class="shortcut-copied">
              <Icon name="check" size="small" />
            </div>
          }
        >
          <div class="shortcut-keys">
            <For each={getKeyChars(props.shortcut.keybind)}>
              {(char) => {
                const tooltip = SPECIAL_CHAR_NAMES[char]
                return (
                  <Show when={tooltip && !isLetter(char)} fallback={<kbd class="shortcut-key">{char}</kbd>}>
                    <Tooltip value={tooltip} placement="top">
                      <kbd class="shortcut-key">{char}</kbd>
                    </Tooltip>
                  </Show>
                )
              }}
            </For>
          </div>
        </Show>
      </button>
    </Tooltip>
  )
}

export function ShortcutsPanel(props: { onClose: () => void }) {
  const [activeTab, setActiveTab] = createSignal(SHORTCUT_CATEGORIES[0].name)

  onMount(() => {
    const handler = () => setUsedShortcuts(getUsedShortcuts())
    window.addEventListener("shortcut-used", handler)
    onCleanup(() => window.removeEventListener("shortcut-used", handler))
  })

  return (
    <div class="shortcuts-panel" data-component="shortcuts-panel">
      <Tabs value={activeTab()} onChange={setActiveTab}>
        <div class="shortcuts-tabs-row">
          <Tabs.List class="shortcuts-tabs-list">
            <For each={SHORTCUT_CATEGORIES}>
              {(category) => <Tabs.Trigger value={category.name}>{category.name}</Tabs.Trigger>}
            </For>
          </Tabs.List>
          <IconButton icon="close" variant="ghost" onClick={props.onClose} />
        </div>
        <For each={SHORTCUT_CATEGORIES}>
          {(category) => (
            <Tabs.Content value={category.name} class="shortcuts-content">
              <div class="shortcuts-grid">
                <For each={category.shortcuts}>{(shortcut) => <ShortcutItem shortcut={shortcut} />}</For>
              </div>
            </Tabs.Content>
          )}
        </For>
      </Tabs>
    </div>
  )
}
