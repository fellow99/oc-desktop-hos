#!/usr/bin/env node
/**
 * test-harmony-plugins.mjs —— host 侧语义测试（不依赖真机能力，specs/102-harmony-js-tools FR-tool-021）。
 *
 * 覆盖 test-cases.md 的 JT-10…JT-26：命中/不命中/忽略大小写/字面量/glob 过滤/跳过目录/
 * 上限截断/limit/不可读路径/二进制跳过/长行截断/深度上限/哨兵解析/哨兵抗碰撞/输出上限/参数校验。
 *
 * 用法：node scripts/test-harmony-plugins.mjs [--keep]
 *   --keep  保留夹具目录（默认跑完删除）
 *
 * 夹具落在 `$PI_SCRATCH_DIR`（缺省 os.tmpdir()）下：不入库、不污染工作区。
 * 真机专属行为（子进程事件不触发、/system/bin/sh）不在此测；常驻 shell 用「假 sh」注入验证协议。
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import process from "node:process"
import { EventEmitter } from "node:events"
import { LOG_PREFIX } from "./lib/util.mjs"
import {
  MAX_DEPTH,
  MAX_FILES,
  MAX_FILE_BYTES,
  MAX_LIMIT,
  MAX_LINE_CHARS,
  MAX_MATCH_CHARS,
  MAX_RESULTS,
  SKIP_DIRS,
  findTree,
  globSource,
  readTextFile,
  searchTree,
  walk,
} from "../plugins/oc-plugin-harmony-search/lib/walk.js"
import searchPlugin, {
  formatGlobContent,
  formatGrepContent,
  globArguments,
  globTool,
  grepArguments,
  grepTool,
} from "../plugins/oc-plugin-harmony-search/index.js"
import shellPlugin, {
  DEFAULT_TIMEOUT_MS,
  MAX_OUTPUT_BYTES,
  commandScript,
  createResidentShell,
  findSentinel,
  formatShellContent,
  parseSentinelLine,
  sentinelLine,
  shellArguments,
  shellTool,
} from "../plugins/oc-plugin-harmony-shell/index.js"

const KEEP = process.argv.includes("--keep")
const SCRATCH = process.env.PI_SCRATCH_DIR || os.tmpdir()
const FIXTURE_ROOT = path.join(SCRATCH, `harmony-plugin-fixture-${process.pid}`)
const MAIN_ROOT = path.join(FIXTURE_ROOT, "main")

let passed = 0
const failures = []

function check(name, condition, detail) {
  if (condition) {
    passed += 1
    console.log(`${LOG_PREFIX}[test] PASS ${name}`)
    return true
  }
  failures.push(name)
  console.log(`${LOG_PREFIX}[test] FAIL ${name}${detail === undefined ? "" : ` —— ${detail}`}`)
  return false
}

const pathsOf = (items) => items.map((item) => item.path)
const sorted = (values) => [...values].sort()
const writeText = (target, text) => {
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, text)
}

/** ------------------------------------------------ 夹具 */
function buildFixture() {
  fs.rmSync(FIXTURE_ROOT, { recursive: true, force: true })
  fs.mkdirSync(MAIN_ROOT, { recursive: true })

  writeText(path.join(MAIN_ROOT, "a.txt"), "hello world\nHELLO WORLD\nthird hello line\n")
  writeText(path.join(MAIN_ROOT, "b.md"), "hello from md\n")
  writeText(path.join(MAIN_ROOT, "literal.txt"), `axb literal\na.b literal\n${`hello ${"y".repeat(500)}`}\n`)
  writeText(path.join(MAIN_ROOT, "deep", "f.txt"), "hello deep\n")
  writeText(path.join(MAIN_ROOT, "sub", "nested", "one.js"), "hello js\n")
  writeText(path.join(MAIN_ROOT, "sub", "nested", "one.ts"), "hello ts\n")
  writeText(path.join(MAIN_ROOT, "node_modules", "skip.txt"), "hello skipped\n")
  writeText(path.join(MAIN_ROOT, ".git", "skip.txt"), "hello git\n")
  writeText(path.join(MAIN_ROOT, "oh_modules", "skip.txt"), "hello oh\n")
  writeText(path.join(MAIN_ROOT, "big.txt"), `${"x".repeat(MAX_FILE_BYTES + 1000)}\nhello big\n`)
  fs.writeFileSync(path.join(MAIN_ROOT, "bin.dat"), Buffer.concat([Buffer.from("hello\0binary"), Buffer.alloc(64, 1)]))
  // 行切分回归夹具：内容**以换行结尾**（rg 不会为结尾的 \n 报一条空行匹配）
  writeText(path.join(MAIN_ROOT, "trailing.txt"), "only line\n")

  // 深度上限：depth/n1..n6/shallow.txt 是 depth 8（可见），depth/n1..n7/deep.txt 是 depth 9（不可见）
  const chain = ["depth", "n1", "n2", "n3", "n4", "n5", "n6", "n7"].reduce((current, name) => path.join(current, name), MAIN_ROOT)
  const shallow = path.join(MAIN_ROOT, "depth", "n1", "n2", "n3", "n4", "n5", "n6")
  writeText(path.join(shallow, "shallow.txt"), "hello shallow\n")
  writeText(path.join(chain, "deep.txt"), "hello too deep\n")

  // 文件数上限：超过 MAX_FILES 的目录（单独一棵，避免拖慢其它用例）
  const many = path.join(FIXTURE_ROOT, "many")
  fs.mkdirSync(many, { recursive: true })
  for (let index = 0; index < MAX_FILES + 1; index += 1) fs.writeFileSync(path.join(many, `f${String(index).padStart(4, "0")}.txt`), "x")

  // 小上限夹具（不依赖 2000 个文件也能验证「上限命中即标注」）
  const small = path.join(FIXTURE_ROOT, "small")
  fs.mkdirSync(small, { recursive: true })
  for (let index = 0; index < 30; index += 1) fs.writeFileSync(path.join(small, `s${String(index).padStart(3, "0")}.txt`), "hello small\n")
}

