import { dlopen, ptr } from "bun:ffi"

const STD_INPUT_HANDLE = -10
const ENABLE_PROCESSED_INPUT = 0x0001

const kernel = () =>
  dlopen("kernel32.dll", {
    GetStdHandle: { args: ["i32"], returns: "ptr" },
    GetConsoleMode: { args: ["ptr", "ptr"], returns: "i32" },
    SetConsoleMode: { args: ["ptr", "u32"], returns: "i32" },
    SetConsoleCtrlHandler: { args: ["ptr", "i32"], returns: "i32" },
  })

let k32: ReturnType<typeof kernel> | undefined

function load() {
  if (process.platform !== "win32") return false
  try {
    k32 ??= kernel()
    return true
  } catch {
    return false
  }
}

/**
 * Clear ENABLE_PROCESSED_INPUT on the console stdin handle.
 */
export function win32DisableProcessedInput() {
  if (process.platform !== "win32") return
  if (!process.stdin.isTTY) return
  if (!load()) return

  const handle = k32!.symbols.GetStdHandle(STD_INPUT_HANDLE)
  const buf = new Uint32Array(1)
  if (k32!.symbols.GetConsoleMode(handle, ptr(buf)) === 0) return

  const mode = buf[0]!
  if ((mode & ENABLE_PROCESSED_INPUT) === 0) return
  k32!.symbols.SetConsoleMode(handle, mode & ~ENABLE_PROCESSED_INPUT)
}

/**
 * Tell Windows to ignore CTRL_C_EVENT for this process.
 *
 * SetConsoleCtrlHandler(NULL, TRUE) makes the process ignore Ctrl+C
 * signals at the OS level. Belt-and-suspenders alongside disabling
 * ENABLE_PROCESSED_INPUT.
 */
export function win32IgnoreCtrlC() {
  if (process.platform !== "win32") return
  if (!process.stdin.isTTY) return
  if (!load()) return

  k32!.symbols.SetConsoleCtrlHandler(null, 1)
}

/**
 * Continuously enforce ENABLE_PROCESSED_INPUT=off on the console.
 *
 * opentui reconfigures the console mode through native calls (not
 * process.stdin.setRawMode) so we cannot intercept them. Instead we
 * poll at a low frequency and re-clear the flag when needed.
 *
 * Because ENABLE_PROCESSED_INPUT is a console-level flag (not per-process),
 * keeping it cleared protects every process attached to this console,
 * including the parent `bun run` wrapper that we can't otherwise control.
 *
 * The fast-path (GetConsoleMode + bitmask check) is sub-microsecond;
 * SetConsoleMode only fires when something re-enabled the flag.
 */
export function win32EnforceCtrlCGuard() {
  if (process.platform !== "win32") return
  if (!process.stdin.isTTY) return
  if (!load()) return

  const handle = k32!.symbols.GetStdHandle(STD_INPUT_HANDLE)
  const buf = new Uint32Array(1)

  setInterval(() => {
    if (k32!.symbols.GetConsoleMode(handle, ptr(buf)) === 0) return
    const mode = buf[0]!
    if ((mode & ENABLE_PROCESSED_INPUT) === 0) return
    k32!.symbols.SetConsoleMode(handle, mode & ~ENABLE_PROCESSED_INPUT)
  }, 100)
}
