#!/usr/bin/env node
/**
 * collect-app.mjs —— 阶段 ③「应用层收集」：把 `plugins/oc-plugin-*` 投放到 package 内，并做静态门禁。
 *
 * 流水线（工程规划 §6.1；本阶段必须在 build-opencode 之后、build-debug 之前）：
 *   ① collect-runtime.mjs（外壳与运行时）
 *   ② build-opencode.mjs（服务端产物）
 *   ③ collect-app.mjs（本阶段：壳专用插件 → resfile，含 node --check 与静态断言）
 *   ④ build-debug.ps1 / build-hap.ps1（打包 HAP）
 *
 * 为什么不能只放进 resfile：opencode 只认**配置目录**下的 `plugin/`，包内 resfile 只是「源」，
 * 启动期由 `src-main/main.js` 的 pluginMaterialize 阶段 copy 到 `<userData>/config/opencode/plugin/`
 * （禁 symlink：真机 symlink 报 EACCES；见 specs/102-harmony-js-tools FR-tool-016/017）。
 *
 * 静态门禁（FR-tool-003/020，准入条件 plugins/README.md §5）：
 *   - 无 node-pty / forkpty / openpty / cross-spawn（PTY 在 SELinux 层被拒）；
 *   - 无 `.node` / `.so` 引用（自有 ELF 不可执行）；
 *   - 无 child_process exec 家族与 spawnSync（设备上 cp.exec 永不回调）；
 *   - `spawn(` 只允许指向 `/system/bin/sh`（唯一例外，shell 插件的常驻 POSIX shell）。
 *
 * 用法：
 *   node scripts/collect-app.mjs              投放 + 断言 + node --check
 *   node scripts/collect-app.mjs --check-only 只跑断言与语法检查（不写 resfile）
 *   node scripts/collect-app.mjs --self-test  反向用例：证明断言能失败（注入违例到临时文件）
 */
import { spawnSync } from "node:child_process"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import {
  banner,
  copyTree,
  fail,
  fileSize,
  findFiles,
  isDir,
  isFile,
  listDir,
  log,
  parseArgs,
  readText,
  removeTree,
  require_,
  run,
  sha256File,
  warn,
  writeText,
} from "./lib/util.mjs"

const PROJECT_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)))
const PLUGIN_SOURCE_DIR = join(PROJECT_ROOT, "plugins")
/** Electron 约定：本应用主进程产物目录（与 collect-runtime.mjs 的 APP_RESFILE_DIR 一致） */
const APP_RESFILE_DIR = "web_engine/src/main/resources/resfile/resources/app"
const PLUGIN_DEST_DIR = join(PROJECT_ROOT, APP_RESFILE_DIR, "plugins")
const PLUGIN_PREFIX = "oc-plugin-"
/** 唯一允许的 spawn 目标（设备自带 POSIX shell） */
const ALLOWED_SPAWN_TARGET = "/system/bin/sh"
/** 上架/平台禁用词（plugins/README.md §4） */
const FORBIDDEN_NAME_WORDS = ["Harmony", "DeepSeek"]

const args = parseArgs()

/** 禁止出现的字面量（子串匹配） */
const FORBIDDEN_SUBSTRINGS = [
  ["node-pty", "PTY 原生模块（设备上 forkpty/openpty 被 SELinux 拒绝）"],
  ["forkpty", "PTY 系统调用"],
  ["openpty", "PTY 系统调用"],
  ["cross-spawn", "上游 cross-spawn（子进程退出事件在设备上不触发）"],
]

