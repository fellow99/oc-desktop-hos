/**
 * 仓库根围栏（安全属性）。
 *
 * 唯一真值来源是会话的**项目根**（`context.location.project.directory`）。工具参数 `dir` 相对
 * **会话目录**（`context.location.directory`）解析，解析结果必须落在项目根内。
 *
 * 本壳**没有**审批/提权面（与 dsh 的一次性提权不同），所以越界只能拒绝并说明：不重试、不换根、
 * 不静默把路径改到别处。
 *
 * 软链：根与会话目录在构造时取 `realpath`，`resolve()` 对已存在的目标再取一次 `realpath` 复核，
 * 因此「根内软链指向根外」不会被跟随。
 */
import nodeFs from "node:fs"
import path from "node:path"

export class FenceError extends Error {
  constructor(message, code = "OUT_OF_ROOT") {
    super(message)
    this.name = "FenceError"
    this.code = code
  }
}

/**
 * 判断 `target` 是否位于 `root` 之内（含 root 自身）。逐段比较，避免 `/a/bc` 被 `/a/b` 命中。
 * 不做大小写归一（设备 hmdfs 大小写不敏感，但这里只用于围栏判定，宁可严格）。
 */
export function contains(root, target) {
  const rel = path.relative(root, target)
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))
}

function realpathIfExists(target) {
  try {
    return nodeFs.realpathSync.native ? nodeFs.realpathSync.native(target) : nodeFs.realpathSync(target)
  } catch {
    return target
  }
}

/**
 * @param {{root: string, cwd?: string}} input
 */
export function createFence(input) {
  const root = typeof input?.root === "string" && input.root.length > 0 ? realpathIfExists(path.resolve(input.root)) : ""
  if (!root) throw new FenceError("git plugin: workspace root is unknown (context.location.project.directory)", "NO_ROOT")
  const cwd = realpathIfExists(path.resolve(input.cwd && input.cwd.length > 0 ? input.cwd : root))

  return {
    root,
    cwd,
    contains: (target) => contains(root, target),
    /** 解析工具参数 `dir`（相对会话目录）为项目根内的绝对路径 */
    resolve(dir) {
      if (dir !== undefined && dir !== null && typeof dir !== "string") {
        throw new FenceError("git plugin: `dir` must be a string", "INVALID_DIR")
      }
      const raw = dir && dir.length > 0 ? dir : "."
      const target = path.resolve(cwd, raw)
      if (!contains(root, target)) {
        throw new FenceError(
          `git plugin: \`dir\` is outside the workspace root (${root}): ${raw}. ` +
            `Open the target directory as a workspace instead of pointing outside it.`,
          "OUT_OF_ROOT",
        )
      }
      // 软链防逃逸：已存在的路径取 realpath 再复核（不存在的路径只做词法校验，例如 clone 目标）
      const real = realpathIfExists(target)
      if (!contains(root, real)) {
        throw new FenceError(`git plugin: \`dir\` resolves outside the workspace root (${root}): ${raw}`, "OUT_OF_ROOT")
      }
      return target
    },
    /** 解析相对路径到根内绝对路径（适配器内部用；越界即拒） */
    resolveWithin(relative) {
      if (typeof relative !== "string" || relative.length === 0) {
        throw new FenceError("git plugin: invalid path", "INVALID_PATH")
      }
      const target = path.resolve(root, relative)
      if (!contains(root, target)) {
        throw new FenceError(`git plugin: path escapes the repository root: ${relative}`, "OUT_OF_ROOT")
      }
      return target
    },
  }
}
