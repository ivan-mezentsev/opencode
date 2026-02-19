/// <reference path="../env.d.ts" />
import { tool } from "@opencode-ai/plugin"
import DESCRIPTION from "./github-issue-search.txt"

async function githubFetch(endpoint: string, options: RequestInit = {}) {
  const response = await fetch(`https://api.github.com${endpoint}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      ...options.headers,
    },
  })
  if (!response.ok) {
    throw new Error(`GitHub API error: ${response.status} ${response.statusText}`)
  }
  return response.json()
}

interface Issue {
  title: string
  html_url: string
}

export default tool({
  description: DESCRIPTION,
  args: {
    query: tool.schema.string().describe("Search query for issue titles and descriptions"),
    limit: tool.schema.number().describe("Maximum number of results to return").default(10),
    offset: tool.schema.number().describe("Number of results to skip for pagination").default(0),
  },
  async execute(args) {
    const owner = "anomalyco"
    const repo = "opencode"

    const page = Math.floor(args.offset / args.limit) + 1
    const searchQuery = encodeURIComponent(`${args.query} repo:${owner}/${repo} type:issue state:open`)
    const result = await githubFetch(
      `/search/issues?q=${searchQuery}&per_page=${args.limit}&page=${page}&sort=updated&order=desc`,
    )

    if (result.total_count === 0) {
      return `No issues found matching "${args.query}"`
    }

    const issues = result.items as Issue[]

    if (issues.length === 0) {
      return `No other issues found matching "${args.query}"`
    }

    const formatted = issues.map((issue) => `${issue.title}\n${issue.html_url}`).join("\n\n")

    return `Found ${result.total_count} issues (showing ${issues.length}):\n\n${formatted}`
  },
})