/** ------------------------------------------------ 常量与契约 */
function testConstantsAndContract() {
  check("常量 MAX_FILES=2000", MAX_FILES === 2000, String(MAX_FILES))
  check("常量 MAX_FILE_BYTES=524288", MAX_FILE_BYTES === 524288, String(MAX_FILE_BYTES))
  check("常量 MAX_DEPTH=8", MAX_DEPTH === 8, String(MAX_DEPTH))
  check("常量 MAX_LINE_CHARS=300", MAX_LINE_CHARS === 300, String(MAX_LINE_CHARS))
  check("常量 MAX_RESULTS=200", MAX_RESULTS === 200, String(MAX_RESULTS))
  check("常量 MAX_OUTPUT_BYTES=262144", MAX_OUTPUT_BYTES === 262144, String(MAX_OUTPUT_BYTES))
  check("常量 DEFAULT_TIMEOUT_MS=120000", DEFAULT_TIMEOUT_MS === 120000, String(DEFAULT_TIMEOUT_MS))
  check(
    "SKIP_DIRS 含业务约定目录",
    ["node_modules", ".git", "oh_modules", ".cache", "build", ".hvigor"].every((name) => SKIP_DIRS.has(name)),
    sorted(SKIP_DIRS).join(","),
  )
  check("搜索插件默认导出 { id, setup }", typeof searchPlugin.id === "string" && typeof searchPlugin.setup === "function", JSON.stringify(Object.keys(searchPlugin)))
  check("shell 插件默认导出 { id, setup }", typeof shellPlugin.id === "string" && typeof shellPlugin.setup === "function", JSON.stringify(Object.keys(shellPlugin)))
}

