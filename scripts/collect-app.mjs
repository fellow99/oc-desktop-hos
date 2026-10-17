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
 *   node scripts/collect-app.mjs --force-plugin-runtime  强制重建 git 插件运行时依赖（默认幂等跳过）
 */
import { spawnSync } from "node:child_process"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
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
  rel,
  removeTree,
  require_,
  run,
  runOrFail,
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

/** 204：git 插件运行时依赖的物化 pin（与插件 lib/runtime.js 的断言必须一致） */
const GIT_PLUGIN_NAME = "oc-plugin-git"
const ISOMORPHIC_GIT_VERSION = "1.44.2"
const JSDIFF_VERSION = "9.0.0"
const GIT_RUNTIME_PACKAGES = 56
const GIT_RUNTIME_MAX_BYTES = 12 * 1024 * 1024
/** git 插件运行时依赖的复用缓存（.gitignore 已忽略 `/.cache/`）：避免每次 collect-app 都联网 npm install */
const RUNTIME_CACHE_DIR = join(PROJECT_ROOT, ".cache", "git-plugin-runtime", "node_modules")

/** 日志用相对路径 */
function relativeToProject(p) {
  return rel(PROJECT_ROOT, p)
}

/** 上架/平台禁用词（plugins/README.md §4） */
/**
 * 上架禁用词：只约束**用户可见文案**（工具的 name / description 会出现在界面上），
 * 不约束内部标识符（目录名 / 插件 id / specs 路径里的 harmony 都不是用户可见面）。
 * 小写比较，避免「大小写写错就静默失效」。
 */
const FORBIDDEN_USER_VISIBLE_WORDS = ["harmony", "deepseek"]

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

    return { name, directory }
  })
  return plugins
}

/**
 * 导入式工具元数据检查（替换原「禁用词」死代码）。
 * 用捕获式 editor 跑一遍插件 setup，断言：
 *   1) 注册的工具名与预期一致（上游改名 / 自己写错都会在构建期暴露，而不是运行时）；
 *   2) 工具的 name / description 里没有上架禁用词（用户可见面）。
 * 说明：只 import 本工程自己的插件（无第三方依赖、只用 node 内建），因此构建期可安全执行。
 */
