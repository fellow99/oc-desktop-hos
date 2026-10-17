/**
 * 统一的「两棵树之间取变更内容」实现：工具（`git_diff`）与 VCS provider 共用。
 *
 * 三棵树都来自 isomorphic-git 的 walker：`TREE({ref})` / `STAGE()` / `WORKDIR()`。
 * 只有 blob 才算变更；一侧缺失即新增/删除；oid 相同直接跳过。
 */
import { headOid } from "./repo.js"

/** 文件路径是否命中 pathspec（目录前缀或全等） */
export function matchesPath(file, paths) {
  if (!paths || paths.length === 0) return true
  return paths.some((path) => file === path || file.startsWith(`${path.replace(/\/+$/u, "")}/`))
}

/**
 * 工作区 walker 不会自动排除 gitdir（`.git` 目录/文件自身），
 * 若不过滤，`git_diff` 与 VCS 面板会把 `.git/objects/**` 当成「未跟踪的新增文件」吐出去。
 */
function isGitdirEntry(file) {
  return file === ".git" || file.startsWith(".git/")
}
async function entryContent(repository, entry) {
  if (!entry) return undefined
  const type = await entry.type()
  if (type !== "blob") return undefined
  const direct = await entry.content()
  if (direct) return Buffer.from(direct)
  const oid = await entry.oid()
  if (!oid) return undefined
  try {
    const blob = await repository.git.readBlob({ fs: repository.fs, dir: repository.dir, oid })
    return Buffer.from(blob.blob)
  } catch {
    return undefined
  }
}

/**
 * @param {any} repository openRepository() 的返回值
 * @param {{mode: 'workdir'|'staged'|'head'|'refs', ref?: string, ref2?: string, paths?: string[]}} options
 * @returns {Promise<{label: string, entries: Array<{file: string, before?: Buffer, after?: Buffer, status: 'added'|'deleted'|'modified'}>}>}
 */
export async function walkDiff(repository, options) {
  const { git } = repository
  const mode = options?.mode ?? "head"
  const head = await headOid(repository)
  let leftWalker
  let rightWalker
  let label

  if (mode === "workdir") {
    leftWalker = git.STAGE()
    rightWalker = git.WORKDIR()
    label = "index ↔ working tree"
  } else if (mode === "staged") {
    leftWalker = head ? git.TREE({ ref: head }) : undefined
    rightWalker = git.STAGE()
    label = "HEAD ↔ index"
  } else if (mode === "head") {
    leftWalker = head ? git.TREE({ ref: head }) : undefined
    rightWalker = git.WORKDIR()
    label = "HEAD ↔ working tree"
  } else if (mode === "treeWorkdir") {
    const oid = await git.resolveRef({ fs: repository.fs, dir: repository.dir, ref: options.ref })
    leftWalker = git.TREE({ ref: oid })
    rightWalker = git.WORKDIR()
    label = `${options.ref} ↔ working tree`
  } else if (mode === "refs") {
    const leftOid = await git.resolveRef({ fs: repository.fs, dir: repository.dir, ref: options.ref })
    const rightOid = await git.resolveRef({ fs: repository.fs, dir: repository.dir, ref: options.ref2 })
    leftWalker = git.TREE({ ref: leftOid })
    rightWalker = git.TREE({ ref: rightOid })
    label = `${options.ref} ↔ ${options.ref2}`
  } else {
    throw new Error(`unknown diff mode: ${mode}`)
  }

  const entries = []
  await git.walk({
    fs: repository.fs,
    dir: repository.dir,
    trees: leftWalker ? [leftWalker, rightWalker] : [rightWalker],
    map: async (filepath, walked) => {
      if (filepath === "." || isGitdirEntry(filepath)) return undefined
      const left = leftWalker ? walked[0] : undefined
      const right = leftWalker ? walked[1] : walked[0]
      const leftType = left ? await left.type() : undefined
      const rightType = right ? await right.type() : undefined
      if (leftType === "tree" || rightType === "tree") return undefined
      if (!matchesPath(filepath, options?.paths)) return undefined
      const leftOid = left ? await left.oid() : undefined
      const rightOid = right ? await right.oid() : undefined
      if (leftOid && leftOid === rightOid) return undefined
      entries.push({
        file: filepath,
        before: await entryContent(repository, left),
        after: await entryContent(repository, right),
        status: !leftOid ? "added" : !rightOid ? "deleted" : "modified",
      })
      return undefined
    },
  })
  return { label, entries }
}
