/**
 * 仓库上下文：把「围栏 → 适配器 → runtime」三件事收在一处，工具只表达 git 语义。
 *
 * 错误口径（与规格一致）：
 *   - 可归因失败（不是仓库 / 越界 / 缺凭据 / 被拒 / 冲突 / 网络不可达）→ 以 `{content}` 返回，步骤不终结
 *   - 编程错误（TypeError 之类）→ 直接抛，由上游包成 Tool.Error
 */
import { createRepositoryFs } from "./fs-adapter.js"
import { loadRuntime } from "./runtime.js"
import { isUserCanceled } from "./auth.js"
import { FenceError } from "./fence.js"
import nodeFs from "node:fs"
import path from "node:path"

/** 默认提交身份：刻意用明显的占位值，不含任何真实个人信息 */
export const DEFAULT_IDENTITY = { name: "yourname", email: "yourname@somehost" }

/**
 * 打开仓库上下文。
 * @param {{fence: import('./fence.js').createFence extends never ? never : any, workspaces?: any}} workspace
 * @param {string|undefined} dir 工具参数（相对会话目录）
 */
export async function openRepository(workspace, dir) {
  const target = workspace.fence.resolve(dir)
  const runtime = await loadRuntime()
  return {
    ...runtime,
    fs: createRepositoryFs(target),
    dir: target,
    auth: workspace.auth,
    log: workspace.log,
  }
}

/** 该目录（或任一上层）是否有 `.git`；返回仓库根或 null */
export function findRepositoryRoot(start) {
  let current = path.resolve(start)
  for (;;) {
    if (nodeFs.existsSync(path.join(current, ".git"))) return current
    const parent = path.dirname(current)
    if (parent === current) return null
    current = parent
  }
}

/** 需要「已是仓库」的工具先过这一关 */
export async function openExistingRepository(workspace, dir) {
  const repository = await openRepository(workspace, dir)
  const root = findRepositoryRoot(repository.dir)
  if (!root) {
    throw new FenceError(
      `not a git repository: ${repository.dir}. Use git_init to create one, or git_clone to clone an existing one.`,
      "NOT_A_REPOSITORY",
    )
  }
  // 安全属性：仓库根必须落在用户授予的工作区内。工作区是某个父仓库的子目录时，
  // 绝不能把 chroot 抬到那个父仓库（否则写入会跑到工作区之外）。
  if (!workspace.fence.contains(root)) {
    throw new FenceError(
      `not a git repository inside the workspace root (${workspace.fence.root}): ${repository.dir}. ` +
        `Open the repository root itself as the workspace instead of a parent repository's subdirectory.`,
      "NOT_A_REPOSITORY",
    )
  }
  if (root !== repository.dir) {
    // 子目录 → 以仓库根为准（与 git 的行为一致）
    repository.dir = root
    repository.fs = createRepositoryFs(root)
  }
  return repository
}

/** 远端操作的统一出口：把「用户取消认证」翻译成「缺凭据 + 怎么配」 */
export async function withRemoteAuth(workspace, url, action) {
  try {
    return await action()
  } catch (error) {
    if (isUserCanceled(error)) throw new FenceError(workspace.auth.missingMessage(url), "CREDENTIAL_MISSING")
    if (error && error.code === "CREDENTIAL_REJECTED") throw error
    throw error
  }
}

/** 解析仓库本地身份（`user.name` / `user.email`），缺省用占位值 */
export async function resolveIdentity(repository) {
  let name
  let email
  try {
    name = await repository.git.getConfig({ fs: repository.fs, dir: repository.dir, path: "user.name" })
  } catch {
    name = undefined
  }
  try {
    email = await repository.git.getConfig({ fs: repository.fs, dir: repository.dir, path: "user.email" })
  } catch {
    email = undefined
  }
  return {
    name: name && String(name).length > 0 ? String(name) : DEFAULT_IDENTITY.name,
    email: email && String(email).length > 0 ? String(email) : DEFAULT_IDENTITY.email,
  }
}

/** 当前分支（detached 时返回 undefined） */
export async function currentBranch(repository) {
  try {
    return await repository.git.currentBranch({ fs: repository.fs, dir: repository.dir, fullname: false })
  } catch {
    return undefined
  }
}

/**
 * 把「提交引用」解析成完整 oid：分支/标签名、完整 oid、**短 oid** 都接受。
 *
 * 为什么需要：isomorphic-git 的 `cherryPick` 只吃完整 oid（传分支名或短哈希会直接失败），
 * 而原生 git 两种写法都支持 —— 真机实测模型就撞到了这个不一致。
 * 解析不出来时原样返回，让底层抛出它自己的错误（不静默吞掉）。
 */
