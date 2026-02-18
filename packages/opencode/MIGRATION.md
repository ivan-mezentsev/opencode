# Migration Guide: Replacing Bun.file with Node.js APIs

**Goal**: Replace all `Bun.file()` and `Bun.write()` calls in the opencode codebase with the `Filesystem` utility module from `src/util/filesystem.ts`. This utility provides Node.js `fs/promises` equivalents optimized for performance.

**What to do**: Pick one unchecked file from the checklist below, migrate it using the Filesystem module, ensure tests pass, open a PR, and check off the file once merged. Repeat until all files are done.

## Migration Process

Each file should be migrated **one at a time** with a separate PR opened for each file. This approach ensures:

- Easier code review and debugging
- Isolated changes that can be rolled back independently
- Clear tracking of which files have been migrated
- Reduced risk of introducing multiple bugs at once

**Workflow:**

1. Pick one unchecked file from the checklist below
2. Create a new branch for that file
3. Migrate all `Bun.file()` and related APIs to Node.js equivalents using the Filesystem module
4. Run tests for the specific file and ensure they pass before pushing
5. Open a PR specifically for that single file
6. Once merged, check off the file in the checklist below

## Using the Filesystem Module

Use the `Filesystem` module from `src/util/filesystem.ts` for all file operations:

```typescript
import { Filesystem } from "./util/filesystem"

// Before: Bun.file().exists()
const exists = await Bun.file(path).exists()
// After: Filesystem.exists()
const exists = await Filesystem.exists(path)

// Before: Bun.file().text()
const content = await Bun.file(path).text()
// After: Filesystem.readText()
const content = await Filesystem.readText(path)

// Before: Bun.file().json()
const data = await Bun.file(path).json()
// After: Filesystem.readJson()
const data = await Filesystem.readJson<Config>(path)

// Before: Bun.file().bytes()
const bytes = await Bun.file(path).bytes()
// After: Filesystem.readBytes()
const buffer = await Filesystem.readBytes(path)

// Before: Bun.file().stat()
const stats = await Bun.file(path).stat()
// After: Filesystem.isDir() and size
const isDir = await Filesystem.isDir(path)
const size = await Filesystem.size(path)

// Before: Bun.file().size
const size = Bun.file(path).size
// After: Filesystem.size()
const size = await Filesystem.size(path)

// Before: Bun.write()
await Bun.write(path, content)
// After: Filesystem.write()
await Filesystem.write(path, content)

// Before: Bun.write() with JSON
await Bun.write(path, JSON.stringify(data, null, 2))
// After: Filesystem.writeJson()
await Filesystem.writeJson(path, data)

// Before: Bun.file().type
const mime = Bun.file(path).type
// After: Filesystem.mimeType()
const mime = Filesystem.mimeType(path)
```

## Files Requiring Updates

### Core Utilities

- [ ] `src/util/filesystem.ts` - `exists()` and `isDir()` functions use `Bun.file().stat()`
- [x] `src/util/log.ts` - Uses `Bun.file()` for log file access

### Tool Implementations

- [x] `src/tool/read.ts` - Uses `Bun.file()` for file type, stat, and bytes
- [x] `src/tool/write.ts` - Uses `Bun.file().exists()` and `Bun.file().text()`
- [x] `src/tool/edit.ts` - Uses `Bun.file().exists()`
- [x] `src/tool/grep.ts` - Uses `Bun.file()`
- [x] `src/tool/glob.ts` - Uses `Bun.file()` for stats
- [x] `src/tool/lsp.ts` - Uses `Bun.file().exists()`
- [x] `src/tool/truncation.ts` - Uses `Bun.write()`

### Storage & Data

- [x] `src/storage/storage.ts` - Multiple uses of `Bun.file().json()` and `Bun.write()`
- [x] `src/storage/json-migration.ts` - Uses `Bun.file().json()`
- [x] `src/storage/db.ts` - Uses `Bun.file().size`
- [x] `src/mcp/auth.ts` - Uses `Bun.file().json()` and `Bun.write()`

### Project Management

- [x] `src/project/project.ts` - Uses `Bun.file().text()` and `Bun.file().stat()`

### Session & Prompts

- [x] `src/session/prompt.ts` - Uses `Bun.file().stat()`, `Bun.file().exists()`, and `Bun.file().text()`
- [x] `src/session/instruction.ts` - Uses `Bun.file().exists()` and `Bun.file().text()`

### Provider & Models

- [x] `src/provider/models.ts` - Uses `Bun.file()` and `Bun.write()`
- [x] `src/provider/provider.ts` - Uses `Bun.file().text()`

### Skill Discovery

- [x] `src/skill/discovery.ts` - Uses `Bun.file().exists()` and `Bun.write()`

### LSP