/** ------------------------------------------------ grep 语义 JT-10…JT-14、JT-16、JT-18…JT-21 */
function testGrep() {
  const all = searchTree({ root: MAIN_ROOT, pattern: "hello" })
  // a.txt(2) + b.md(1) + literal.txt(1) + deep/f.txt(1) + sub/nested/one.js(1) + sub/nested/one.ts(1)
  // + depth/n1..n6/shallow.txt(1) = 8
  check("JT-10 grep 命中数（大小写敏感 8 处）", all.matches.length === 8, `实际 ${all.matches.length}`)
  check(
    "JT-10 命中项含 path/line/text",
    all.matches.every((match) => typeof match.path === "string" && Number.isInteger(match.line) && typeof match.text === "string"),
    JSON.stringify(all.matches[0]),
  )
  check("JT-10 行号正确（a.txt:1）", all.matches.some((match) => match.path === "a.txt" && match.line === 1), JSON.stringify(pathsOf(all.matches)))

  const upper = searchTree({ root: MAIN_ROOT, pattern: "world", ignoreCase: false })
  const upperInsensitive = searchTree({ root: MAIN_ROOT, pattern: "world", ignoreCase: true })
  check("JT-12 ignoreCase=false 只命中 1 处", upper.matches.length === 1, `实际 ${upper.matches.length}`)
  check("JT-12 ignoreCase=true 命中 2 处", upperInsensitive.matches.length === 2, `实际 ${upperInsensitive.matches.length}`)

  const regex = searchTree({ root: MAIN_ROOT, pattern: "a.b", glob: "literal.txt" })
  const literal = searchTree({ root: MAIN_ROOT, pattern: "a.b", glob: "literal.txt", literal: true })
  check("JT-13 正则解释 . （命中 axb/a.b 两行）", regex.matches.length === 2, `实际 ${regex.matches.length}`)
  check("JT-13 literal=true 只命中字面量 a.b", literal.matches.length === 1 && literal.matches[0].line === 2, JSON.stringify(literal.matches))

  const mdOnly = searchTree({ root: MAIN_ROOT, pattern: "hello", glob: "*.md" })
  check("JT-14 glob 过滤 *.md 只返回 md", mdOnly.matches.length === 1 && mdOnly.matches[0].path === "b.md", JSON.stringify(pathsOf(mdOnly.matches)))

  const miss = searchTree({ root: MAIN_ROOT, pattern: "no-such-token-xyz" })
  check("JT-11 不命中时结果为空", miss.matches.length === 0, String(miss.matches.length))
  check("JT-11 不命中措辞明确", formatGrepContent(miss).includes("No matches found"), formatGrepContent(miss))
  check("JT-10 命中措辞含条数", formatGrepContent(all).startsWith("Found 8 matches"), formatGrepContent(all).split("\n")[0])

  const skipped = pathsOf(all.matches).join("\n")
  check("JT-16 跳过 node_modules/.git/oh_modules", !skipped.includes("node_modules") && !skipped.includes(".git") && !skipped.includes("oh_modules"), skipped)
  check("JT-16 命中项不含被跳过目录的文件", all.matches.every((match) => !match.path.startsWith("node_modules/")), JSON.stringify(pathsOf(all.matches)))
  check("JT-20 二进制文件被跳过且计入统计", all.binary === 1 && !pathsOf(all.matches).includes("bin.dat"), `binary=${all.binary}`)
  check("JT-20 readTextFile 判定二进制", readTextFile(path.join(MAIN_ROOT, "bin.dat")).kind === "binary")
  check("JT-19 readTextFile 对目录返回 error（不抛）", readTextFile(path.join(MAIN_ROOT, "deep")).kind === "error")

  const longLine = all.matches.find((match) => match.path === "literal.txt" && match.line === 3)
  check("JT-21 超长行截断到 MAX_LINE_CHARS", longLine !== undefined && longLine.text.length === MAX_LINE_CHARS, `长度 ${longLine === undefined ? "缺失" : longLine.text.length}`)
  check("JT-21 截断在结果中标注", all.truncated.lines === true, JSON.stringify(all.truncated))
  check("JT-21 截断标注出现在文本里", formatGrepContent(all).includes(`truncated to ${MAX_LINE_CHARS} characters`), formatGrepContent(all).split("\n").slice(-3).join(" | "))
  check("JT-14/FR-tool-014 大文件按字节上限截断并标注", all.truncated.bytes === true, JSON.stringify(all.truncated))
  check("JT-14 大文件超出上限的内容不产生命中", !pathsOf(all.matches).includes("big.txt"), JSON.stringify(pathsOf(all.matches)))

  const limited = searchTree({ root: MAIN_ROOT, pattern: "hello", limit: 2 })
  check("JT-18 limit 生效（条数 ≤ limit）", limited.matches.length === 2, String(limited.matches.length))
  check("JT-18 limit 截断显式标注", limited.truncated.results === true, JSON.stringify(limited.truncated))
  check("JT-18 limit 缺省取 MAX_RESULTS", grepArguments({ pattern: "x" }).value.limit === MAX_RESULTS, String(grepArguments({ pattern: "x" }).value.limit))

  const deep = searchTree({ root: MAIN_ROOT, pattern: "hello shallow|hello too deep" })
  check("JT-22 深度 8 的条目可见", pathsOf(deep.matches).includes("depth/n1/n2/n3/n4/n5/n6/shallow.txt"), JSON.stringify(pathsOf(deep.matches)))
  check("JT-22 超深条目不可见", !pathsOf(deep.matches).some((value) => value.endsWith("deep.txt")), JSON.stringify(pathsOf(deep.matches)))
  check("JT-22 深度截断显式标注", deep.truncated.depth === true, JSON.stringify(deep.truncated))

  // code-review 修复的回归用例（Critical/Important 项）
  const clamped = grepArguments({ pattern: "x", limit: 1000000 })
  check("CR-1 limit 被硬上限钳制", clamped.value.limit === MAX_LIMIT, String(clamped.value.limit))
  check("CR-1 钳制事实被显式带出", clamped.value.limitClamped === true, String(clamped.value.limitClamped))
  check("CR-1 未超上限时不标钳制", grepArguments({ pattern: "x", limit: 5 }).value.limitClamped === false)
  const clampedGlob = globArguments({ pattern: "**/*", limit: 999999 })
  check("CR-1 glob 的 limit 同样被钳制", clampedGlob.value.limit === MAX_LIMIT && clampedGlob.value.limitClamped === true)
  const cappedTree = searchTree({ root: MAIN_ROOT, pattern: "hello", limit: 1000000 })
  check("CR-1 searchTree 忽略超上限入参并停在 MAX_LIMIT 内", cappedTree.matches.length <= MAX_LIMIT, String(cappedTree.matches.length))
}

