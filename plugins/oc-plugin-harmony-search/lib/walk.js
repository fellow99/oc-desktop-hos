/**
 * oc-plugin-harmony-search / lib/walk.js
 *
 * 纯 JS 遍历器 + 匹配器：无第三方依赖、无子进程、无原生模块（供 index.js 的 grep / glob 共用）。
 *
 * 为什么需要它（specs/102-harmony-js-tools §3 G2/G3）：
 *   上游 `grep` / `glob` 必然经 `Ripgrep.Service` spawn `rg` 二进制，而设备上 `rg` 不可得
 *   （`core/src/ripgrep/binary.ts` 的 PLATFORM 表没有 `arm64-ohos` 键 ⇒ 直接抛
 *   `unsupported platform for ripgrep`）。因此内容搜索与文件名搜索只能在本进程内用纯 JS 做。
 *
 * 硬上限（FR-tool-014，命中即必须在结果里显式标注，不得静默截断）：
 *   - MAX_FILES        单次遍历的文件数上限
 *   - MAX_FILE_BYTES   单文件读取上限（超出按字节截断）
 *   - MAX_DEPTH        遍历深度上限
 *   - MAX_LINE_CHARS   单行显示上限
 *   - MAX_RESULTS      结果条数上限（可用工具的 `limit` 覆盖）
 *
 * 深度口径（与 host 侧测试一致）：条目的深度 = 相对搜索根的段数（目录计入）。
 * 根目录下的一级文件 depth = 1；只处理 depth ≤ MAX_DEPTH 的条目，因此不会进入
 * depth = MAX_DEPTH 的子目录（其内容 depth ≥ MAX_DEPTH + 1，必然超限），
 * 此时 `truncated.depth = true`。
 */
import fs from "node:fs"
import path from "node:path"

export const MAX_FILES = 2000
export const MAX_FILE_BYTES = 524288
export const MAX_DEPTH = 8
export const MAX_LINE_CHARS = 300
export const MAX_RESULTS = 200
/**
 * 单次调用可请求的结果条数**硬上限**（FR-tool-014：上限不可被入参绕过）。
 * 模型可以传 `limit`，但只能把上限**收紧**到 MAX_LIMIT 以内；超出即被钳制并**显式标注**。
 * 为什么必须有硬上限：没有它时 `limit: 1000000` 会让 `results` 提前 break 永不触发，
 * 遍历读到 MAX_FILES × MAX_FILE_BYTES（≈1 GB）并把每行匹配都存成对象 ⇒ 服务端 OOM/挂死，
 * 而服务端在 `inprocess` 宿主形态下就是 Electron 主进程。
 */
export const MAX_LIMIT = 1000
/**
 * `matcher.test()` 的作用窗口（FR-tool-014）。匹配**只作用于每行的前 N 个字符**：
 * 模型给出的正则是不可信的（嵌套量词如 `(a+)+$` 会产生灾难性回溯），而 JS 正则没有超时机制，
 * 在服务端唯一线程上会**永久阻塞**（上游 `rg` 是线性时间，因此这是本替代方案新引入的失败面）。
 * 限制窗口不能根治回溯，但把最坏情况的输入规模压到可控范围；残余风险在
 * `plugins/oc-plugin-harmony-search/README.md` 登记为已知限制。
 */
export const MAX_MATCH_CHARS = 4096
export const BINARY_PROBE_BYTES = 8000

/** 噪声/规模控制：这些目录名一律不进入（FR-tool-015） */
export const SKIP_DIRS = new Set([".git", "node_modules", "oh_modules", ".cache", "build", ".hvigor"])

const toMessage = (error) => (error && error.message ? error.message : String(error))

/** 路径统一为可跨平台比较的正斜杠形式（Windows 上 path.sep 是反斜杠） */
export const portablePath = (value) => value.split(path.sep).join("/")

/** 展示路径：优先相对搜索基准（工作区根），越界时回落为绝对路径 */
export function displayPath(absolute, base) {
  const relative = portablePath(path.relative(base, absolute))
  if (relative === "" || relative.startsWith("..")) return portablePath(absolute)
  return relative
}

export const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/**
 * 迭代式 BFS 遍历（不递归，避免深目录爆栈）。
 * 不可读/缺失目录只记入 errors 并继续（FR-tool-015）；符号链接与特殊文件一律跳过。
 */
