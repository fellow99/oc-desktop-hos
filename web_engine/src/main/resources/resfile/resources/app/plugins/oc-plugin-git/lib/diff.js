/**
 * 统一 diff：isomorphic-git 没有 `diff`（源码与 1.x 文档双向零命中），因此借 jsdiff 产出标准
 * unified diff；二进制（含 NUL）只报 `Binary files … differ`，绝不把二进制当文本吐给模型。
 */
export const DEFAULT_CONTEXT_LINES = 3
/** 单文件 diff 上限（超出即截断并显式标注） */
export const MAX_FILE_DIFF_BYTES = 256 * 1024
/** 单次 diff 总量上限 */
export const MAX_TOTAL_DIFF_BYTES = 1024 * 1024

/** 含 NUL 字节即判二进制 */
export function isBinary(buffer) {
  if (!buffer) return false
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer)
  return bytes.includes(0)
}

function asText(value) {
  if (value === undefined || value === null) return ""
  if (Buffer.isBuffer(value)) return value.toString("utf8")
  return String(value)
}

/**
 * 生成单个文件的 unified diff（`---`/`+++`/`@@`）。
 * @returns {{ patch: string, additions: number, deletions: number, binary: boolean, truncated: boolean }}
 */
export function renderFileDiff(input) {
  const { diff, file, before, after, context = DEFAULT_CONTEXT_LINES } = input
  const beforeBinary = isBinary(before)
  const afterBinary = isBinary(after)
  if (beforeBinary || afterBinary) {
    return {
      patch: `Binary files a/${file} and b/${file} differ\n`,
      additions: 0,
      deletions: 0,
      binary: true,
      truncated: false,
    }
  }

  const oldText = asText(before)
  const newText = asText(after)
  const structured = diff.structuredPatch(`a/${file}`, `b/${file}`, oldText, newText, "", "", { context })
  let patch = diff.formatPatch(structured)
  if (!patch.endsWith("\n")) patch += "\n"

  let additions = 0
  let deletions = 0
  for (const hunk of structured.hunks ?? []) {
    for (const line of hunk.lines ?? []) {
      if (line.startsWith("+")) additions += 1
      else if (line.startsWith("-")) deletions += 1
    }
  }

  let truncated = false
  if (Buffer.byteLength(patch, "utf8") > MAX_FILE_DIFF_BYTES) {
    // 按**字节**截断（按 UTF-16 码元切会让 CJK 文本远超上限）
    const limited = Buffer.from(patch, "utf8").subarray(0, MAX_FILE_DIFF_BYTES).toString("utf8")
    patch = `${limited}\n[diff truncated: file exceeds ${MAX_FILE_DIFF_BYTES} bytes]\n`
    truncated = true
  }
  return { patch, additions, deletions, binary: false, truncated }
}

/** 只统计增删行数（`stat` 模式） */
export function countLineChanges(diff, before, after) {
  if (isBinary(before) || isBinary(after)) return { additions: 0, deletions: 0, binary: true }
  const patches = diff.diffLines(asText(before), asText(after))
  let additions = 0
  let deletions = 0
  for (const part of patches) {
    const lines = part.value.split("\n").filter((line, index, all) => index < all.length - 1 || line.length > 0)
    if (part.added) additions += lines.length
    else if (part.removed) deletions += lines.length
  }
  return { additions, deletions, binary: false }
}