/** 禁止出现的模式（正则匹配，避免误伤 `.sort(` / `.source` 这类正常成员访问） */
const FORBIDDEN_PATTERNS = [
  [/\.so\b/, "`.so` 引用（自有 ELF 不可执行）"],
  [/\.node\b/, "`.node` 原生模块引用"],
  [/(?:^|[^\w.$])(?:exec|execSync|execFile|execFileSync)\s*\(/, "child_process exec 家族（设备上永不回调）"],
  [/(?:cp|child_process|childProcess)\s*\.\s*exec\s*\(/, "child_process.exec（设备上永不回调）"],
  [/(?:^|[^\w.$])spawnSync\s*\(/, "spawnSync（同样依赖子进程结束事件）"],
]

// ------------------------------------------------------------------ 静态断言

/**
 * 断言单个插件源码文件；违例即抛错（fail-visible，绝不放行）。
 * 只扫 `.js`（README.md 允许如实描述「不用 PTY」，断言不做文档检查）。
 */
export function assertPluginSource(relative, source) {
  for (const [needle, reason] of FORBIDDEN_SUBSTRINGS) {
    if (source.includes(needle)) throw new Error(`${relative}: 出现禁用依赖 \`${needle}\` —— ${reason}`)
  }
  for (const [pattern, reason] of FORBIDDEN_PATTERNS) {
    const match = source.match(pattern)
    if (match) throw new Error(`${relative}: 命中禁用模式 \`${match[0]}\` —— ${reason}`)
  }
  for (const [index, line] of source.split("\n").entries()) {
    if (!/\bspawn\s*\(/.test(line)) continue
    if (line.includes(ALLOWED_SPAWN_TARGET)) continue
    throw new Error(
      `${relative}:${index + 1}: spawn( 只允许指向 ${ALLOWED_SPAWN_TARGET}，实际为：${line.trim()}`,
    )
  }
}

/** 断言插件目录下的所有 .js 文件 */
function assertPluginTree(pluginDir, pluginName) {
  const files = findFiles(pluginDir, (name) => name.endsWith(".js"))
  require_(files.length > 0, `${pluginName}: 目录内没有任何 .js（插件入口缺失）`)
  for (const file of files) {
    assertPluginSource(`${pluginName}/${file.slice(pluginDir.length + 1).split("\\").join("/")}`, readText(file))
  }
  return files.length
}

/**
 * `node --check` 语法门禁。
 * 注意：ESM 的 `.js` 只有在最近的 package.json 声明 `"type":"module"` 时 `node --check` 才会真正检查
 * （否则 Node 按 CJS 解析并静默通过），因此额外用 `--input-type=module` 从 stdin 复核一遍。
 */
function checkJavaScript(file, label) {
  const plain = run(process.execPath, ["--check", file], { optional: true })
  if (plain.status === 0) {
    const esm = spawnSync(process.execPath, ["--input-type=module", "--check"], {
      input: readText(file),
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    })
    if (esm.status === 0) return true
    fail(`${label} 语法检查失败（ESM）：\n${(esm.stderr || "").trim().split("\n").slice(0, 12).join("\n")}`)
  }
  fail(
    `${label} 语法检查失败（node --check）：\n${(plain.stderr || plain.stdout || "").trim().split("\n").slice(0, 12).join("\n")}`,
  )
  return false
}

// ------------------------------------------------------------------ 收集

/** 发现 plugins/ 下的插件目录（目录名约定 oc-plugin-<name>） */
function discoverPlugins() {
  require_(isDir(PLUGIN_SOURCE_DIR), `插件源目录缺失: ${PLUGIN_SOURCE_DIR}`)
  const entries = listDir(PLUGIN_SOURCE_DIR)
    .filter((name) => name.startsWith(PLUGIN_PREFIX))
    .sort()
  require_(
    entries.length > 0,
    `plugins/ 下没有任何 ${PLUGIN_PREFIX}* 目录：插件随包投放是本阶段职责，不能静默产出空包`,
  )
  const plugins = entries.map((name) => {
    const directory = join(PLUGIN_SOURCE_DIR, name)
    require_(isDir(directory), `${name}: 不是目录`)
    const index = join(directory, "index.js")
    require_(isFile(index), `${name}: 缺少 index.js（插件目录的入口文件）`)
    const manifest = join(directory, "package.json")
    require_(isFile(manifest), `${name}: 缺少 package.json（上游按目录解析入口，且 ESM 需要 type=module）`)
    const parsed = JSON.parse(readText(manifest))
    require_(parsed.name === name, `${name}: package.json 的 name=${parsed.name} 与目录名不一致`)
    require_(parsed.type === "module", `${name}: package.json 必须声明 "type": "module"（否则 node --check 静默放过 ESM）`)
    for (const word of FORBIDDEN_NAME_WORDS) {
      require_(!name.includes(word), `${name}: 目录名含上架禁用词 ${word}`)
    }
    return { name, directory }
  })
  return plugins
}

/** resfile 投放（先清理同名目标，保证幂等可重复：FR-tool-017） */
function collectPlugins(plugins) {
  banner(3, `投放插件源码 → ${APP_RESFILE_DIR}/plugins`)
  require_(isDir(join(PROJECT_ROOT, APP_RESFILE_DIR)), `产品 App 目录缺失: ${APP_RESFILE_DIR}（请先跑 collect-runtime.mjs）`)
  removeTree(PLUGIN_DEST_DIR)
  const copied = []
  for (const plugin of plugins) {
    const destination = join(PLUGIN_DEST_DIR, plugin.name)
    copyTree(plugin.directory, destination)
    require_(isFile(join(destination, "index.js")), `${plugin.name}: 投放后缺少 index.js`)
    for (const file of findFiles(destination, () => true)) {
      const relative = `${plugin.name}/${file.slice(destination.length + 1).split("\\").join("/")}`
      copied.push({ relative, source: join(plugin.directory, file.slice(destination.length + 1)), destination: file })
      log(3, `  ${relative}  ${fileSize(file)}B  sha256=${sha256File(file).slice(0, 12)}`)
    }
  }
  require_(copied.length > 0, "投放结果为空")
  return copied
}

/** 投放后自检：目标文件与源一一对应且 sha256 一致（防半拷贝 / 旧版本残留） */
function verifyCollection(copied) {
  const mismatches = copied.filter((entry) => !isFile(entry.destination) || sha256File(entry.source) !== sha256File(entry.destination))
  require_(
    mismatches.length === 0,
    `投放后校验失败（文件缺失或内容不一致）：\n${mismatches.map((entry) => `  - ${entry.relative}`).join("\n")}`,
  )
  log(3, `投放后校验通过：${copied.length} 个文件 sha256 与源一致`)
}

/**
 * collect-runtime.mjs 阶段 8 会按 APP_KEEP 白名单清理 resfile/app。
 * 本阶段的白名单项是 `plugins`：缺失时清理会把刚投放的插件删掉（顺序正确时不会发生，但这是跨文件耦合）。
 */
function warnIfWhitelistMissing() {
  const runtime = join(PROJECT_ROOT, "scripts/collect-runtime.mjs")
  if (!isFile(runtime)) return
  const source = readText(runtime)
  const keep = source.match(/const APP_KEEP = new Set\(\[([\s\S]*?)\]\)/)
  if (keep === null) {
    warn("collect-runtime", "无法解析 APP_KEEP 白名单，请人工确认 resfile/app/plugins 不会被阶段 8 清理")
    return
  }
  if (!/['"]plugins['"]/.test(keep[1])) {
    warn(
      "collect-runtime",
      "APP_KEEP 白名单不含 'plugins'：collect-runtime.mjs 阶段 8 会删除 resfile/app/plugins。\n" +
        "  顺序要求：collect-app.mjs 必须跑在 collect-runtime.mjs 之后（本次顺序正确）。\n" +
        "  若重跑 collect-runtime.mjs，需要重新跑本脚本；长期修法是给 APP_KEEP 加 'plugins'（该文件由其它改动负责）。",
    )
  }
}

// ------------------------------------------------------------------ 反向用例（--self-test）

/** 反向用例：把违例写入临时文件，断言必须失败（证明断言不是空跑） */
function selfTest() {
  banner("self-test", "静态断言反向用例")
  const directory = mkdtempSync(join(tmpdir(), "oc-collect-app-selftest-"))
  const cases = [
    ["node-pty 依赖必须被拒", 'const pty = require("node-pty")\n'],
    ["PTY 系统调用必须被拒", "const handle = forkpty()\n"],
    ["child_process.exec 必须被拒", 'const cp = require("child_process")\ncp.exec("rg foo")\n'],
    ["裸 exec 调用必须被拒", 'export const run = () => exec("rg foo")\n'],
    ["spawnSync 必须被拒", 'spawnSync("rg", ["--files"])\n'],
    ["原生 .node 引用必须被拒", 'export const native = require("./native/thing.node")\n'],
    ["原生 .so 引用必须被拒", 'export const native = require("./lib/thing.so")\n'],
    ["spawn 非 /system/bin/sh 必须被拒", 'spawn("rg", ["--version"])\n'],
    ["cross-spawn 必须被拒", 'const spawn = require("cross-spawn")\n'],
  ]
  let passed = 0
  const failed = []
  for (const [name, source] of cases) {
    const file = join(directory, `${name.replace(/[^\w]+/g, "-")}.js`)
    writeText(file, source)
    try {
      assertPluginSource(file, readText(file))
      failed.push(name)
      log("self-test", `FAIL ${name}（断言未命中违例）`)
    } catch (error) {
      passed += 1
      log("self-test", `PASS ${name}（${error.message.slice(0, 72)}）`)
    }
  }
  // 正向对照：合法源码必须通过
  const clean = join(directory, "clean.js")
  writeText(clean, 'export const spawnShell = () => spawn("/system/bin/sh", [], { stdio: "pipe" })\nexport const sortIt = (x) => [...x].sort()\n')
  try {
    assertPluginSource(clean, readText(clean))
    passed += 1
    log("self-test", "PASS 合法源码通过（spawn /system/bin/sh + .sort 不误伤）")
  } catch (error) {
    failed.push("合法源码")
    log("self-test", `FAIL 合法源码被误判：${error.message}`)
  }
  removeTree(directory)
  log("self-test", `PASS ${passed} / FAIL ${failed.length}`)
  if (failed.length > 0) fail(`反向用例未按预期失败：${failed.join("、")}`)
}

// ------------------------------------------------------------------ main

function main() {
  if (args.has("self-test")) {
    selfTest()
    return
  }
  const plugins = discoverPlugins()
  const files = plugins.map((plugin) => {
    const count = assertPluginTree(plugin.directory, plugin.name)
    log(3, `静态断言通过：${plugin.name}（${count} 个 .js，无 PTY / 无 exec / 无 .node / spawn 仅 ${ALLOWED_SPAWN_TARGET}）`)
    return count
  })
  require_(files.length === plugins.length, "插件断言数量不一致")

  if (args.has("check-only")) {
    log(3, `仅检查模式：跳过投放（${plugins.length} 个插件）`)
    console.log(`[oc-desktop] 完成：插件静态门禁通过（${plugins.length} 个插件，未投放）`)
    return
  }

  const copied = collectPlugins(plugins)
  const scripts = copied.filter((entry) => entry.relative.endsWith(".js"))
  require_(scripts.length > 0, "投放结果里没有任何 .js（插件入口缺失）")
  for (const entry of scripts) checkJavaScript(entry.destination, entry.relative)
  log(3, `node --check 全部通过（${scripts.length} 个 .js，含 ESM 复核）`)
  verifyCollection(copied)
  warnIfWhitelistMissing()
  console.log(
    `[oc-desktop] 完成：插件已随包投放 ${plugins.length} 个（${copied.length} 个文件）→ ${APP_RESFILE_DIR}/plugins`,
  )
}

main()
