/**
 * 集成用例：用插件自己的模块在临时目录跑一遍真实 git 操作（不联网）。
 * 依赖 `isomorphic-git` / `diff` —— 因此只在**物化了依赖的副本**里跑（见 `scripts/verify-git-plugin.mjs`）。
 */
import assert from "node:assert/strict"
import nodeFs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { createFence } from "../lib/fence.js"
import { createAuth } from "../lib/auth.js"
import { buildTools, TOOL_NAMES } from "../lib/tools/index.js"
import { createVcsProvider } from "../lib/vcs.js"

function makeWorkspace() {
  const root = nodeFs.mkdtempSync(path.join(os.tmpdir(), "oc-git-it-"))
  const fence = createFence({ root })
  const credentialsFile = path.join(root, ".git-credentials")
  const auth = createAuth({ file: credentialsFile })
  const logs = []
  return { root, fence, auth, credentialsFile, log: (message) => logs.push(message), logs }
}

const byName = (workspace) => new Map(buildTools(workspace).map((tool) => [tool.name, tool]))

test("插件注册 21 个工具，元数据齐备", () => {
  const workspace = makeWorkspace()
  const tools = buildTools(workspace)
  assert.equal(tools.length, 21)
  assert.deepEqual(
    tools.map((tool) => tool.name),
    TOOL_NAMES,
  )
  for (const tool of tools) {
    assert.equal(typeof tool.description, "string")
    assert.ok(tool.description.length > 20, `${tool.name} 缺 description`)
    assert.equal(tool.input?.type, "object", `${tool.name} 的 input 必须是 JSON Schema`)
    assert.equal(typeof tool.execute, "function", `${tool.name} 缺 execute`)
  }
})