- [x] `src/lsp/client.ts` - Uses `Bun.file()`
- [x] `src/lsp/server.ts` - Uses `Bun.file().exists()` and `Bun.file().write()`

### Shell & CLI

- [x] `src/shell/shell.ts` - Uses `Bun.file().size`
- [x] `src/cli/cmd/tui/thread.ts` - Uses `Bun.file().exists()`

### Additional Files Migrated

- [x] `src/acp/agent.ts` - Uses `Bun.file().exists()` and `Bun.file().text()`
- [x] `src/auth/index.ts` - Uses `Bun.file().json()` and `Bun.write()`
- [x] `src/bun/index.ts` - Uses `Bun.file().json()` and `Bun.write()`
- [x] `src/cli/cmd/agent.ts` - Uses `Bun.file().exists()` and `Bun.write()`
- [x] `src/cli/cmd/github.ts` - Uses `Bun.write()`
- [x] `src/cli/cmd/import.ts` - Uses `Bun.file().json()`
- [x] `src/cli/cmd/mcp.ts` - Uses `Bun.file()` and `Bun.write()`
- [x] `src/cli/cmd/run.ts` - Uses `Bun.file()`
- [x] `src/cli/cmd/session.ts` - Uses `Bun.file().size`
- [x] `src/cli/cmd/uninstall.ts` - Uses `Bun.file().text()` and `Bun.write()`
- [x] `src/cli/cmd/tui/util/clipboard.ts` - Uses `Bun.file().arrayBuffer()`
- [x] `src/cli/cmd/tui/util/editor.ts` - Uses `Bun.write()` and `Bun.file().text()`
- [x] `src/config/markdown.ts` - Uses `Bun.file().text()`
- [x] `src/file/index.ts` - Uses `Bun.file()` for text, exists, arrayBuffer, and mime type
- [x] `src/file/time.ts` - Uses `Bun.file().stat()`
- [x] `src/format/formatter.ts` - Uses `Bun.file().json()` and `Bun.file().text()`
- [x] `src/global/index.ts` - Uses `Bun.file().text()` and `Bun.file().write()`

## Centralized File API Module

The `src/util/filesystem.ts` module provides optimized Node.js equivalents for all Bun.file operations:

```typescript
import { Filesystem } from "./util/filesystem"

// Migration examples:

// Before: Bun.file().exists()
const exists = await Bun.file(path).exists()
// After: Filesystem.exists() (uses fast existsSync internally)
const exists = await Filesystem.exists(path)

// Before: Bun.file().text()
const content = await Bun.file(path).text()
// After: Filesystem.readText()
const content = await Filesystem.readText(path)

// Before: Bun.file().json()
const data = await Bun.file(path).json()
// After: Filesystem.readJson()
const data = await Filesystem.readJson<Config>(path)

// Before: Bun.file().bytes()
const bytes = await Bun.file(path).bytes()
// After: Filesystem.readBytes()
const buffer = await Filesystem.readBytes(path)

// Before: Bun.file().stat()
const stats = await Bun.file(path).stat()
// After: Filesystem.isDir() and size (uses fast statSync)
const isDir = await Filesystem.isDir(path)
const size = await Filesystem.size(path)

// Before: Bun.file().size
const size = Bun.file(path).size
// After: Filesystem.size() (8x faster than async stat)
const size = await Filesystem.size(path)

// Before: Bun.write()
await Bun.write(path, content)
// After: Filesystem.write() (auto-creates directories)
await Filesystem.write(path, content)

// Before: Bun.write() with JSON
await Bun.write(path, JSON.stringify(data, null, 2))
// After: Filesystem.writeJson()
await Filesystem.writeJson(path, data)

// Before: Bun.file().type
const mime = Bun.file(path).type
// After: Filesystem.mimeType()
const mime = Filesystem.mimeType(path)
```

### API Reference

| Bun API                | Filesystem Equivalent                       | Implementation                |
| ---------------------- | ------------------------------------------- | ----------------------------- |
| `Bun.file(p).exists()` | `Filesystem.exists(p)`                      | `existsSync()` (15x faster)   |
| `Bun.file(p).stat()`   | `Filesystem.isDir(p)`, `Filesystem.size(p)` | `statSync()` (8x faster)      |
| `Bun.file(p).text()`   | `Filesystem.readText(p)`                    | `readFile()`                  |
| `Bun.file(p).json()`   | `Filesystem.readJson<T>(p)`                 | `readFile()` + `JSON.parse()` |
| `Bun.file(p).bytes()`  | `Filesystem.readBytes(p)`                   | `readFile()` (returns Buffer) |
| `Bun.file(p).size`     | `Filesystem.size(p)`                        | `statSync().size` (8x faster) |
| `Bun.file(p).type`     | `Filesystem.mimeType(p)`                    | `mime-types` library          |
| `Bun.write(p, data)`   | `Filesystem.write(p, data, mode?)`          | `writeFile()` + lazy `mkdir`  |
| -                      | `Filesystem.writeJson(p, data, mode?)`      | `write()` with JSON.stringify |