export function walk(root, options = {}) {
  const maxFiles = options.maxFiles ?? MAX_FILES
  const maxDepth = options.maxDepth ?? MAX_DEPTH
  const resolvedRoot = path.resolve(root)
  const files = []
  const errors = []
  const truncated = { files: false, depth: false }

  let stats
  try {
    stats = fs.statSync(resolvedRoot)
  } catch (error) {
    errors.push({ path: resolvedRoot, message: toMessage(error) })
    return { files, errors, truncated }
  }
  if (!stats.isDirectory()) {
    files.push({ absolute: resolvedRoot, path: path.basename(resolvedRoot) })
    return { files, errors, truncated }
  }

  const queue = [{ absolute: resolvedRoot, depth: 0 }]
  while (queue.length > 0) {
    const current = queue.shift()
    if (files.length >= maxFiles) {
      truncated.files = true
      break
    }
    let entries
    try {
      entries = fs.readdirSync(current.absolute, { withFileTypes: true })
    } catch (error) {
      errors.push({ path: current.absolute, message: toMessage(error) })
      continue
    }
    // 排序保证结果可复现（readdir 顺序依文件系统而定）
    for (const entry of entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))) {
      const absolute = path.join(current.absolute, entry.name)
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        if (current.depth + 1 < maxDepth) queue.push({ absolute, depth: current.depth + 1 })
        else truncated.depth = true
        continue
      }
      if (!entry.isFile()) continue
      if (files.length >= maxFiles) {
        truncated.files = true
        break
      }
      files.push({ absolute, path: portablePath(path.relative(resolvedRoot, absolute)) })
    }
  }
  return { files, errors, truncated }
}

/**
 * 读取文本文件。返回值区分三态，便于调用方统计而不是抛错：
 *   { kind: "text", text, truncated, bytes } | { kind: "binary" } | { kind: "error", message }
 * 二进制判定：前 BINARY_PROBE_BYTES 字节内出现 NUL（与上游 rg 的口径一致：只看头部）。
 */
export function readTextFile(absolute, maxBytes = MAX_FILE_BYTES) {
  let handle
  try {
    handle = fs.openSync(absolute, "r")
    const stats = fs.fstatSync(handle)
    // 目录 / FIFO / 设备文件不是「可搜索的文本文件」：直接拒绝，避免读 0 字节当成空文件或阻塞
    if (!stats.isFile()) return { kind: "error", message: `Not a regular file: ${absolute}` }
    const size = stats.size
    const probeLength = Math.min(BINARY_PROBE_BYTES, size)
    const probe = Buffer.alloc(probeLength)
    const probed = fs.readSync(handle, probe, 0, probeLength, 0)
    if (probe.subarray(0, probed).includes(0)) return { kind: "binary" }
    const length = Math.min(size, maxBytes)
    const buffer = Buffer.alloc(length)
    let read = 0
    while (read < length) {
      const chunk = fs.readSync(handle, buffer, read, length - read, read)
      if (chunk === 0) break
      read += chunk
    }
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, read))
      return { kind: "text", text, truncated: size > maxBytes, bytes: size }
    } catch {
      return { kind: "binary" }
    }
  } catch (error) {
    return { kind: "error", message: toMessage(error) }
  } finally {
    if (handle !== undefined) {
      try {
        fs.closeSync(handle)
      } catch {
        // 关闭失败不影响结果，忽略
      }
    }
  }
}

/** 构造行匹配器；`literal: true` 时模式按字面量处理（不解释正则元字符） */
export function createMatcher(options = {}) {
  const source = options.literal ? escapeRegExp(options.pattern) : options.pattern
  return new RegExp(source, options.ignoreCase ? "i" : "")
}

/** 单行显示截断（FR-tool-014）：超出即截断并回报，不静默 */
export function truncateLine(text, maxChars = MAX_LINE_CHARS) {
  if (text.length <= maxChars) return { text, truncated: false }
  return { text: text.slice(0, maxChars), truncated: true }
}

/** glob → 正则源（支持 `**` / `*` / `?` / `[...]` / `{a,b}`） */
export function globSource(pattern) {
  let source = ""
  let index = 0
  while (index < pattern.length) {
    const char = pattern[index]
    if (char === "*") {
      if (pattern[index + 1] !== "*") {
        source += "[^/]*"
        index += 1
        continue
      }
      if (pattern[index + 2] === "/") {
        source += "(?:.*/)?"
        index += 3
        continue
      }
      source += ".*"
      index += 2
      continue
    }
    if (char === "?") {
      source += "[^/]"
      index += 1
      continue
    }
    if (char === "[") {
      const close = pattern.indexOf("]", index + 1)
      if (close > index) {
        const body = pattern.slice(index + 1, close)
        // globset 的取反类是 `[!abc]`，而 RegExp 用 `[^abc]`；直接透传会让 `[!abc]` 变成
        // 「! 或 a 或 b 或 c」（`[!.]*` 这类常见写法会静默给出错误结果）。
        // 只翻译**开头**的 `!`：`[a!b]` 里的 `!` 是普通字符，保持原样。
        const translated = body.startsWith("!") ? "^" + body.slice(1) : body
        // 仍以第一个 `]` 截断，所以类里不可能逃逸出未转义的内容
        source += "[" + translated + "]"
        index = close + 1
        continue
      }
    }
    if (char === "{") {
      const close = pattern.indexOf("}", index + 1)
      if (close > index) {
        const alternatives = pattern.slice(index + 1, close).split(",").map(escapeRegExp)
        source += `(?:${alternatives.join("|")})`
        index = close + 1
        continue
      }
    }
    source += escapeRegExp(char)
    index += 1
  }
  return source
}