/** ------------------------------------------------ glob 语义 JT-15 与跳过/上限 */
function testGlob() {
  const js = findTree({ root: MAIN_ROOT, pattern: "**/*.js" })
  check("JT-15 glob **/*.js 命中预期集合", JSON.stringify(pathsOf(js.entries)) === JSON.stringify(["sub/nested/one.js"]), JSON.stringify(pathsOf(js.entries)))

  const txt = findTree({ root: MAIN_ROOT, pattern: "*.txt" })
  check(
    "glob 无斜杠模式按基名匹配（任意层级）",
    JSON.stringify(sorted(pathsOf(txt.entries))) ===
      JSON.stringify(["a.txt", "big.txt", "deep/f.txt", "depth/n1/n2/n3/n4/n5/n6/shallow.txt", "literal.txt", "trailing.txt"]),
    JSON.stringify(sorted(pathsOf(txt.entries))),
  )

  const scoped = findTree({ root: MAIN_ROOT, pattern: "sub/**/*.ts" })
  check("glob 带斜杠模式匹配相对路径", JSON.stringify(pathsOf(scoped.entries)) === JSON.stringify(["sub/nested/one.ts"]), JSON.stringify(pathsOf(scoped.entries)))

  const brace = findTree({ root: MAIN_ROOT, pattern: "*.{md,js}" })
  check("glob 花括号展开", JSON.stringify(sorted(pathsOf(brace.entries))) === JSON.stringify(["b.md", "sub/nested/one.js"]), JSON.stringify(sorted(pathsOf(brace.entries))))

  const none = findTree({ root: MAIN_ROOT, pattern: "**/*.rs" })
  check("glob 不命中措辞明确", none.entries.length === 0 && formatGlobContent(none).includes("No files found"), formatGlobContent(none))

  const limited = findTree({ root: MAIN_ROOT, pattern: "*.txt", limit: 1 })
  check("glob limit 生效且标注截断", limited.entries.length === 1 && limited.truncated.results === true, JSON.stringify(limited.truncated))

  const many = walk(path.join(FIXTURE_ROOT, "many"))
  check("JT-17 超过 MAX_FILES 的目录被截断", many.files.length === MAX_FILES && many.truncated.files === true, `files=${many.files.length} truncated=${JSON.stringify(many.truncated)}`)
  const small = walk(path.join(FIXTURE_ROOT, "small"), { maxFiles: 10 })
  check("JT-17 小上限同样标注截断", small.files.length === 10 && small.truncated.files === true, `files=${small.files.length}`)
  const withinCap = walk(MAIN_ROOT)
  check("JT-17 未命中上限时不误标截断", withinCap.truncated.files === false && withinCap.truncated.depth === true, JSON.stringify(withinCap.truncated))

  // Minor 回归：globset 取反类与行切分（code-review Minor 1/2）
  check("CR-m1 glob [!abc] 翻译为取反类", globSource("[!a]") === "[^a]", globSource("[!a]"))
  check("CR-m1 glob [a!b] 的 ! 保持字面量", globSource("[a!b]") === "[a!b]", globSource("[a!b]"))
  check("CR-m1 [!.]* 不匹配以点开头的名字", !new RegExp(`^${globSource("[!.]*")}$`).test(".hidden"), globSource("[!.]*"))
  check("CR-m1 [!.]* 匹配普通名字", new RegExp(`^${globSource("[!.]*")}$`).test("visible"), globSource("[!.]*"))
  check(
    "CR-m2 结尾换行不产生幽灵空行（^ 不误配）",
    searchTree({ root: MAIN_ROOT, pattern: "^$", path: path.join(MAIN_ROOT, "trailing.txt") }).matches.length === 0,
    String(searchTree({ root: MAIN_ROOT, pattern: "^$", path: path.join(MAIN_ROOT, "trailing.txt") }).matches.length),
  )
  check("CR-2 匹配窗口常量存在且为正", Number.isInteger(MAX_MATCH_CHARS) && MAX_MATCH_CHARS > 0, String(MAX_MATCH_CHARS))
}