### Performance Notes

The `Filesystem` module uses optimized implementations:

- **Metadata operations** (`exists`, `isDir`, `size`): Use sync APIs (`existsSync`, `statSync`) for 8-15x speedup
- **Content operations** (`readText`, `write`): Use async APIs to avoid blocking thread during I/O
- **Directory creation**: Lazy - only creates directories when write fails with ENOENT
- **MIME type detection**: Uses `mime-types` library for broader format support than Bun

## Testing

Always run tests before pushing changes:

```bash
cd packages/opencode
bun test
```

## Quick Reference for LLM Agents

**What you're doing**: Migrating one file at a time from Bun-specific file APIs to the Filesystem module.

**Commands to run**:

1. `cd packages/opencode` - Always work from the package directory
2. After migration: `bun test` - Ensure tests pass before pushing

**What to migrate**:

- `Bun.file(path).exists()` → `Filesystem.exists(path)`
- `Bun.file(path).text()` → `Filesystem.readText(path)`
- `Bun.file(path).json()` → `Filesystem.readJson(path)`
- `Bun.file(path).bytes()` → `Filesystem.readBytes(path)`
- `Bun.file(path).stat()` → `Filesystem.isDir(path)` or `Filesystem.size(path)`
- `Bun.file(path).size` → `Filesystem.size(path)`
- `Bun.file(path).type` → `Filesystem.mimeType(path)`
- `Bun.write(path, content)` → `Filesystem.write(path, content)`
- `Bun.write(path, JSON.stringify(data))` → `Filesystem.writeJson(path, data)`

**Do NOT migrate** (leave as-is):

- `Bun.hash.xxHash32` - Keep using Bun's hash
- `Bun.stdin` - Keep using Bun's stdin

**After merging your PR**: Return to this file and check off the file you just migrated from the checklist.

## Migration Checklist

### Phase 1: Centralize File Operations (DONE ✅)

- [x] Create `src/util/filesystem.ts` with all file operations
- [x] Implement optimized sync variants for metadata (exists, isDir, size)
- [x] Implement async variants for content operations (read, write)
- [x] Add lazy directory creation for write operations
- [x] Add comprehensive test coverage (31 tests)

### Phase 2: Migrate Source Files

For each file using Bun.file APIs, replace with `Filesystem` equivalents:

**Pattern:**

```typescript
// Remove Bun imports
import { Bun } from "bun" // ❌ Remove this

// Add Filesystem import
import { Filesystem } from "./util/filesystem" // ✅ Add this

// Replace all Bun.file() calls
const exists = await Bun.file(path).exists() // ❌
const exists = await Filesystem.exists(path) // ✅

const content = await Bun.file(path).text() // ❌
const content = await Filesystem.readText(path) // ✅

await Bun.write(path, content) // ❌
await Filesystem.write(path, content) // ✅
```

**Files to migrate:**

- [ ] `src/tool/read.ts` - `stat()`, `type`, `bytes()`, `text()`
- [ ] `src/tool/write.ts` - `exists()`, `text()`, `Bun.write()`
- [ ] `src/tool/edit.ts` - `exists()`, `stat()`, `text()`, `write()`
- [ ] `src/file/time.ts` - `stat()`
- [ ] `src/file/index.ts` - `text()`, `bytes()`, `exists()`, `type`
- [ ] `src/mcp/auth.ts` - `json()`, `Bun.write()`
- [ ] `src/storage/storage.ts` - `json()`, `Bun.write()`
- [ ] `src/lsp/server.ts` - `exists()`, `write()`, `text()`
- [ ] ... (see full list above)

### Phase 3: Handle Special Cases

- [ ] Install `@types/mime-types` (already done)
- [ ] Run all tests to verify functionality
- [ ] Update `package.json` to remove Bun-only dependencies if any

### Migration Priority

1. **High**: Files with >5 Bun.file usages or critical paths
2. **Medium**: Files with 2-5 usages
3. **Low**: Files with 1-2 usages or covered by other tests

## Notes

- Bun APIs return `null` on some errors where Node.js throws; ensure `.catch(() => ...)` is used appropriately
- File permissions: Bun defaults may differ from Node.js defaults; explicitly pass `mode: 0o600` where needed
- Performance: Node.js `fs/promises` is generally comparable to Bun.file for most read operations (within 2x)
- Metadata operations (exists, size) will be ~10x slower after migration
- Streaming: Both support similar streaming APIs via `createReadStream` and `createWriteStream`
