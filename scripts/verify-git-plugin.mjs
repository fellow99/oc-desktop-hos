#!/usr/bin/env node
/**
 * verify-git-plugin.mjs —— 204 宿主侧门禁：跑插件单测与集成用例。
 *
 * 为什么要把插件复制到临时目录再跑：集成用例需要 `isomorphic-git` / `diff`，而这两个包只在
 * **构建产物**（`resfile/.../plugins/oc-plugin-git/node_modules/`，由 `collect-app.mjs` 的
 * `collectPluginRuntime()` 物化）里存在。插件源码目录必须保持「无 node_modules」——
 * 否则 `collect-app.mjs` 的静态断言会把第三方代码当成本工程源码扫描。
 *
 * 用法：
 *   node scripts/verify-git-plugin.mjs                 单测 + 集成用例（要求运行时已物化）
 *   node scripts/verify-git-plugin.mjs --pure          只跑不依赖第三方包的单测
 *   node scripts/verify-git-plugin.mjs --runtime <dir> 指定物化好的插件目录（默认取 resfile）
 */
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { copyTree, fail, isDir, log, parseArgs, removeTree, require_, runOrFail } from "./lib/util.mjs"

const PROJECT_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)))
const PLUGIN_DIR = join(PROJECT_ROOT, "plugins", "oc-plugin-git")
const DEFAULT_RUNTIME = join(
  PROJECT_ROOT,
  "web_engine/src/main/resources/resfile/resources/app/plugins/oc-plugin-git",
)
const PURE_TESTS = ["tests/credentials.test.mjs", "tests/fence-adapter.test.mjs", "tests/report.test.mjs"]

const args = parseArgs()

function runTests(cwd, files) {
  const result = runOrFail(process.execPath, ["--test", ...files], { cwd })
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`
  const summary = output.trim().split("\n").slice(-6).join("\n")
  console.log(summary)
  return output
}

function main() {
  require_(isDir(PLUGIN_DIR), `插件目录缺失: ${PLUGIN_DIR}`)

  if (args.has("pure")) {
    log(1, "仅跑纯函数用例（不依赖第三方包）")
    runTests(PLUGIN_DIR, PURE_TESTS)
    console.log("[oc-desktop] verify-git-plugin：纯函数用例通过")
    return
  }

  const runtime = resolve(args.get("runtime", DEFAULT_RUNTIME))
  const runtimeModules = join(runtime, "node_modules")
  if (!isDir(runtimeModules)) {
    fail(
      `未找到物化的运行时依赖: ${runtimeModules}\n` +
        `  先运行 node scripts/collect-app.mjs（会执行 collectPluginRuntime），或显式传 --runtime <dir>。\n` +
        `  只跑纯函数用例可用 --pure。`,
    )
  }

  const stage = mkdtempSync(join(tmpdir(), "oc-git-verify-"))
  try {
    log(1, `复制插件到临时目录: ${stage}`)
    copyTree(PLUGIN_DIR, stage)
    copyTree(runtimeModules, join(stage, "node_modules"))
    // 不传目录参数：Node 默认从 cwd 发现 **/*.test.mjs（并跳过 node_modules），跨版本更稳
    const output = runTests(stage, [])
    require_(/fail 0/u.test(output) || !/fail [1-9]/u.test(output), "存在失败的用例（见上方输出）")
    console.log("[oc-desktop] verify-git-plugin：单测 + 集成用例通过")
  } finally {
    removeTree(stage)
    // 保证临时目录不残留：removeTree 对不存在的路径是安全的
    if (isDir(dirname(stage))) removeTree(stage)
  }
}

try {
  main()
} catch (error) {
  console.error(`[oc-desktop] 错误: ${error && error.message ? error.message : String(error)}`)
  process.exit(1)
}
