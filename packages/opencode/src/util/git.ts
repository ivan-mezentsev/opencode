import { $ } from "bun"

function env() {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "echo",
    GIT_PAGER: "cat",
    PAGER: "",
  }
}

export async function gitText(args: string[], cwd: string): Promise<string> {
  const input = new Response("")
  return $`git ${args} < ${input}`.env(env()).cwd(cwd).quiet().nothrow().text()
}
