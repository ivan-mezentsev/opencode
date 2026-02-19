export function relativizeProjectPaths(text: string, directory?: string) {
  if (!text) return ""
  if (!directory) return text
  if (directory === "/") return text
  if (directory === "\\") return text
  return text.split(directory).join("")
}