export async function resolveCommitish(repository, ref) {
  const { git, fs, dir } = repository
  try {
    return await git.expandOid({ fs, dir, oid: ref })
  } catch {
    // 不是 oid 形态，继续按引用解析
  }
  try {
    return await git.resolveRef({ fs, dir, ref })
  } catch {
    return ref
  }
}

/** HEAD oid（无提交时 undefined） */
export async function headOid(repository) {
  try {
    return await repository.git.resolveRef({ fs: repository.fs, dir: repository.dir, ref: "HEAD" })
  } catch {
    return undefined
  }
}

/**
 * 确保仓库有提交身份：`stash` 之类的原语会**直接读 config**（不接受 author 参数），
 * 缺身份时抛 `MissingNameError`。这里在缺失时写入占位身份，并把这件事如实写进工具输出。
 */
export async function ensureIdentity(repository) {
  const current = await resolveIdentity(repository)
  let configured = true
  try {
    const name = await repository.git.getConfig({ fs: repository.fs, dir: repository.dir, path: "user.name" })
    const email = await repository.git.getConfig({ fs: repository.fs, dir: repository.dir, path: "user.email" })
    configured = Boolean(name) && Boolean(email)
  } catch {
    configured = false
  }
  if (!configured) {
    await repository.git.setConfig({ fs: repository.fs, dir: repository.dir, path: "user.name", value: current.name })
    await repository.git.setConfig({ fs: repository.fs, dir: repository.dir, path: "user.email", value: current.email })
  }
  return { identity: current, applied: !configured }
}

/** 进行中的操作（合并 / 摘取 / 反向）——`statusMatrix` 不表达冲突，这里如实标出状态文件 */
export function inProgressOperations(dir) {
  const gitDir = path.join(dir, ".git")
  const markers = [
    ["MERGE_HEAD", "merge"],
    ["CHERRY_PICK_HEAD", "cherry-pick"],
    ["REVERT_HEAD", "revert"],
    ["rebase-merge", "rebase"],
    ["rebase-apply", "rebase"],
  ]
  const active = []
  for (const [file, label] of markers) {
    if (nodeFs.existsSync(path.join(gitDir, file))) active.push(label)
  }
  return [...new Set(active)]
}

/** 读取一侧文件内容（不存在返回 undefined） */
export async function readMaybe(repository, oid, filepath) {
  if (!oid) return undefined
  try {
    const result = await repository.git.readBlob({ fs: repository.fs, dir: repository.dir, oid, filepath })
    return result.blob
  } catch {
    return undefined
  }
}

/** 读取工作区文件（不存在返回 undefined；目录返回 undefined） */
export async function readWorkdir(repository, filepath) {
  const absolute = path.resolve(repository.dir, filepath)
  try {
    const stat = nodeFs.statSync(absolute)
    if (!stat.isFile()) return undefined
    return nodeFs.readFileSync(absolute)
  } catch {
    return undefined
  }
}

/** 把 path → oid 的 tree 读成 Map（供 show / changed paths 用） */
export async function readTreeMap(repository, oid) {
  const map = new Map()
  if (!oid) return map
  const result = await repository.git.readTree({ fs: repository.fs, dir: repository.dir, oid })
  for (const entry of result.tree) {
    if (entry.type === "blob") map.set(entry.path, entry.oid)
  }
  return map
}

/** 两个 tree 之间的变更路径（新增 A / 删除 D / 修改 M） */
export function diffTreeMaps(before, after) {
  const changed = []
  for (const [file, oid] of after) {
    if (!before.has(file)) changed.push(`A ${file}`)
    else if (before.get(file) !== oid) changed.push(`M ${file}`)
  }
  for (const file of before.keys()) {
    if (!after.has(file)) changed.push(`D ${file}`)
  }
  return changed.sort()
}

/** 统一错误 → 可读文本（可归因失败用它返回；不影响编程错误继续抛） */
export function describeError(error) {
  if (!error) return "unknown error"
  if (error instanceof FenceError) return error.message
  const code = error.code ? ` [${error.code}]` : ""
  const message = error.message ? String(error.message) : String(error)
  return `${message}${code && !message.includes(String(error.code)) ? code : ""}`
}

/**
 * 工具执行外壳：可归因失败 → `{content}`；编程错误 → 抛。
 * @param {string} name 工具名（用于文案前缀）
 * @param {() => Promise<any>} action
 */
export async function guarded(name, action) {
  try {
    const result = await action()
    return result
  } catch (error) {
    if (error instanceof TypeError) throw error
    return { content: `${name}: ${describeError(error)}`, metadata: { ok: false } }
  }
}
