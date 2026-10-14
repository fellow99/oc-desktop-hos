/**
 * oc-plugin-harmony-search —— 用纯 JS 替换设备上不可用的 `grep` / `glob` 内置工具。
 *
 * 上游事实（specs/102-harmony-js-tools §4，均已核实）：
 *   - 插件默认导出契约（promise 口味）：`export default { id, setup(context) }`，没有函数形态的默认导出；
 *   - 自定义/覆盖内置工具：`context.tool.transform(editor => { editor.remove(id); editor.add(info) })`；
 *   - 内置插件 id 是 `opencode.tool.grep` / `opencode.tool.glob`，但**编辑器按「有效工具名」索引**
 *     （`core/src/tool.ts`：`add/update/remove` 面对的是 effectiveName，即未声明 namespace 时的
 *     裸名 `grep` / `glob`），因此两处 id 都 remove 一次，再用同名 `add` 覆盖（同名注册以最后一个为准）；
 *   - `input` 用纯 JSON Schema（插件是随包投放的独立 ESM，不参与上游 tsconfig）。
 *
 * ⚠️ setup 返回给宿主的 cleanup 必须是函数或 undefined：**不要** `return context.tool.transform(...)`，
 *    那样宿主拿到的会是 Registration 对象，卸载时会 `cleanup is not a function`。
 */
import fs from "node:fs"
import path from "node:path"
import {
  MAX_DEPTH,
  MAX_FILES,
  MAX_FILE_BYTES,
  MAX_LINE_CHARS,
  MAX_RESULTS,
  MAX_LIMIT,
  findTree,
  searchTree,
} from "./lib/walk.js"

const GREP_TOOL_ID = "opencode.tool.grep"
const GLOB_TOOL_ID = "opencode.tool.glob"
const GREP_TOOL_NAME = "grep"
const GLOB_TOOL_NAME = "glob"

export const GREP_INPUT = {
  type: "object",
  properties: {
    pattern: {
      type: "string",
      minLength: 1,
      description: "Regular expression or literal text to match in file contents.",
    },
    path: {
      type: "string",
      description: "File or directory to search, relative to the workspace root. Defaults to the workspace root.",
    },
    glob: {
      type: "string",
      description: 'Glob pattern used to filter which files are searched (for example "*.js" or "*.{ts,tsx}")',
    },
    ignoreCase: { type: "boolean", description: "Match case-insensitively (default: false)." },
    literal: {
      type: "boolean",
      description: "Treat `pattern` as exact text instead of a regular expression (default: false).",
    },
    limit: {
      type: "integer",
      minimum: 1,
      description: `Maximum number of matching lines to return (default: ${MAX_RESULTS}).`,
    },
  },
  required: ["pattern"],
  additionalProperties: false,
}

export const GLOB_INPUT = {
  type: "object",
  properties: {
    pattern: {
      type: "string",
      minLength: 1,
      description: 'Glob pattern to match file paths against (examples: "**/*.ts", "src/**/*.tsx", "*.md").',
    },
    path: {
      type: "string",
      description: "Directory to search, relative to the workspace root. Defaults to the workspace root.",
    },
    limit: {
      type: "integer",
      minimum: 1,
      description: `Maximum number of matching files to return (default: ${MAX_RESULTS}).`,
    },
  },
  required: ["pattern"],
  additionalProperties: false,
}

const GREP_DESCRIPTION = [
  "Search file contents for a regular expression or literal text, using a pure JavaScript walker",
  "(ripgrep is not available on this device).",
  "Returns matching file paths with line numbers and line previews.",
  "Narrow the search with `path` and `glob`.",
  `Hard limits: at most ${MAX_FILES} files per call, files are read up to ${MAX_FILE_BYTES} bytes,`,
  `directories deeper than ${MAX_DEPTH} levels and ${["`.git`", "`node_modules`", "`oh_modules`", "`.cache`", "`build`", "`.hvigor`"].join(", ")} are skipped,`,
  `lines are shown up to ${MAX_LINE_CHARS} characters, and results are capped at \`limit\` (default ${MAX_RESULTS}).`,
  "Every truncated result says so explicitly.",
].join(" ")

const GLOB_DESCRIPTION = [
  "Find file paths by glob pattern, using a pure JavaScript walker (ripgrep is not available on this device).",
  'Patterns without "/" match the file name at any depth (for example "*.md");',
  'patterns with "/" match the whole path relative to the workspace root (for example "src/**/*.ts").',
  `Hard limits: at most ${MAX_FILES} files per call, directories deeper than ${MAX_DEPTH} levels,`,
  `${["`.git`", "`node_modules`", "`oh_modules`", "`.cache`", "`build`", "`.hvigor`"].join(", ")} are skipped,`,
  `and results are capped at \`limit\` (default ${MAX_RESULTS}).`,
  "Every truncated result says so explicitly.",
].join(" ")