/**
 * glob 匹配器。模式含 `/` 时匹配整条相对路径，否则按**基名**匹配
 * （即 `*.md` 命中任意层级，与 ripgrep `--glob` 的语义一致）。
 */
export function compileGlob(pattern) {
  const matcher = new RegExp(`^${globSource(String(pattern))}$`)
  if (String(pattern).includes("/")) return (relative) => matcher.test(relative)
  return (relative) => matcher.test(path.posix.basename(relative))
}

/** grep 语义：遍历 + 逐行匹配。返回 { matches:[{path,absolute,line,text}], truncated, ... } */
export function searchTree(options) {
  const root = options.root
  const base = options.base ?? root
  // 入参只能收紧上限（FR-tool-014）：超出即钳制，钳制事实在 truncated.limitClamped 上显式带出
  const requested = options.limit ?? MAX_RESULTS
  const limit = Math.max(1, Math.min(requested, MAX_LIMIT))
  const limitClamped = requested > MAX_LIMIT
  const matcher = createMatcher(options)
  const walked = walk(root, { maxFiles: options.maxFiles, maxDepth: options.maxDepth })
  const fileFilter = options.glob ? compileGlob(options.glob) : undefined
  const truncated = { ...walked.truncated, results: false, lines: false, bytes: false, limitClamped }
  const matches = []
  let scanned = 0
  let binary = 0
  let unreadable = 0

  for (const file of walked.files) {
    const relative = displayPath(file.absolute, base)
    if (fileFilter && !fileFilter(relative)) continue
    const read = readTextFile(file.absolute, options.maxFileBytes)
    if (read.kind === "binary") {
      binary += 1
      continue
    }
    if (read.kind === "error") {
      unreadable += 1
      continue
    }
    if (read.truncated) truncated.bytes = true
    scanned += 1
    // 行切分：结尾的 "\n" 不产生幽灵空行（否则 `^`/`$`/`a?` 会在文件尾多报一条 rg 不会报的匹配）
    const rawLines = read.text.split("\n")
    if (rawLines.length > 1 && rawLines[rawLines.length - 1] === "") rawLines.pop()
    const lines = rawLines
    for (let index = 0; index < lines.length; index += 1) {
      const raw = lines[index].endsWith("\r") ? lines[index].slice(0, -1) : lines[index]
      // 只在前 MAX_MATCH_CHARS 个字符上跑正则（见 MAX_MATCH_CHARS 的说明：不可信正则的规模闸门）
      const window = raw.length > MAX_MATCH_CHARS ? raw.slice(0, MAX_MATCH_CHARS) : raw
      if (raw.length > MAX_MATCH_CHARS) truncated.lines = true
      if (!matcher.test(window)) continue
      if (matches.length >= limit) {
        truncated.results = true
        break
      }
      const shown = truncateLine(raw)
      if (shown.truncated) truncated.lines = true
      matches.push({ path: relative, absolute: file.absolute, line: index + 1, text: shown.text })
    }
    if (truncated.results) break
  }

  return { matches, truncated, scanned, binary, unreadable, files: walked.files.length, errors: walked.errors }
}

/** glob 语义：遍历 + 文件名匹配。返回 { entries:[{path,absolute}], truncated, ... } */
export function findTree(options) {
  const root = options.root
  const base = options.base ?? root
  // 同 searchTree：入参只能收紧结果上限
  const globRequested = options.limit ?? MAX_RESULTS
  const limit = Math.max(1, Math.min(globRequested, MAX_LIMIT))
  const matcher = compileGlob(options.pattern)
  const walked = walk(root, { maxFiles: options.maxFiles, maxDepth: options.maxDepth })
  const truncated = { ...walked.truncated, results: false, limitClamped: globRequested > MAX_LIMIT }
  const entries = []

  for (const file of walked.files) {
    const relative = displayPath(file.absolute, base)
    if (!matcher(relative)) continue
    if (entries.length >= limit) {
      truncated.results = true
      break
    }
    entries.push({ path: relative, absolute: file.absolute })
  }

  return { entries, truncated, scanned: walked.files.length, errors: walked.errors }
}