/** ------------------------------------------------ 不可读/缺失路径 JT-19 */
function testUnreadable() {
  const missing = path.join(FIXTURE_ROOT, "no-such-dir")
  const result = walk(missing)
  check("JT-19 缺失目录不抛错且返回空", result.files.length === 0 && result.errors.length === 1, JSON.stringify(result.errors))
  check("JT-19 缺失目录错误可读", result.errors[0].message.includes("ENOENT") || result.errors[0].message.length > 0, result.errors[0].message)

  const throughFile = path.join(MAIN_ROOT, "a.txt", "nested")
  const enotdir = searchTree({ root: throughFile, pattern: "hello" })
  check("JT-19 路径穿透文件（ENOTDIR）不抛错且继续", enotdir.matches.length === 0 && enotdir.errors.length >= 1, JSON.stringify(enotdir.errors))

  const mixed = searchTree({ root: MAIN_ROOT, pattern: "hello", maxFiles: 3 })
  check("JT-19 部分文件被跳过时仍返回结果", mixed.matches.length > 0 && mixed.unreadable === 0, `matches=${mixed.matches.length}`)
}

/** ------------------------------------------------ 参数校验 JT-26 */
function testArguments() {
  check("JT-26 grep 缺 pattern 报错", grepArguments({}).ok === false, JSON.stringify(grepArguments({})))
  check("JT-26 grep 空 pattern 报错", grepArguments({ pattern: "" }).ok === false)
  check("JT-26 glob 缺 pattern 报错", globArguments({}).ok === false)
  check("JT-26 shell 缺 command 报错", shellArguments({}).ok === false)
  check("JT-26 shell 空白 command 报错", shellArguments({ command: "   " }).ok === false)
  check("JT-26 limit 非法报错", grepArguments({ pattern: "x", limit: 0 }).ok === false)
  check("JT-26 timeout 非法报错", shellArguments({ command: "ls", timeout: 0 }).ok === false)
  check("JT-26 shell 默认超时 120000", shellArguments({ command: "ls" }).value.timeout === DEFAULT_TIMEOUT_MS)
}

/** ------------------------------------------------ 哨兵协议 JT-23/JT-24 */
function testSentinelProtocol() {
  const nonce = "0123456789abcdef"
  const line = sentinelLine(nonce, 7)
  check("哨兵格式 __OC_<nonce>_<rc>__", line === `__OC_${nonce}_7__`, line)
  check("JT-23 解析哨兵行 rc", (parseSentinelLine(line, nonce) ?? {}).rc === 7, JSON.stringify(parseSentinelLine(line, nonce)))
  const withMs = sentinelLine(nonce, 3, 12)
  check("JT-23 解析四字段哨兵（rc+ms）", JSON.stringify(parseSentinelLine(withMs, nonce)) === JSON.stringify({ rc: 3, ms: 12 }), withMs)
  check("JT-24 其它 nonce 不误判", parseSentinelLine(sentinelLine("deadbeefdeadbeef", 0), nonce) === undefined)

  const found = findSentinel(`cmd output\n${line}\n`, nonce)
  check("JT-23 findSentinel 返回匹配位置", found !== undefined && found.rc === 7 && found.index === "cmd output\n".length, JSON.stringify(found))
  check("JT-24 疑似哨兵文本（不同 nonce）不终止", findSentinel("__OC_deadbeefdeadbeef_0__\n__OC_nonce_like_0__\n", nonce) === undefined)
  check("工具输出中的疑似哨兵行不误判", findSentinel(`echo "__OC_${nonce}_$?__"\nreal output\n`, nonce) === undefined)
  check("JT-23 无结尾换行不算完整哨兵", findSentinel(`${line}`, nonce) === undefined)

  const script = commandScript("ls /nonexistent; echo rc=$?", nonce)
  check("JT-23 脚本含哨兵回显（单条 echo 打印 $?）", script.includes(`echo "__OC_${nonce}_$?__"`), script.split("\n").slice(-2)[0])
  check("JT-23 脚本用唯一 heredoc 标记承载命令原文", script.includes(`cat <<'__OCEOF_${nonce}__'`) && script.includes(`\n__OCEOF_${nonce}__\n`), script.split("\n")[0])
  check("JT-23 命令原文仍在 stdin 脚本内", script.includes("ls /nonexistent; echo rc=$?"))
  check("JT-23 子 shell 隔离 + stderr 并入 stdout + stdin 隔离", script.includes(`( eval "$__oc_command" ) </dev/null 2>&1`))
}

