import { FileFinder } from "@ff-labs/bun"
import { Log } from "@/util/log"
import { lazy } from "../util/lazy"

export namespace FFF {
  const log = Log.create({ service: "file.fff" })
  let base = ""
  const init = lazy(() => {
    const result = FileFinder.init({ basePath: base })
    if (!result.ok) {
      log.error("init failed", { error: result.error, cwd: base })
      return false
    }
    return true
  })

  export async function search(input: { cwd: string; query: string; limit: number }) {
    if (!input.query) return []
    if (!base) base = input.cwd
    if (!init()) return []

    const result = FileFinder.search(input.query, {
      pageIndex: 0,
      pageSize: input.limit,
    })
    if (!result.ok) {
      log.error("search failed", { error: result.error, query: input.query, cwd: input.cwd })
      return []
    }

    return result.value.items.map((item: { relativePath: string }) => item.relativePath)
  }
}