/** 输入校验（工具内兜底：JSON Schema 校验失败或未生效时也不能崩，要回可读错误） */
export function grepArguments(input = {}) {
  if (typeof input.pattern !== "string" || input.pattern.length === 0)
    return { ok: false, error: "Missing required argument `pattern`: expected a non-empty string." }
  if (input.path !== undefined && (typeof input.path !== "string" || input.path.length === 0))
    return { ok: false, error: "`path` must be a non-empty string when provided." }
  if (input.glob !== undefined && (typeof input.glob !== "string" || input.glob.length === 0))
    return { ok: false, error: "`glob` must be a non-empty string when provided." }
  const limit = input.limit
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1))
    return { ok: false, error: "`limit` must be a positive integer." }
  return {
    ok: true,
    value: {
      pattern: input.pattern,
      path: input.path,
      glob: input.glob,
      ignoreCase: input.ignoreCase === true,
      literal: input.literal === true,
      limit: Math.min(limit ?? MAX_RESULTS, MAX_LIMIT),
      limitClamped: (limit ?? MAX_RESULTS) > MAX_LIMIT,
    },
  }
}

export function globArguments(input = {}) {
  if (typeof input.pattern !== "string" || input.pattern.length === 0)
    return { ok: false, error: "Missing required argument `pattern`: expected a non-empty string." }
  if (input.path !== undefined && (typeof input.path !== "string" || input.path.length === 0))
    return { ok: false, error: "`path` must be a non-empty string when provided." }
  const limit = input.limit
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1))
    return { ok: false, error: "`limit` must be a positive integer." }
  return {
    ok: true,
    value: {
      pattern: input.pattern,
      path: input.path,
      limit: Math.min(limit ?? MAX_RESULTS, MAX_LIMIT),
      limitClamped: (limit ?? MAX_RESULTS) > MAX_LIMIT,
    },
  }
}

/** 截断说明：命中任何上限都必须显式出现在结果里（FR-tool-014，不得静默截断） */
function truncationNotes(truncated) {
  const notes = []
  if (truncated.results) notes.push("(Results are truncated: use a more specific `pattern`, `path` or `glob`.)")
  if (truncated.limitClamped) notes.push(`(The requested \`limit\` exceeded the hard cap and was clamped to ${MAX_LIMIT}.)`)
  if (truncated.files) notes.push(`(The walk stopped after ${MAX_FILES} files: not every file was searched.)`)
  if (truncated.depth)
    notes.push(`(The walk stopped at ${MAX_DEPTH} levels deep: deeper directories were not searched.)`)
  if (truncated.bytes)
    notes.push(`(Some files exceed ${MAX_FILE_BYTES} bytes and were searched only up to that limit.)`)
  if (truncated.lines) notes.push(`(Long lines were truncated to ${MAX_LINE_CHARS} characters.)`)
  return notes
}

/** grep 结果 → 模型可见文本（与上游 grep 的输出形状一致） */
export function formatGrepContent(result) {
  const lines = result.matches.length === 0 ? ["No matches found"] : [`Found ${result.matches.length} matches`]
  let current = ""
  for (const match of result.matches) {
    if (current !== match.path) {
      if (current) lines.push("")
      current = match.path
      lines.push(`${match.path}:`)
    }
    lines.push(`  Line ${match.line}: ${match.text}`)
  }
  const notes = truncationNotes(result.truncated)
  if (result.unreadable > 0) notes.push(`(${result.unreadable} files could not be read and were skipped.)`)
  if (result.errors.length > 0) notes.push(`(${result.errors.length} paths could not be listed and were skipped.)`)
  if (notes.length > 0) lines.push("", ...notes)
  return lines.join("\n")
}

/** glob 结果 → 模型可见文本 */
export function formatGlobContent(result) {
  const lines = result.entries.length === 0 ? ["No files found"] : result.entries.map((entry) => entry.path)
  const notes = truncationNotes(result.truncated)
  if (result.errors.length > 0) notes.push(`(${result.errors.length} paths could not be listed and were skipped.)`)
  if (notes.length > 0) lines.push("", ...notes)
  return lines.join("\n")
}

/**
 * 工具失败以**结果文本**返回，不抛异常：
 * 插件 promise 执行器被包在 `Effect.promise` 里（`packages/plugin/src/promise/adapter.ts`），
 * 抛出的错误会变成 defect 而不是 `Tool.Error`，可能直接终结该步。模型需要的是可读错误 + 重试。
 */