/** ------------------------------------------------ 常驻 shell 协议（假 sh 注入） */
/**
 * 假 sh：只实现插件用到的那部分子进程契约（stdin.write / stdout.on("data") / kill），
 * 按「第几次写入」回显哨兵（第 1 次写入是插件的就绪探测）。真机专属行为不在 host 侧断言。
 *   - silent: true            永不回显（就绪探测即失败）
 *   - answerWrites: n         只回显前 n 次写入（之后挂住，模拟超时）
 *   - outputFor(index)        第 index 次写入的输出
 *   - rcFor(index)            第 index 次写入的退出码
 *   - chunk                   回显分片大小（模拟跨 chunk 的哨兵拼接）
 */
const createFakeShell = (behaviour = {}) => {
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.stdin = new EventEmitter()
  child.killed = false
  child.writes = 0
  child.stdout.setEncoding = () => {}
  child.stderr.setEncoding = () => {}
  child.stdin.setEncoding = () => {}
  child.kill = () => {
    child.killed = true
  }
  child.stdin.write = (text) => {
    child.writes += 1
    const index = child.writes
    if (behaviour.silent === true) return true
    if (behaviour.answerWrites !== undefined && index > behaviour.answerWrites) return true
    const matches = [...text.matchAll(/__OC_([0-9a-f]{16})_/g)]
    if (matches.length === 0) return true
    const nonce = matches[matches.length - 1][1]
    const body = typeof behaviour.outputFor === "function" ? behaviour.outputFor(index) : (behaviour.output ?? "")
    const rc = typeof behaviour.rcFor === "function" ? behaviour.rcFor(index) : (behaviour.rc ?? 0)
    const payload = `${body}${sentinelLine(nonce, rc)}\n`
    const chunk = behaviour.chunk ?? 7
    let offset = 0
    const pump = () => {
      if (child.killed || offset >= payload.length) return
      child.stdout.emit("data", payload.slice(offset, offset + chunk))
      offset += chunk
      setTimeout(pump, 0)
    }
    setTimeout(pump, 0)
    return true
  }
  return child
}

