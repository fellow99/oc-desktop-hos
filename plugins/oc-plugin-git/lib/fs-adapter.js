/**
 * isomorphic-git 的 FileSystem 适配器：把仓库根当 chroot，落到 `node:fs/promises`。
 *
 * 硬契约（务必保留）：**每个方法都必须声明为 `async`**。
 * isomorphic-git 用 `isPromiseFs()` 无参调用 `fs.readFile()` 探测方言；只要探测调用**同步抛错**，
 * 适配器就会被判成 callback 风格，随后 11 个命令全被包成「等回调」——回调永不触发，git 调用
 * **永久挂起**（同型工程真机事故：工具结果未知、会话卡死、主线程被卡）。
 * `async` 函数不能同步抛错，因此「参数非法」也只能变成 rejected Promise。
 *
 * 另一个必须项：`rm`。isomorphic-git 的 `bindFs` 优先取 `fs.rm`；没有它时回落到
 * `rmdir` 递归实现，容易在 hmdfs 上留下半成品目录。
 */
import nodeFs from "node:fs/promises"
import path from "node:path"

const OUTSIDE = (target) =>
  Object.assign(new Error(`git plugin: path escapes the repository root: ${String(target)}`), { code: "EPERM" })

const INVALID = () => Object.assign(new Error("git plugin: invalid path"), { code: "EINVAL" })

/**
 * @param {string} root 仓库根（chroot）
 */
export function createRepositoryFs(root) {
  const base = path.resolve(root)

  /** 相对/绝对路径 → chroot 内绝对路径；越界抛错（在 async 方法内调用 ⇒ 变成 rejection） */
  function absolute(target) {
    if (typeof target !== "string" || target.length === 0) throw INVALID()
    const resolved = path.resolve(base, target)
    const rel = path.relative(base, resolved)
    if (rel !== "" && (rel.startsWith("..") || path.isAbsolute(rel))) throw OUTSIDE(target)
    return resolved
  }

  function wantsUtf8(options) {
    if (options === "utf8" || options === "utf-8") return true
    return Boolean(options && typeof options === "object" && (options.encoding === "utf8" || options.encoding === "utf-8"))
  }

  const api = {
    async readFile(target, options) {
      const buffer = await nodeFs.readFile(absolute(target))
      return wantsUtf8(options) ? buffer.toString("utf8") : buffer
    },
    async writeFile(target, data, options) {
      await nodeFs.writeFile(absolute(target), data, options)
    },
    async unlink(target) {
      await nodeFs.unlink(absolute(target))
    },
    async readdir(target) {
      return nodeFs.readdir(absolute(target))
    },
    async mkdir(target, options) {
      await nodeFs.mkdir(absolute(target), options)
    },
    async rmdir(target, options) {
      await nodeFs.rmdir(absolute(target), options)
    },
    async stat(target) {
      return nodeFs.stat(absolute(target))
    },
    async lstat(target) {
      return nodeFs.lstat(absolute(target))
    },
    async chmod(target, mode) {
      await nodeFs.chmod(absolute(target), mode)
    },
    // 设备上软链不可用（EACCES）：明确拒绝，而不是让调用方拿到半个语义
    async readlink(target) {
      throw Object.assign(new Error(`git plugin: symlinks are not supported on this device: ${String(target)}`), {
        code: "ENOSYS",
      })
    },
    async symlink(target) {
      throw Object.assign(new Error(`git plugin: symlinks are not supported on this device: ${String(target)}`), {
        code: "ENOSYS",
      })
    },
    async rm(target, options) {
      await nodeFs.rm(absolute(target), options)
    },
  }

  return { promises: api, root: base }
}