async function assertToolMetadata(plugins) {
  banner(3, "导入式工具元数据检查");
  // 非工具型插件（如 oc-plugin-workspace-roots：只注册 RPC，不注册工具）期望注册 0 个工具。
  const expected = {
    "oc-plugin-harmony-shell": ["shell"],
    "oc-plugin-harmony-search": ["grep", "glob"],
    "oc-plugin-workspace-roots": [],
    // 204：21 个 git 工具（一动词一工具，见 specs/204-plugin-git）
    "oc-plugin-git": [
      "git_init",
      "git_clone",
      "git_status",
      "git_diff",
      "git_log",
      "git_show",
      "git_add",
      "git_commit",
      "git_branch",
      "git_checkout",
      "git_reset",
      "git_merge",
      "git_cherry_pick",
      "git_revert",
      "git_stash",
      "git_tag",
      "git_remote",
      "git_fetch",
      "git_pull",
      "git_push",
      "git_config",
    ],
  }
  let total = 0
  for (const plugin of plugins) {
    const moduleUrl = pathToFileURL(join(plugin.directory, "index.js")).href
    const mod = await import(moduleUrl)
    const definition = mod.default
    require_(definition && typeof definition.id === "string", `${plugin.name}: 默认导出缺少 id`)
    require_(typeof definition.setup === "function", `${plugin.name}: 默认导出缺少 setup()`)
    const added = []
    const removed = []
    const editor = {
      list: () => added,
      get: (name) => added.find((tool) => tool.name === name),
      namespace: () => {},
      add: (tool) => {
        require_(tool && typeof tool.name === "string", `${plugin.name}: 注册的工具缺少 name`)
        added.push(tool)
      },
      update: () => {},
      remove: (name) => removed.push(name),
    }
    const context = {
      // 让插件拿到与运行期一致的形状（location / vcs / rpc）；缺失会让 setup 走降级路径，掩盖真实问题
      location: { directory: process.cwd(), project: { directory: process.cwd() } },
      tool: { transform: async (callback) => callback(editor) },
      vcs: { transform: async (callback) => callback({ add: () => {}, default: { get: () => undefined, set: () => {} } }) },
      rpc: { register: async () => ({ dispose: () => {} }) },
    }
    await definition.setup(context)
    const names = added.map((tool) => tool.name).sort()
    const want = (expected[plugin.name] ?? []).slice().sort()
    require_(
      JSON.stringify(names) === JSON.stringify(want),
      `${plugin.name}: 注册的工具名不符合预期（实际 ${JSON.stringify(names)}，期望 ${JSON.stringify(want)}）`,
    )
    for (const tool of added) {
      require_(typeof tool.description === "string" && tool.description.length > 0, `${plugin.name}/${tool.name}: 缺少 description`)
      require_(tool.input !== undefined, `${plugin.name}/${tool.name}: 缺少 input（JSON Schema）`)
      require_(typeof tool.execute === "function", `${plugin.name}/${tool.name}: 缺少 execute`)
      const haystack = `${tool.name} ${tool.description}`.toLowerCase()
      for (const word of FORBIDDEN_USER_VISIBLE_WORDS) {
        require_(
          !haystack.includes(word),
          `${plugin.name}/${tool.name}: 用户可见文案含上架禁用词 ${word}（工具名与描述会显示在界面上）`,
        )
      }
    }
    total += added.length
    log(3, `工具元数据通过：${plugin.name} → ${names.join(", ")}（覆盖 ${removed.length} 个上游键）`)
  }
  require_(total > 0, "没有任何插件注册工具，插件通道实际为空")
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

// ------------------------------------------------------------------ 204：git 插件运行时物化

/**
 * 把 `isomorphic-git` + `diff` 及其整棵闭包物化到**插件自己的** `node_modules/`。
 *
 * 为什么落在插件目录内：启动期 `main.js materializePlugins()` 用 `fs.cpSync(recursive)` 复制的是
 * **插件目录**，落在别处不会被带到设备；而插件加载走真实 ESM `import()`，裸包名解析优先查
 * 插件目录下的 `node_modules/`。两者叠起来，插件目录内嵌套是唯一「复制得走 + 解析得到」的位置。
 *
 * 幂等：`collectPlugins()` 会先 `removeTree(PLUGIN_DEST_DIR)` 清空投放目录，所以「目标目录已存在就跳过」
 * 永远不成立。真正的复用点是工程内的 `.cache/git-plugin-runtime/`（已被 .gitignore 忽略）：
 * 版本一致就直接复制过去，只有缓存缺失或版本不符才真的跑一次 npm install。
 *
 * 断言失败即抛错（不静默产出空包）；`--force-plugin-runtime` 强制重新安装并刷新缓存。
 */
function collectPluginRuntime(plugins) {
  banner(3, "物化 git 插件运行时依赖（isomorphic-git + diff）")
  const plugin = plugins.find((entry) => entry.name === GIT_PLUGIN_NAME)
  require_(plugin, `未发现插件 ${GIT_PLUGIN_NAME}（运行时物化没有落点）`)
  const destination = join(PLUGIN_DEST_DIR, GIT_PLUGIN_NAME, "node_modules")
  const force = args.has("force-plugin-runtime")

  if (!force && runtimeVersionMatches(destination)) {
    assertGitRuntime(destination)
    log(3, "目标目录已有版本一致的运行时（未清理场景），跳过物化")
    return
  }
  if (!force && runtimeVersionMatches(RUNTIME_CACHE_DIR)) {
    removeTree(destination)
    copyTree(RUNTIME_CACHE_DIR, destination)
    assertGitRuntime(destination)
    log(3, `复用缓存 ${relativeToProject(RUNTIME_CACHE_DIR)}（版本一致），未执行 npm install`)
    return
  }

  const staging = mkdtempSync(join(tmpdir(), "oc-git-runtime-"))
  try {
    runOrFail(
      "npm",
      [
        "install",
        "--omit=dev",
        "--no-audit",
        "--no-fund",
        "--ignore-scripts",
        `isomorphic-git@${ISOMORPHIC_GIT_VERSION}`,
        `diff@${JSDIFF_VERSION}`,
      ],
      { cwd: staging },
    )
    removeTree(destination)
    copyTree(join(staging, "node_modules"), destination)
  } finally {
    removeTree(staging)
  }
  assertGitRuntime(destination)

  // 回写缓存：下一次 collect-app 直接复制，不再联网安装。
  removeTree(RUNTIME_CACHE_DIR)
  copyTree(destination, RUNTIME_CACHE_DIR)
  assertGitRuntime(RUNTIME_CACHE_DIR)
  log(3, `已刷新缓存 ${relativeToProject(RUNTIME_CACHE_DIR)}`)
}

/** node_modules 里的两个直接依赖版本是否与脚本常量一致 */
function runtimeVersionMatches(nodeModules) {
  const gitManifest = join(nodeModules, "isomorphic-git", "package.json")
  const diffManifest = join(nodeModules, "diff", "package.json")
  if (!isFile(gitManifest) || !isFile(diffManifest)) return false
  const gitVersion = JSON.parse(readText(gitManifest)).version
  const diffVersion = JSON.parse(readText(diffManifest)).version
  const matches = gitVersion === ISOMORPHIC_GIT_VERSION && diffVersion === JSDIFF_VERSION
  if (!matches) log(3, `${relativeToProject(nodeModules)} 版本不符（isomorphic-git@${gitVersion} / diff@${diffVersion}）`)
  return matches
}

/** 产物断言：版本、入口、包数、体积、无原生模块 */
function assertGitRuntime(nodeModules) {
  const gitManifest = join(nodeModules, "isomorphic-git", "package.json")
  require_(isFile(gitManifest), `缺少 ${gitManifest}`)
  const gitVersion = JSON.parse(readText(gitManifest)).version
  require_(
    gitVersion === ISOMORPHIC_GIT_VERSION,
    `isomorphic-git 版本不符：期望 ${ISOMORPHIC_GIT_VERSION}，实际 ${gitVersion}`,
  )
  require_(
    isFile(join(nodeModules, "isomorphic-git", "http", "node", "index.js")),
    "缺少 isomorphic-git/http/node/index.js 入口",
  )

  const diffManifest = join(nodeModules, "diff", "package.json")
  require_(isFile(diffManifest), `缺少 ${diffManifest}`)
  const diffVersion = JSON.parse(readText(diffManifest)).version
  require_(diffVersion === JSDIFF_VERSION, `diff 版本不符：期望 ${JSDIFF_VERSION}，实际 ${diffVersion}`)

  // 只数真实包目录（排除 `.bin` / `.package-lock.json` 这类 npm 元数据）
  const packages = listDir(nodeModules).filter((name) => !name.startsWith(".")).length
  require_(packages === GIT_RUNTIME_PACKAGES, `运行时包数不符：期望 ${GIT_RUNTIME_PACKAGES}，实际 ${packages}`)

  const files = findFiles(nodeModules, () => true)
  const bytes = files.reduce((total, file) => total + fileSize(file), 0)
  require_(bytes <= GIT_RUNTIME_MAX_BYTES, `运行时体积超限：${bytes} > ${GIT_RUNTIME_MAX_BYTES}`)
  const native = files.filter((file) => /\.(node|so)$/iu.test(file))
  require_(native.length === 0, `运行时里出现原生模块（设备不可用）：${native.slice(0, 5).join(", ")}`)

  log(
    3,
    `git 运行时断言通过：isomorphic-git@${gitVersion} + diff@${diffVersion}，${packages} 包 / ${bytes} B（${(bytes / 1e6).toFixed(2)} MB）`,
  )
}

// ------------------------------------------------------------------ main

async function main() {
  if (args.has("self-test")) {
    selfTest()
    return
  }
  const plugins = discoverPlugins()
  // 导入式工具元数据检查（用户可见文案 + 工具名契约）
  await assertToolMetadata(plugins)
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
  // 204：git 插件的第三方依赖物化（必须在源码投放之后：投放会先清空目标目录）
  collectPluginRuntime(plugins)
  require_(scripts.length > 0, "投放结果里没有任何 .js（插件入口缺失）")
  for (const entry of scripts) checkJavaScript(entry.destination, entry.relative)
  log(3, `node --check 全部通过（${scripts.length} 个 .js，含 ESM 复核）`)
  verifyCollection(copied)
  warnIfWhitelistMissing()
  console.log(
    `[oc-desktop] 完成：插件已随包投放 ${plugins.length} 个（${copied.length} 个文件）→ ${APP_RESFILE_DIR}/plugins`,
  )
}

main().catch((error) => {
  console.error(`[oc-desktop] 错误: ${error && error.message ? error.message : String(error)}`)
  process.exit(1)
})
