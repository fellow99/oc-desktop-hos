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