test("本地全链：init → add → commit → status → log → diff → branch → tag → stash → config", async () => {
  const workspace = makeWorkspace()
  const tools = byName(workspace)

  const init = await tools.get("git_init").execute({})
  assert.match(init.content, /Initialized empty git repository/u)
  assert.equal(nodeFs.existsSync(path.join(workspace.root, ".git")), true)

  nodeFs.writeFileSync(path.join(workspace.root, "README.md"), "# hello\n")

  const beforeCommit = await tools.get("git_status").execute({})
  assert.match(beforeCommit.content, /Untracked \(1\)/u)

  const added = await tools.get("git_add").execute({ files: ["README.md"] })
  assert.match(added.content, /Staged for commit \(1\)/u)

  const committed = await tools.get("git_commit").execute({ message: "feat: first commit" })
  assert.match(committed.content, /Created commit/u)
  assert.match(committed.content, /yourname/u)

  const status = await tools.get("git_status").execute({})
  assert.match(status.content, /No changes\./u)
  assert.match(status.content, /On branch main/u)

  const log = await tools.get("git_log").execute({})
  assert.match(log.content, /1 commit/u)
  assert.match(log.content, /feat: first commit/u)

  const show = await tools.get("git_show").execute({ file: "README.md" })
  assert.match(show.content, /# hello/u)

  nodeFs.writeFileSync(path.join(workspace.root, "README.md"), "# hello\nmore\n")
  const diff = await tools.get("git_diff").execute({})
  assert.match(diff.content, /@@/u)
  assert.match(diff.content, /\+more/u)

  const stat = await tools.get("git_diff").execute({ stat: true })
  assert.match(stat.content, /1\+/u)

  const branch = await tools.get("git_branch").execute({ action: "create", name: "dev", checkout: true })
  assert.match(branch.content, /Created branch dev/u)
  const branches = await tools.get("git_branch").execute({ action: "list" })
  assert.match(branches.content, /\* dev/u)

  const tag = await tools.get("git_tag").execute({ action: "create", name: "v1", message: "release" })
  assert.match(tag.content, /Created annotated tag v1/u)
  const tags = await tools.get("git_tag").execute({ action: "list" })
  assert.match(tags.content, /v1/u)

  const stashPush = await tools.get("git_stash").execute({ op: "push" })
  assert.match(stashPush.content, /Stashed/u)
  const stashList = await tools.get("git_stash").execute({ op: "list" })
  assert.match(stashList.content, /Stash \(1 entry\)/u)
  const stashPop = await tools.get("git_stash").execute({ op: "pop" })
  assert.match(stashPop.content, /pop completed/u)

  const setConfig = await tools.get("git_config").execute({ action: "set", path: "user.name", value: "204 Tester" })
  assert.match(setConfig.content, /Set user\.name=204 Tester/u)
  const getConfig = await tools.get("git_config").execute({ path: "user.name" })
  assert.match(getConfig.content, /user\.name=204 Tester/u)

  const remote = await tools.get("git_remote").execute({ action: "add", name: "origin", url: "https://example.com/team/repo.git" })
  assert.match(remote.content, /Added remote origin/u)
  const remotes = await tools.get("git_remote").execute({ action: "list" })
  assert.match(remotes.content, /origin/u)
  const removed = await tools.get("git_remote").execute({ action: "remove", name: "origin" })
  assert.match(removed.content, /Removed remote origin/u)
})

test("revert：正向反向互为逆；工作区已分叉时 fail-closed 拒绝", async () => {
  const workspace = makeWorkspace()
  const tools = byName(workspace)
  await tools.get("git_init").execute({})

  nodeFs.writeFileSync(path.join(workspace.root, "a.txt"), "one\n")
  await tools.get("git_add").execute({ files: ["a.txt"] })
  const first = await tools.get("git_commit").execute({ message: "first" })
  const firstOid = first.metadata.oid

  nodeFs.writeFileSync(path.join(workspace.root, "a.txt"), "two\n")
  await tools.get("git_add").execute({ files: ["a.txt"] })
  const second = await tools.get("git_commit").execute({ message: "second" })
  const secondOid = second.metadata.oid

  const reverted = await tools.get("git_revert").execute({ oid: secondOid })
  assert.match(reverted.content, /Reverted/u)
  assert.equal(nodeFs.readFileSync(path.join(workspace.root, "a.txt"), "utf8"), "one\n")

  // 根提交没有父提交 ⇒ 明确拒绝（不做「反向一个根提交」这种伪语义）
  const rootRefused = await tools.get("git_revert").execute({ oid: firstOid })
  assert.match(rootRefused.content, /0 parents/u)

  // 工作区已分叉 ⇒ 拒绝，且不改动工作区
  nodeFs.writeFileSync(path.join(workspace.root, "a.txt"), "three\n")
  const refused = await tools.get("git_revert").execute({ oid: secondOid })
  assert.match(refused.content, /refusing to revert/u)
  assert.match(refused.content, /a\.txt/u)
  assert.equal(nodeFs.readFileSync(path.join(workspace.root, "a.txt"), "utf8"), "three\n")
})

test("围栏：dir 越界被拒绝（并且不创建任何目录）", async () => {
  const workspace = makeWorkspace()
  const tools = byName(workspace)
  const outside = path.join(workspace.root, "..", `escape-${Date.now()}`)
  const result = await tools.get("git_init").execute({ dir: outside })
  assert.match(result.content, /outside the workspace root/u)
  assert.equal(nodeFs.existsSync(outside), false)
})

test("非仓库目录给出可归因提示（不是静默创建）", async () => {
  const workspace = makeWorkspace()
  const tools = byName(workspace)
  const result = await tools.get("git_status").execute({})
  assert.match(result.content, /not a git repository/u)
  assert.match(result.content, /git_init/u)
})

test("git_diff 在 ref 与非 refs 模式混用时明确报错，不静默忽略", async () => {
  const workspace = makeWorkspace()
  const tools = byName(workspace)
  await tools.get("git_init").execute({})
  const result = await tools.get("git_diff").execute({ ref: "HEAD~1" })
  assert.match(result.content, /only meaningful with mode "refs"/u)
})

test("rebase 不会被冒充：工具面里没有该工具，且没有别的工具接受 rebase 动作", () => {
  const names = buildTools(makeWorkspace()).map((tool) => tool.name)
  assert.equal(names.includes("git_rebase"), false)
  const branch = buildTools(makeWorkspace()).find((tool) => tool.name === "git_branch")
  assert.deepEqual(branch.input.properties.action.enum, ["list", "create", "delete", "rename"])
})

test("reset soft/hard 与 checkout 的语义（含破坏性操作）", async () => {
  const workspace = makeWorkspace()
  const tools = byName(workspace)
  await tools.get("git_init").execute({})

  nodeFs.writeFileSync(path.join(workspace.root, "a.txt"), "v1\n")
  await tools.get("git_add").execute({ files: ["a.txt"] })
  const first = await tools.get("git_commit").execute({ message: "first" })

  nodeFs.writeFileSync(path.join(workspace.root, "a.txt"), "v2\n")
  await tools.get("git_add").execute({ files: ["a.txt"] })
  await tools.get("git_commit").execute({ message: "second" })

  // soft：只移动指针，工作区/索引不动 ⇒ 出现「已暂存的改动」
  const soft = await tools.get("git_reset").execute({ mode: "soft", ref: first.metadata.oid })
  assert.match(soft.content, /Reset \(soft\)/u)
  assert.equal(nodeFs.readFileSync(path.join(workspace.root, "a.txt"), "utf8"), "v2\n")
  assert.match((await tools.get("git_status").execute({})).content, /Staged for commit/u)

  // hard：工作区被重写回目标提交
  const hard = await tools.get("git_reset").execute({ mode: "hard", ref: first.metadata.oid })
  assert.match(hard.content, /working tree overwritten/u)
  assert.equal(nodeFs.readFileSync(path.join(workspace.root, "a.txt"), "utf8"), "v1\n")
  // 回归：reset --hard 必须保持 HEAD 附着在分支上（曾因按 oid 检出而变成 detached HEAD）
  const afterHard = (await tools.get("git_status").execute({})).content
  assert.doesNotMatch(afterHard, /detached/u)
  assert.match(afterHard, /On branch main/u)
  assert.match(afterHard, /No changes\./u)

  // 分支切换
  await tools.get("git_branch").execute({ action: "create", name: "dev", checkout: true })
  nodeFs.writeFileSync(path.join(workspace.root, "b.txt"), "dev\n")
  await tools.get("git_add").execute({ files: ["b.txt"] })
  await tools.get("git_commit").execute({ message: "dev commit" })
  assert.equal(nodeFs.existsSync(path.join(workspace.root, "b.txt")), true)

  await tools.get("git_checkout").execute({ ref: "main" })
  assert.equal(nodeFs.existsSync(path.join(workspace.root, "b.txt")), false)
  assert.match((await tools.get("git_branch").execute({ action: "list" })).content, /\* main/u)
})

test("merge 快进 + cherry-pick 组合，VCS provider 与工具读同一仓库", async () => {
  const workspace = makeWorkspace()
  const tools = byName(workspace)
  await tools.get("git_init").execute({})

  nodeFs.writeFileSync(path.join(workspace.root, "base.txt"), "base\n")
  await tools.get("git_add").execute({ files: ["base.txt"] })
  await tools.get("git_commit").execute({ message: "base commit" })

  await tools.get("git_branch").execute({ action: "create", name: "feature" })
  await tools.get("git_checkout").execute({ ref: "feature" })
  nodeFs.writeFileSync(path.join(workspace.root, "feature.txt"), "feature\n")
  await tools.get("git_add").execute({ files: ["feature.txt"] })
  await tools.get("git_commit").execute({ message: "feature commit" })

  await tools.get("git_checkout").execute({ ref: "main" })
  const merged = await tools.get("git_merge").execute({ theirs: "feature" })
  assert.match(merged.content, /Merged feature/u)
  assert.equal(nodeFs.existsSync(path.join(workspace.root, "feature.txt")), true)

  // cherry-pick 一个独立提交（在 feature 上再提交，然后摘到 main）
  await tools.get("git_checkout").execute({ ref: "feature" })
  nodeFs.writeFileSync(path.join(workspace.root, "extra.txt"), "extra\n")
  await tools.get("git_add").execute({ files: ["extra.txt"] })
  const extra = await tools.get("git_commit").execute({ message: "extra commit" })
  await tools.get("git_checkout").execute({ ref: "main" })
  const picked = await tools.get("git_cherry_pick").execute({ oid: extra.metadata.oid })
  assert.match(picked.content, /Cherry-picked/u)
  // 回归：cherryPick 返回 oid 字符串，早先按 result.oid 读不到 → 明明建了提交却报 "no new commit"
  assert.doesNotMatch(picked.content, /no new commit/u)
  assert.match(picked.content, /→ [0-9a-f]{10}\./u)
  assert.equal(typeof picked.metadata.oid, "string")
  assert.equal(nodeFs.existsSync(path.join(workspace.root, "extra.txt")), true)

  // VCS provider：与工具共享同一仓库视图
  const provider = createVcsProvider(workspace)
  const scope = { directory: workspace.root, worktree: workspace.root, canonical: workspace.root }
  const info = await provider.info(scope)
  assert.equal(info.branch.current, "main")
  assert.equal(typeof info.branch.default, "string")
  const branches = await provider.branches({ ...scope, search: "", limit: 10 })
  assert.ok(branches.includes("main"))
  nodeFs.writeFileSync(path.join(workspace.root, "dirty.txt"), "dirty\n")
  const status = await provider.status(scope)
  assert.ok(status.some((entry) => entry.file === "dirty.txt" && entry.status === "added"))
  const working = await provider.diff({ ...scope, mode: "working", context: 3, maxOutputBytes: 1024 * 1024 })
  assert.ok(working.some((entry) => entry.file === "dirty.txt"))
})

test("merge 非快进（历史分叉）后索引与工作树必须与 HEAD 一致", async () => {
  const workspace = makeWorkspace()
  const tools = byName(workspace)
  await tools.get("git_init").execute({})

  nodeFs.writeFileSync(path.join(workspace.root, "base.txt"), "base\n")
  await tools.get("git_add").execute({ files: ["base.txt"] })
  await tools.get("git_commit").execute({ message: "base commit" })

  // dev 分支提交 b.txt
  await tools.get("git_branch").execute({ action: "create", name: "dev", checkout: true })
  nodeFs.writeFileSync(path.join(workspace.root, "b.txt"), "dev\n")
  await tools.get("git_add").execute({ files: ["b.txt"] })
  await tools.get("git_commit").execute({ message: "dev commit" })

  // main 上再提交一次，制造分叉（合并必然产生 merge commit）
  await tools.get("git_checkout").execute({ ref: "main" })
  nodeFs.writeFileSync(path.join(workspace.root, "a.txt"), "main\n")
  await tools.get("git_add").execute({ files: ["a.txt"] })
  await tools.get("git_commit").execute({ message: "main commit" })

  const merged = await tools.get("git_merge").execute({ theirs: "dev" })
  assert.match(merged.content, /merge commit/u)

  // 关键不变量：合并后工作树与 HEAD 一致（回归：非快进路径曾只写索引/不检出工作区）
  assert.equal(nodeFs.existsSync(path.join(workspace.root, "b.txt")), true, "b.txt 应被检出到工作区")
  assert.equal(nodeFs.readFileSync(path.join(workspace.root, "b.txt"), "utf8"), "dev\n")
  assert.match((await tools.get("git_status").execute({})).content, /No changes\./u)
})

test("cherry-pick / revert 接受分支名与短哈希（与原生 git 一致）", async () => {
  const workspace = makeWorkspace()
  const tools = byName(workspace)
  await tools.get("git_init").execute({})

  nodeFs.writeFileSync(path.join(workspace.root, "base.txt"), "base\n")
  await tools.get("git_add").execute({ files: ["base.txt"] })
  await tools.get("git_commit").execute({ message: "base commit" })

  // 在 side 分支上提交一个文件，然后用**分支名**把它摘到 main
  await tools.get("git_branch").execute({ action: "create", name: "side", checkout: true })
  nodeFs.writeFileSync(path.join(workspace.root, "side.txt"), "side\n")
  await tools.get("git_add").execute({ files: ["side.txt"] })
  await tools.get("git_commit").execute({ message: "side commit" })
  await tools.get("git_checkout").execute({ ref: "main" })

  const picked = await tools.get("git_cherry_pick").execute({ oid: "side" })
  assert.doesNotMatch(picked.content, /no new commit/u)
  assert.equal(nodeFs.existsSync(path.join(workspace.root, "side.txt")), true)

  // 短哈希形式的 revert 也要能解析
  const short = picked.metadata.oid.slice(0, 8)
  const reverted = await tools.get("git_revert").execute({ oid: short })
  assert.match(reverted.content, /Revert|revert/u)
  assert.equal(nodeFs.existsSync(path.join(workspace.root, "side.txt")), false)
})

test("git_branch remote: true 列出远端跟踪分支（不再返回空）", async () => {
  const workspace = makeWorkspace()
  const tools = byName(workspace)
  await tools.get("git_init").execute({})
  nodeFs.writeFileSync(path.join(workspace.root, "a.txt"), "a\n")
  await tools.get("git_add").execute({ files: ["a.txt"] })
  await tools.get("git_commit").execute({ message: "a" })

  // 造两条 remote-tracking ref（不联网也能覆盖这条路）
  const head = nodeFs.readFileSync(path.join(workspace.root, ".git", "refs", "heads", "main"), "utf8")
  const remoteDir = path.join(workspace.root, ".git", "refs", "remotes", "origin")
  nodeFs.mkdirSync(remoteDir, { recursive: true })
  nodeFs.writeFileSync(path.join(remoteDir, "main"), head)
  nodeFs.writeFileSync(path.join(remoteDir, "feature-x"), head)

  const remote = await tools.get("git_branch").execute({ action: "list", remote: true })
  assert.match(remote.content, /feature-x/u)
  assert.match(remote.content, /main/u)
  // 远端列表不打「当前分支」标记
  assert.doesNotMatch(remote.content, /\* main/u)
  assert.equal(remote.metadata.count >= 2, true)

  // 只给名字也行
  const named = await tools.get("git_branch").execute({ action: "list", remote: "origin" })
  assert.match(named.content, /feature-x/u)
})
