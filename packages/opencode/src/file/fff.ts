import { FileFinder } from "@ff-labs/bun"
import { Log } from "@/util/log"

export namespace FFF {
  const log = Log.create({ service: "file.fff" })

  const init = (cwd: string) => {
    const result = FileFinder.init({ basePath: cwd })
    if (result.ok) return true
    log.error("init failed", { error: result.error, cwd })
    return false
  }

  export async function search(input: { cwd: string; query: string; limit: number }) {
    if (!input.query) return []
    if (!init(input.cwd)) return []

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