async function testResidentShell() {
  const first = createFakeShell({ outputFor: (index) => `call ${index - 1} output\n`, rcFor: (index) => (index <= 1 ? 0 : index - 2) })
  const resident = createResidentShell({ root: MAIN_ROOT, createChild: () => first })
  const ok = await resident.execute("echo hello")
  check("常驻 shell 首条命令返回 rc=0", ok.ok === true && ok.rc === 0, JSON.stringify(ok))
  check("命令输出进入 content 且带退出码", ok.output.includes("call 1 output") && formatShellContent(ok).includes("[exit code: 0]"), formatShellContent(ok))
  check("超时缺省为 DEFAULT_TIMEOUT_MS", resident.defaultTimeout === DEFAULT_TIMEOUT_MS, String(resident.defaultTimeout))

  const second = await resident.execute("false")
  check("JT-39 连续两次调用不串输出", second.ok === true && second.rc === 1 && second.output.trim() === "call 2 output", JSON.stringify(second))
  check("JT-39 首次调用输出不残留在第二次", !second.output.includes("call 1 output"), JSON.stringify(second.output))
  resident.dispose()

  // 哨兵抗碰撞 + 跨 chunk 拼接
  const collide = createResidentShell({
    root: MAIN_ROOT,
    createChild: () =>
      createFakeShell({
        output: "__OC_deadbeefdeadbeef_0__\npart of a fake sentinel\n__OC_0123_1__\n",
        rc: 9,
        chunk: 3,
      }),
  })
  const collided = await collide.execute("printf '__OC_deadbeefdeadbeef_0__'")
  check("JT-24 假哨兵不提前终止（rc 取真实哨兵）", collided.ok === true && collided.rc === 9, JSON.stringify(collided))
  check("JT-24 假哨兵仍作为输出保留", collided.output.includes("__OC_deadbeefdeadbeef_0__"), JSON.stringify(collided.output))
  collide.dispose()

  // 输出上限 + 截断标注
  const cap = createResidentShell({
    root: MAIN_ROOT,
    createChild: () => createFakeShell({ output: "z".repeat(MAX_OUTPUT_BYTES + 5000), rc: 0, chunk: 65536 }),
  })
  const capped = await cap.execute("cat huge")
  check("JT-25 输出超上限被截断", capped.ok === true && capped.truncated === true, JSON.stringify({ ok: capped.ok, truncated: capped.truncated }))
  check("JT-25 截断按字节精确封顶", Buffer.byteLength(capped.output, "utf8") === MAX_OUTPUT_BYTES, String(Buffer.byteLength(capped.output, "utf8")))
  check("JT-25 截断在 content 中显式标注", formatShellContent(capped).includes(`truncated at ${MAX_OUTPUT_BYTES} bytes`), formatShellContent(capped).slice(-80))
  cap.dispose()

  // 超时 → 杀进程 → 下次调用惰性重启（JT-37 host 侧）
  let spawnCount = 0
  const stuck = createFakeShell({ answerWrites: 1 })
  const recovered = createResidentShell({
    root: MAIN_ROOT,
    createChild: () => {
      spawnCount += 1
      return spawnCount === 1 ? stuck : createFakeShell({ output: "after restart\n", rc: 0 })
    },
  })
  const timedOut = await recovered.execute("sleep 300", 60)
  check("JT-37 超时返回明确错误", timedOut.ok === false && timedOut.code === "timeout" && timedOut.message.includes("未结束"), JSON.stringify(timedOut))
  check("JT-37 超时后杀掉常驻 shell", stuck.killed === true, String(stuck.killed))
  const restarted = await recovered.execute("echo after")
  check("JT-37 超时后下次调用自动重启成功", restarted.ok === true && restarted.output.includes("after restart") && spawnCount === 2, `spawnCount=${spawnCount}`)
  recovered.dispose()

  // abort/卸载 → 释放常驻进程（就绪后挂住的命令在 dispose 时结算）
  const abortChild = createFakeShell({ answerWrites: 1 })
  const aborted = createResidentShell({ root: MAIN_ROOT, createChild: () => abortChild })
  const inflight = aborted.execute("sleep 300", 10000)
  await new Promise((resolve) => setTimeout(resolve, 30))
  aborted.dispose()
  const killed = await inflight
  check("中断/卸载丢弃常驻 shell 并结算调用", killed.ok === false && killed.code === "killed" && abortChild.killed === true, JSON.stringify(killed))

  // 启动失败（spawn 抛错）→ 明确错误而不是挂死
  const broken = createResidentShell({
    root: MAIN_ROOT,
    createChild: () => {
      throw new Error("ENOENT /system/bin/sh")
    },
  })
  const brokenResult = await broken.execute("ls")
  check("spawn 失败返回明确错误", brokenResult.ok === false && brokenResult.code === "spawn-failed", JSON.stringify(brokenResult))
}

/**
 * 工具层：`shellTool(resident).execute(input, context)`。
 * 宿主（packages/plugin/src/promise/adapter.ts）**总会**传入 `context.signal`；
 * 2026-10-14 真机实测暴露过一处只在「有 signal」时才触发的缺陷（`finally` 里引用了
 * 只存在于 `runCommand` 作用域的 `onAbort` ⇒ 每次调用都以 `onAbort is not defined` 失败，
 * 而当时的用例集只测 `createResidentShell`，因此 96 项全绿却漏掉了它）。这里补上工具层用例。
 */