function errorResult(message) {
  return { content: `Error: ${message}`, metadata: { error: true, message } }
}

/** 解析搜索根：默认工作区根（插件是 Location 作用域的，setup 时捕获），`path` 相对它解析 */
function searchTarget(requested, root) {
  if (requested === undefined) return root
  return path.resolve(root, requested)
}

export function grepTool(root) {
  return {
    name: GREP_TOOL_NAME,
    description: GREP_DESCRIPTION,
    input: GREP_INPUT,
    options: { codemode: false },
    // 宿主契约是 `Promise<Tool.Result>`（packages/plugin/src/promise/tool.ts 的 `Info.execute`），
    // 宿主会直接 `.then(...)`。返回同步值会在运行期变成 `internalCall(...).then is not a function`
    // （2026-10-14 真机实测），因此这里必须是 async。
    execute: async (input) => {
      const parsed = grepArguments(input)
      if (!parsed.ok) return errorResult(parsed.error)
      const target = searchTarget(parsed.value.path, root)
      if (!fs.existsSync(target))
        return errorResult(`Search path does not exist: ${parsed.value.path ?? target}`)
      let result
      try {
        result = searchTree({
          root: target,
          base: root,
          pattern: parsed.value.pattern,
          glob: parsed.value.glob,
          literal: parsed.value.literal,
          ignoreCase: parsed.value.ignoreCase,
          limit: parsed.value.limit,
        })
      } catch (error) {
        return errorResult(`Invalid regular expression: ${parsed.value.pattern} (${error.message})`)
      }
      return {
        content: formatGrepContent(result),
        metadata: {
          root: target,
          matches: result.matches.map((match) => ({ path: match.path, line: match.line, text: match.text })),
          truncated: result.truncated,
          scanned: result.scanned,
          binary: result.binary,
          unreadable: result.unreadable,
        },
      }
    },
  }
}

export function globTool(root) {
  return {
    name: GLOB_TOOL_NAME,
    description: GLOB_DESCRIPTION,
    input: GLOB_INPUT,
    options: { codemode: false },
    execute: async (input) => {  // 同 grepTool：宿主会 `.then(...)`，必须返回 Promise
      const parsed = globArguments(input)
      if (!parsed.ok) return errorResult(parsed.error)
      const target = searchTarget(parsed.value.path, root)
      if (!fs.existsSync(target))
        return errorResult(`Search path does not exist: ${parsed.value.path ?? target}`)
      let result
      try {
        result = findTree({ root: target, base: root, pattern: parsed.value.pattern, limit: parsed.value.limit })
      } catch (error) {
        return errorResult(`Invalid glob pattern: ${parsed.value.pattern} (${error.message})`)
      }
      return {
        content: formatGlobContent(result),
        metadata: {
          root: target,
          files: result.entries.map((entry) => entry.path),
          truncated: result.truncated,
          scanned: result.scanned,
        },
      }
    },
  }
}

export default {
  id: "oc-harmony-search",
  async setup(context) {
    if (!context || !context.tool || typeof context.tool.transform !== "function")
      throw new Error("oc-harmony-search: unexpected plugin context (missing context.tool.transform)")
    const root = context.location && context.location.directory ? context.location.directory : process.cwd()
    await context.tool.transform((editor) => {
      // 上游内置工具 id（插件 id 形态）与编辑器实际索引键（有效工具名）都清一次，避免上游命名漂移后静默失效
      editor.remove(GREP_TOOL_ID)
      editor.remove(GREP_TOOL_NAME)
      editor.remove(GLOB_TOOL_ID)
      editor.remove(GLOB_TOOL_NAME)
      editor.add(grepTool(root))
      editor.add(globTool(root))
      // 上游 `add` 校验失败时只把原因推进 editor.errors（宿主仅记一条日志），
      // 而我们已经把内置工具 remove 掉了 ⇒ 若新增失败，模型将**同时失去** grep 与 glob 且没有任何失败信号。
      // 因此这里显式复查注册结果，缺失即抛错，让插件在 inventory 里变为 failed（fail-visible，FR-tool-019）。
      const missing = [GREP_TOOL_NAME, GLOB_TOOL_NAME].filter((name) => editor.get(name) === undefined)
      if (missing.length > 0)
        throw new Error(
          `oc-harmony-search: 工具注册失败（editor.get 取不到 ${missing.join(", ")}）；` +
            `上游 editor.errors=${JSON.stringify(editor.errors ?? null)}`,
        )
    })
  },
}
