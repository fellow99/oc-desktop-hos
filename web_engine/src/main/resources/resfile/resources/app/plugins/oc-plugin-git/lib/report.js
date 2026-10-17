/**
 * 输出渲染：把 isomorphic-git 的返回值变成模型可读文本。
 * 纯函数、无依赖，便于单测。所有列表都有上限，超出即显式标注（不静默截断）。
 */
export const MAX_LISTED_FILES = 200

/** statusMatrix → 分组（staged / modified / deleted / untracked / conflicted） */
export function groupStatus(matrix) {
  const staged = []
  const modified = []
  const deleted = []
  const untracked = []
  for (const row of matrix ?? []) {
    const [file, head, workdir, stage] = row
    if (head === 0 && workdir === 2 && stage === 0) {
      untracked.push(file)
      continue
    }
    if (head === 0 && workdir === 2 && (stage === 2 || stage === 3)) {
      staged.push(`A ${file}`)
      if (stage === 3) modified.push(file)
      continue
    }
    if (head === 1 && workdir === 0 && stage === 0) {
      staged.push(`D ${file}`)
      continue
    }
    if (head === 1 && workdir === 0) {
      deleted.push(file)
      continue
    }
    if (head === 1 && stage === 1 && workdir === 2) {
      modified.push(file)
      continue
    }
    if (head === 1 && (stage === 2 || stage === 3)) {
      staged.push(`M ${file}`)
      if (workdir === 2 && stage === 3) modified.push(file)
      continue
    }
    if (head === 1 && stage === 0 && workdir === 1) {
      staged.push(`D ${file}`)
      continue
    }
    if (head === 1 && workdir === 2 && stage === 0) {
      untracked.push(`${file} (recreated)`)
    }
  }
  return {
    staged,
    modified,
    deleted,
    untracked,
    conflicted: [],
  }
}

/** 渲染状态分组为文本 */
export function formatStatus(groups, extra = {}) {
  const lines = []
  const branch = extra.branch ? `On branch ${extra.branch}` : "On a detached HEAD"
  const head = extra.head ? ` (HEAD ${String(extra.head).slice(0, 10)})` : ""
  lines.push(`${branch}${head}`)
  const sections = [
    ["Staged for commit", groups.staged],
    ["Modified (unstaged)", groups.modified],
    ["Deleted (unstaged)", groups.deleted],
    ["Untracked", groups.untracked],
    ["Conflicted", groups.conflicted],
  ]
  let any = false
  for (const [label, items] of sections) {
    if (!items || items.length === 0) continue
    any = true
    lines.push("", `${label} (${items.length}):`)
    for (const item of items.slice(0, MAX_LISTED_FILES)) lines.push(`  ${item}`)
    if (items.length > MAX_LISTED_FILES) lines.push(`  … and ${items.length - MAX_LISTED_FILES} more`)
  }
  if (extra.inProgress && extra.inProgress.length > 0) {
    any = true
    lines.push("", `Operation in progress: ${extra.inProgress.join(", ")}`)
    lines.push("  Resolve the conflicts (or abort with git_merge / git_cherry_pick) before continuing.")
  }
  if (!any) lines.push("", "No changes.")
  return lines.join("\n")
}

/** 渲染一条提交为文本 */
export function formatCommit(commit, options = {}) {
  const details = commit.commit ?? commit
  const author = details.author ?? {}
  const committer = details.committer ?? {}
  const lines = [
    `commit ${commit.oid ?? ""}`,
    `Author:  ${author.name ?? "unknown"} <${author.email ?? "unknown"}>`,
    `Date:    ${formatTimestamp(author.timestamp)}`,
  ]
  if (committer.name && committer.name !== author.name) {
    lines.push(`Commit:  ${committer.name} <${committer.email ?? "unknown"}>`)
  }
  if (details.parent && details.parent.length > 0) lines.push(`Parents: ${details.parent.join(" ")}`)
  lines.push("", indent(details.message ?? ""))
  if (options.changed && options.changed.length > 0) {
    lines.push("", `Changed paths (${options.changed.length}):`)
    for (const item of options.changed.slice(0, MAX_LISTED_FILES)) lines.push(`  ${item}`)
    if (options.changed.length > MAX_LISTED_FILES) {
      lines.push(`  … and ${options.changed.length - MAX_LISTED_FILES} more`)
    }
  }
  return lines.join("\n")
}

/** 渲染提交摘要（一行） */
export function formatCommitSummary(commit) {
  const message = (commit.commit?.message ?? "").split("\n")[0]
  const author = commit.commit?.author?.name ?? "unknown"
  return `${String(commit.oid ?? "").slice(0, 10)}  ${formatTimestamp(commit.commit?.author?.timestamp)}  ${author}  ${message}`
}

/** 渲染文件差异集合 */
export function formatDiff(entries, options = {}) {
  if (!entries || entries.length === 0) return options.emptyMessage ?? "No changes."
  const lines = []
  let total = 0
  let truncated = false
  for (const entry of entries) {
    const bytes = Buffer.byteLength(entry.patch ?? "", "utf8")
    total += bytes
    if (total > (options.maxTotalBytes ?? 1024 * 1024)) {
      truncated = true
      lines.push(`[diff truncated: total output exceeds ${options.maxTotalBytes ?? 1024 * 1024} bytes]`)
      break
    }
    lines.push(entry.patch ?? "")
  }
  const summary = `\n${entries.length} changed path${entries.length === 1 ? "" : "s"}`
  if (truncated) lines.push(`${summary} (output truncated)`)
  else lines.push(summary)
  return lines.join("\n")
}

export function formatTimestamp(timestamp) {
  if (!timestamp) return "unknown"
  const millis = timestamp > 1e12 ? timestamp : timestamp * 1000
  try {
    return new Date(millis).toISOString().replace("T", " ").replace(/\.\d+Z$/u, "Z")
  } catch {
    return String(timestamp)
  }
}

/** 按字节上限截断文本并显式标注 */
export function truncateText(text, limit = 64 * 1024) {
  if (typeof text !== "string") return ""
  if (Buffer.byteLength(text, "utf8") <= limit) return text
  return `${text.slice(0, limit)}\n[truncated: output exceeds ${limit} bytes]`
}

function indent(text) {
  return text
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n")
}