async function testShellToolExecute() {
  const child = createFakeShell({ output: "tool output\n", rc: 0 })
  const resident = createResidentShell({ root: MAIN_ROOT, createChild: () => child })
  const tool = shellTool(resident)
  check(
    "shell 工具 name/description/input 齐备",
    tool.name === "shell" && typeof tool.description === "string" && tool.input !== undefined,
    JSON.stringify({ name: tool.name, hasDescription: typeof tool.description === "string" }),
  )

  // ① 带未中断的 AbortSignal：必须成功返回（回归点：清理钩子不得引用来路不明的标识符）
  const controller = new AbortController()
  let withSignal
  let thrown
  try {
    withSignal = await tool.execute({ command: "echo hi" }, { signal: controller.signal })
  } catch (error) {
    thrown = error
  }
  check("带 AbortSignal 的 execute 不抛异常（onAbort 作用域回归）", thrown === undefined, thrown === undefined ? "" : String(thrown && thrown.message))
  check(
    "带 AbortSignal 的 execute 正常返回内容与退出码",
    withSignal !== undefined &&
      typeof withSignal.content === "string" &&
      withSignal.content.includes("tool output") &&
      withSignal.metadata !== undefined &&
      withSignal.metadata.exitCode === 0 &&
      withSignal.metadata.error === undefined,
    JSON.stringify(withSignal),
  )

  // ② 宿主没给 context：同样必须成功（不得因缺 signal 而改变行为）
  const noContext = await tool.execute({ command: "echo hi" })
  check(
    "无 context 的 execute 正常返回",
    typeof noContext.content === "string" && noContext.metadata.exitCode === 0,
    JSON.stringify(noContext),
  )

  // ③ 调用前就已中断：走 killed 结果路径，且**不抛异常**
  const preAborted = new AbortController()
  preAborted.abort()
  const killedResult = await tool.execute({ command: "echo hi" }, { signal: preAborted.signal })
  check(
    "已中断的 signal 返回 killed 结果而非抛异常",
    typeof killedResult.content === "string" &&
      killedResult.metadata.error !== undefined &&
      killedResult.metadata.timeout === false,
    JSON.stringify(killedResult),
  )

  // ④ 非法参数 + 有 signal：走 errorResult（不抛）
  const badArgs = await tool.execute({ command: 42 }, { signal: controller.signal })
  check(
    "非法参数 + signal 走 errorResult（不抛）",
    typeof badArgs.content === "string" && badArgs.metadata.error === true,
    JSON.stringify(badArgs),
  )

  resident.dispose()
  check("工具层用例结束后常驻 shell 被释放", child.killed === true, String(child.killed))
}

/**
 * 三个工具（shell / grep / glob）的**宿主契约**用例。
 * `packages/plugin/src/promise/tool.ts` 的 `Info.execute` 声明为 `Promise<Tool.Result>`，
 * 宿主注册后直接 `.then(...)`；返回同步值会在运行期变成
 * `internalCall(...).then is not a function`（2026-10-14 真机实测，grep/glob 两个工具都中招）。
 * 本用例只断言「是 thenable + 结果形状」，不重复各工具的行为断言。
 */
async function testToolContract() {
  const resident = createResidentShell({
    root: MAIN_ROOT,
    createChild: () => createFakeShell({ output: "ok\n", rc: 0 }),
  })
  const tools = [
    ["shell", shellTool(resident), { command: "echo ok" }],
    ["grep", grepTool(MAIN_ROOT), { pattern: "hello" }],
    ["glob", globTool(MAIN_ROOT), { pattern: "**/*.txt" }],
  ]
  for (const [name, tool, input] of tools) {
    let returned
    let thrown
    try {
      returned = tool.execute(input, { signal: new AbortController().signal })
    } catch (error) {
      thrown = error
    }
    check(
      `${name}: execute 同步阶段不抛异常`,
      thrown === undefined,
      thrown === undefined ? "" : String(thrown && thrown.message),
    )
    check(
      `${name}: execute 返回 thenable（宿主契约 Promise<Tool.Result>）`,
      returned !== null && typeof returned === "object" && typeof returned.then === "function",
      `typeof=${typeof returned}`,
    )
    if (thrown === undefined && returned !== null && typeof returned.then === "function") {
      const result = await returned
      check(
        `${name}: 结果含 content 字符串与 metadata 对象`,
        typeof result.content === "string" && result.content.length > 0 && typeof result.metadata === "object",
        JSON.stringify(result).slice(0, 160),
      )
    }
  }
  resident.dispose()
}

/** ------------------------------------------------ main */
async function main() {
  console.log(`${LOG_PREFIX}[test] 夹具目录 ${FIXTURE_ROOT}`)
  buildFixture()
  testConstantsAndContract()
  testGrep()
  testGlob()
  testUnreadable()
  testArguments()
  testSentinelProtocol()
  await testResidentShell()
  await testShellToolExecute()
  await testToolContract()

  if (!KEEP) fs.rmSync(FIXTURE_ROOT, { recursive: true, force: true })
  else console.log(`${LOG_PREFIX}[test] 保留夹具（--keep）`)

  console.log(`${LOG_PREFIX}[test] PASS ${passed} / FAIL ${failures.length}`)
  if (failures.length > 0) {
    console.log(`${LOG_PREFIX}[test] 失败用例：\n  - ${failures.join("\n  - ")}`)
    process.exit(1)
  }
}

await main()
