import assert from "node:assert/strict"
import nodeFs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { createFence, FenceError } from "../lib/fence.js"
import { createRepositoryFs } from "../lib/fs-adapter.js"

const temporaryRoot = () => nodeFs.mkdtempSync(path.join(os.tmpdir(), "oc-git-fence-"))

test("fence.resolve 默认解析到会话目录", () => {
  const root = temporaryRoot()
  const fence = createFence({ root })
  // fence 在构造时取 realpath（软链防逃逸），因此与 realpath 后的根比较
  const realRoot = nodeFs.realpathSync.native ? nodeFs.realpathSync.native(root) : nodeFs.realpathSync(root)
  assert.equal(fence.resolve(undefined), realRoot)
  assert.equal(fence.resolve("sub"), path.join(realRoot, "sub"))
})

test("fence.resolve 拒绝越界（.. / 绝对路径 / 根外）", () => {
  const root = temporaryRoot()
  const fence = createFence({ root, cwd: path.join(root, "sub") })
  assert.throws(() => fence.resolve("../../outside"), FenceError)
  assert.throws(() => fence.resolve(os.tmpdir()), FenceError)
  assert.throws(() => fence.resolve(path.resolve(root, "..")), FenceError)
})

test("fence 允许以 root 为界的前缀相近目录（/a/bc 不被 /a/b 命中）", () => {
  const root = temporaryRoot()
  const fence = createFence({ root })
  const sibling = `${root}-sibling`
  assert.equal(fence.contains(sibling), false)
})

test("fs 适配器每个方法都是 AsyncFunction（isomorphic-git 的方言探测硬契约）", () => {
  const root = temporaryRoot()
  const { promises } = createRepositoryFs(root)
  for (const name of ["readFile", "writeFile", "unlink", "readdir", "mkdir", "rmdir", "stat", "lstat", "chmod", "readlink", "symlink", "rm"]) {
    assert.equal(typeof promises[name], "function", `${name} 缺失`)
    assert.equal(promises[name].constructor.name, "AsyncFunction", `${name} 必须是 async`)
  }
})

test("fs 适配器：无参 readFile 返回 rejected Promise（复刻 isPromiseFs 探测）", async () => {
  const root = temporaryRoot()
  const { promises } = createRepositoryFs(root)
  let probed
  try {
    probed = await promises.readFile()
  } catch (error) {
    probed = error
  }
  assert.ok(probed instanceof Error, "探测必须拿到 Promise 的 rejection，而不是同步抛错")
})

test("fs 适配器：根内读写往返，越界被拒且不落到磁盘", async () => {
  const root = temporaryRoot()
  const { promises } = createRepositoryFs(root)
  const inside = path.join(root, "a.txt")
  await promises.writeFile(inside, "hello")
  assert.equal(await promises.readFile(inside, "utf8"), "hello")
  const outside = path.join(root, "..", "escape.txt")
  await assert.rejects(() => promises.writeFile(outside, "x"), /escapes the repository root/u)
  assert.equal(nodeFs.existsSync(path.resolve(outside)), false)
})

test("fs 适配器：symlink / readlink 明确拒绝（设备不支持软链）", async () => {
  const root = temporaryRoot()
  const { promises } = createRepositoryFs(root)
  await assert.rejects(() => promises.symlink("a", "b"), /symlinks are not supported/u)
  await assert.rejects(() => promises.readlink("a"), /symlinks are not supported/u)
})
