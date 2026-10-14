/**
 * oc-plugin-harmony-shell —— 用「常驻 /system/bin/sh + 哨兵行」替换设备上会挂死的 `shell` 工具。
 *
 * 为什么需要它（specs/102-harmony-js-tools §3 G1）：
 *   上游 `shell` 走「跨平台子进程包装 → node:child_process」的路径启动命令，并等待子进程 `exit` / `close`
 *   事件或 `cp.exec` 回调。设备上这两类事件**永不触发**（docs/鸿蒙环境能力清单 #10），工具因此挂死。
 *   这里把「命令结束」的判定从**进程事件**改为 stdout 上的**随机哨兵行**，纯 JS 可完成。
 *
 * ⚠️ 性质说明（FR-tool-010，必须如实披露）：
 *   这是**工具层围栏（tool-level fence），不是沙箱**。命令以插件（服务端）同等权限执行，
 *   内容完全由命令自身决定，**可以被绕过**。插件只负责「让结束判定确定、输出有上限、超时可中止」。
 *
 * 协议（每次调用，写入常驻 shell 的 stdin；绝不等待 exit/close 事件）：
 *   __oc_command=$(cat <<'__OCEOF_<nonce>__'      ← 用唯一 heredoc 标记原样读入命令文本，
 *   <command 原文>                                   引号/反斜杠不可能冲垮协议
 *   __OCEOF_<nonce>__
 *   )
 *   ( eval "$__oc_command" ) 2>&1                  ← 子 shell 隔离（cd/exit 不外泄）+ stderr 并入 stdout
 *   echo "__OC_<nonce>_$?__"                       ← 唯一哨兵行：随机 nonce + 退出码，单条 echo 打印 $?
 *
 *   `<ms>` 由**宿主时钟**测量（wait 返回 elapsedMs）：设备 sh 没有可移植的毫秒时钟
 *   （`date +%s%3N` 是 GNU 扩展），把耗时放哨兵里会让协议依赖 `date`，一旦缺失就必然超时。
 *   `findSentinel`/`parseSentinelLine` 兼容 `__OC_<nonce>_<rc>_<ms>__` 四字段形态。
 */
import { spawn } from "node:child_process"
import crypto from "node:crypto"

export const DEFAULT_TIMEOUT_MS = 120000
export const MAX_OUTPUT_BYTES = 262144
export const READY_TIMEOUT_MS = 5000
/** 跨 chunk 探测哨兵时保留的尾巴字符数（哨兵行本身约 25 字符） */
const SENTINEL_TAIL_CHARS = 64

export const createNonce = () => crypto.randomBytes(8).toString("hex")

export const sentinelLine = (nonce, rc, ms) => (ms === undefined ? `__OC_${nonce}_${rc}__` : `__OC_${nonce}_${rc}_${ms}__`)

const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/**
 * 从累积文本里找**本调用**的哨兵行（纯函数，host 侧可测）。
 * 判定条件：`__OC_<nonce>_<rc>__` 且 nonce 完全一致、且后面紧跟 `\n`（行尾锚点）。
 *   - 不要求行首锚点：命令的最后一行常常**没有换行**（`printf`/`echo -n`），哨兵会紧跟在它后面，
 *     若要求行首就永远匹配不到（真机上表现为每次调用都超时）；
 *   - 行尾锚点 + 16 字节随机 nonce 已足以抗碰撞：不完整的 `__OC_<nonce>_1`（真实 rc 是 12）不会提前命中，
 *     命令输出里的疑似哨兵文本（不同 nonce 或 `$?` 字面量）也不会误判（JT-24）。
 */
export function findSentinel(text, nonce) {
  const pattern = new RegExp(`__OC_${escapeRegExp(nonce)}_(\\d+)(?:_(\\d+))?__\\r?\\n`)
  const match = text.match(pattern)
  if (!match) return undefined
  return {
    index: match.index,
    rc: Number(match[1]),
    ms: match[2] === undefined ? undefined : Number(match[2]),
  }
}

/** 单行形态的解析（host 测试与日志用）：`__OC_<nonce>_<rc>[_<ms>]__` */
export function parseSentinelLine(line, nonce) {
  const found = findSentinel(`${String(line).trim()}\n`, nonce)
  return found === undefined ? undefined : { rc: found.rc, ms: found.ms }
}

/** 组装写入常驻 shell stdin 的整段脚本 */
export function commandScript(command, nonce) {
  const marker = `__OCEOF_${nonce}__`
  return [
    `__oc_command=$(cat <<'${marker}'`,
    String(command),
    marker,
    `)`,
    // </dev/null 是必须的：常驻 shell 的 stdin 就是脚本通道，命令若读 stdin 会吞掉后续脚本行
    // （引号不平衡时的 heredoc 定界也是为此），并阻塞到超时。命令没有任何理由读那个 fd。
    `( eval "$__oc_command" ) </dev/null 2>&1`,
    `echo "__OC_${nonce}_$?__"`,
    ``,
  ].join("\n")
}

/**
 * 常驻 shell 会话。`createChild` 仅用于 host 侧测试注入（默认实现是唯一允许的 spawn 目标
 * `/system/bin/sh`）；生产路径不接受外部注入。
 */
export function createResidentShell(options = {}) {
  const cwd = options.root ?? process.cwd()
  const defaultTimeout = options.timeout ?? DEFAULT_TIMEOUT_MS
  const createChild = options.createChild ?? defaultCreateChild

  let child = null
  let ready = null
  let pending = null
  let pendingTail = ""
  let output = ""
  let outputBytes = 0
  let outputTruncated = false
  let chain = Promise.resolve()

  /** 按字节上限累积输出（FR-tool-009：防爆内存，且截断必须显式） */
  const append = (text) => {
    if (text.length === 0 || outputTruncated) return
    const bytes = Buffer.byteLength(text, "utf8")
    if (outputBytes + bytes <= MAX_OUTPUT_BYTES) {
      output += text
      outputBytes += bytes
      return
    }
    output += Buffer.from(text, "utf8").subarray(0, Math.max(0, MAX_OUTPUT_BYTES - outputBytes)).toString("utf8")
    outputBytes = MAX_OUTPUT_BYTES
    outputTruncated = true
  }

  const settle = (result) => {
    if (pending === null) return
    const current = pending
    pending = null
    clearTimeout(current.timer)
    current.resolve(result)
  }

  const onData = (text, owner) => {
    // 代际守卫：被 dispose 掉的旧 child（或它留下、仍持有 fd 1 的孙进程）继续写数据时，
    // 这些字节必须丢弃 —— 否则会被算进**下一次调用**的输出（串结果）。
    if (owner !== undefined && owner !== child) return
    const buffer = pendingTail + text
    const found = pending === null ? undefined : findSentinel(buffer, pending.nonce)
    if (found === undefined) {
      // 尾部最多留 SENTINEL_TAIL_CHARS 个字符不落盘：否则哨兵被分片切开时，它的前半截会被当成命令输出
      const keep = Math.min(SENTINEL_TAIL_CHARS, buffer.length)
      append(buffer.slice(0, buffer.length - keep))
      pendingTail = buffer.slice(buffer.length - keep)
      return
    }
    append(buffer.slice(0, found.index))
    pendingTail = ""
    settle({ ok: true, rc: found.rc, ms: found.ms ?? Date.now() - pending.msFrom })
  }

  const disposeChild = () => {
    if (child !== null) {
      const dying = child
      // 先摘监听、再杀：否则旧 child 的 data 回调会继续往共享缓冲写（见 onData 的代际守卫）
      try {
        dying.stdout.removeAllListeners("data")
        dying.stderr.removeAllListeners("data")
        dying.removeAllListeners("error")
        dying.stdin.removeAllListeners("error")
      } catch {
        // 摘监听失败不影响正确性：代际守卫仍会丢弃旧 child 的数据
      }
      try {
        dying.kill()
      } catch {
        // 杀掉失败无所谓：进程已不可用，下一次调用会重新 spawn
      }
      // kill 只作用于常驻 shell 自身。若命令留下了继承 fd 1 的后台孙进程，本工程无法可靠回收
      //（应用域无内核沙箱；杀进程组会波及自身），该残余风险登记在 README 的「已知限制」。
    }
    child = null
    ready = null
    pendingTail = ""
    settle({ ok: false, code: "killed" })
  }

  function ensureChild() {
    if (child !== null) return child
    let spawned
    try {
      spawned = createChild(cwd)
    } catch (error) {
      return null
    }
    spawned.stdout.setEncoding("utf8")
    spawned.stderr.setEncoding("utf8")
    // stdout 与 stderr 合并进同一个缓冲：上游 shell 也是合并口径（FR-tool-009）
    spawned.stdout.on("data", (chunk) => onData(chunk, spawned))
    spawned.stderr.on("data", (chunk) => onData(chunk, spawned))
    spawned.on("error", (error) => settle({ ok: false, code: "spawn-failed", message: error.message }))
    spawned.stdin.on("error", (error) => settle({ ok: false, code: "write-failed", message: error.message }))
    child = spawned
    return child
  }

  /** 写一段文本并等它的哨兵行；超时只回报，不等待任何进程事件 */
  const send = (text, nonce, timeoutMs) =>
    new Promise((resolve) => {
      output = ""
      outputBytes = 0
      outputTruncated = false
      pendingTail = ""
      const target = ensureChild()
      if (target === null) {
        resolve({ ok: false, code: "spawn-failed", message: `无法启动常驻 shell：/system/bin/sh` })
        return
      }
      const startedAt = Date.now()
      const timer = setTimeout(() => {
        settle({ ok: false, code: "timeout", ms: Date.now() - startedAt })
      }, timeoutMs)
      pending = { nonce, timer, resolve, msFrom: startedAt }
      try {
        target.stdin.write(text)
      } catch (error) {
        settle({ ok: false, code: "write-failed", message: error.message })
      }
    })

  /** 就绪判据 = 首条哨兵回显（R2：不依赖任何 spawn 事件），带超时 */
  const ensureReady = () => {
    if (ready !== null) return ready
    ready = (async () => {
      const nonce = createNonce()
      const result = await send(`echo "${sentinelLine(nonce, 0)}"\n`, nonce, READY_TIMEOUT_MS)
      if (result.ok) return { ok: true }
      disposeChild()
      return {
        ok: false,
        code: result.code === "timeout" ? "not-ready" : result.code,
        message:
          result.code === "timeout"
            ? `常驻 shell 在 ${READY_TIMEOUT_MS} ms 内未回显就绪哨兵（已丢弃该进程）`
            : result.message ?? result.code,
      }
    })()
    return ready
  }

  /** 单次命令：串行化（并发工具调用不串输出，JT-39），每次调用清空本调用缓冲 */
  const runCommand = (command, timeoutMs, signal) => {
    const next = chain.then(async () => {
      // 排队期间就被中断：不必也不必去动常驻 shell（它此刻属于别的调用）
      if (signal && signal.aborted === true)
        return { ok: false, code: "killed", message: "调用在开始前已被中断", output: "" }
      // 只有走到这里才说明本调用是当前等待者：此时中断才可以丢弃常驻 shell
      const onAbort = () => disposeChild()
      if (signal && typeof signal.addEventListener === "function") signal.addEventListener("abort", onAbort, { once: true })
      const readiness = await ensureReady()
      if (!readiness.ok) return { ok: false, code: readiness.code, message: readiness.message, output: "" }
      const nonce = createNonce()
      let result
      try {
        result = await send(commandScript(command, nonce), nonce, timeoutMs)
      } finally {
        if (signal && typeof signal.removeEventListener === "function")
          signal.removeEventListener("abort", onAbort)
      }
      if (result.ok) return { ok: true, rc: result.rc, ms: result.ms, output, truncated: outputTruncated }
      const partial = { output, truncated: outputTruncated, ms: result.ms }
      // 超时/写失败后旧进程不可信：杀掉并让下一次调用惰性重启（FR-tool-008）
      if (result.code === "timeout" || result.code === "write-failed") disposeChild()
      const fallback =
        result.code === "killed"
          ? "常驻 shell 已被丢弃（调用被中断），下次调用会自动重启"
          : `命令在 ${timeoutMs} ms 内未结束（常驻 shell 已丢弃，下次调用自动重启）`
      return {
        ok: false,
        code: result.code,
        message: result.message ?? fallback,
        timeoutMs,
        ...partial,
      }
    })
    chain = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  return {
    defaultTimeout,
    execute: (command, timeoutMs, signal) => runCommand(command, timeoutMs ?? defaultTimeout, signal),
    /** abort/超时/插件卸载时释放常驻进程（FR-tool-005：cleanup 必须释放资源） */
    dispose: disposeChild,
  }
}

/** 唯一允许的 spawn 目标：设备自带 POSIX shell（/system/bin/sh） */
function defaultCreateChild(cwd) {
  return spawn("/system/bin/sh", [], {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, AGENT: "1", OPENCODE: "1", AI_AGENT: process.env.AI_AGENT || "opencode" },
  })
}

export const SHELL_INPUT = {
  type: "object",
  properties: {
    command: {
      type: "string",
      minLength: 1,
      description:
        "Shell command to run with the device's POSIX shell (/system/bin/sh) in the workspace directory.",
    },
    timeout: {
      type: "integer",
      minimum: 1,
      description: `Timeout in milliseconds before the command is aborted and the shell is restarted (default: ${DEFAULT_TIMEOUT_MS}).`,
    },
  },
  required: ["command"],
  additionalProperties: false,
}

const SHELL_DESCRIPTION = [
  "Execute a shell command with the device's POSIX shell (/system/bin/sh) in the workspace directory.",
  "stdout and stderr are merged; the exit code is always reported, and the whole output is capped at",
  `${MAX_OUTPUT_BYTES} bytes with an explicit truncation notice.`,
  `Commands run through one long-lived shell with a sentinel-delimited protocol, so a hung or blocked`,
  `command is aborted after \`timeout\` ms (default ${DEFAULT_TIMEOUT_MS} ms) and the shell is restarted.`,
  "This is a tool-level fence, not a sandbox: commands run with the app's own privileges and can be bypassed.",
].join(" ")

/** 输入校验（工具内兜底；JSON Schema 校验未生效时也不能崩，要回可读错误） */
export function shellArguments(input = {}) {
  if (typeof input.command !== "string" || input.command.trim().length === 0)
    return { ok: false, error: "Missing required argument `command`: expected a non-empty string." }
  const timeout = input.timeout
  if (timeout !== undefined && (!Number.isInteger(timeout) || timeout < 1))
    return { ok: false, error: "`timeout` must be a positive integer (milliseconds)." }
  return { ok: true, value: { command: input.command, timeout: timeout ?? DEFAULT_TIMEOUT_MS } }
}

/** 结果 → 模型可见文本：始终带退出码；截断/超时/失败都显式标注 */
export function formatShellContent(result) {
  const parts = []
  if (result.output) parts.push(result.output.replace(/\n+$/, ""))
  if (result.ok === false) parts.push(`Error: ${result.message}`)
  const notes = []
  if (result.ok === true) notes.push(`[exit code: ${result.rc}]`)
  if (result.truncated) notes.push(`[output truncated at ${MAX_OUTPUT_BYTES} bytes]`)
  if (result.ms !== undefined) notes.push(`[${result.ms} ms]`)
  if (notes.length > 0) parts.push(notes.join(" "))
  return parts.join("\n\n")
}

export function shellTool(resident) {
  return {
    name: "shell",
    description: SHELL_DESCRIPTION,
    input: SHELL_INPUT,
    options: { codemode: false },
    execute: async (input, context) => {
      const parsed = shellArguments(input)
      if (!parsed.ok) return errorResult(parsed.error)
      const signal = context && context.signal
      // 中断语义：把 AbortSignal 交给常驻 shell 自己处理 —— 它只在**本次调用真正成为当前等待者**
      // 时才丢弃常驻 shell。若在工具层无条件 dispose，会把排队中（还没轮到）的调用被中断这件事
      // 迁怒到正在等待同一串行链的另一次调用上。
      const result = await resident.execute(parsed.value.command, parsed.value.timeout, signal)
      return {
        content: formatShellContent(result),
        metadata: {
          exitCode: result.ok === true ? result.rc : undefined,
          durationMs: result.ms,
          truncated: result.truncated === true,
          timeout: result.ok === false && result.code === "timeout",
          ...(result.ok === true ? {} : { error: result.message }),
        },
      }
    },
  }
}

/**
 * 失败以**结果文本**返回，不抛异常：promise 执行器被包在 `Effect.promise` 里
 * （packages/plugin/src/promise/adapter.ts），抛出的错误会变成 defect 而非 `Tool.Error`，可能终结该步。
 */
function errorResult(message) {
  return { content: `Error: ${message}`, metadata: { error: true, message, timeout: false } }
}

export default {
  id: "oc-harmony-shell",
  async setup(context) {
    if (!context || !context.tool || typeof context.tool.transform !== "function")
      throw new Error("oc-harmony-shell: unexpected plugin context (missing context.tool.transform)")
    const root = context.location && context.location.directory ? context.location.directory : process.cwd()
    const resident = createResidentShell({ root })
    await context.tool.transform((editor) => {
      // 上游内置 id（插件 id 形态）与编辑器实际索引键（有效工具名 shell）都清一次
      editor.remove("opencode.tool.shell")
      editor.remove("shell")
      editor.add(shellTool(resident))
      // 上游 add 校验失败时只把原因推进 editor.errors（宿主仅记一条日志），而内置 shell 已被 remove，
      // 一旦新增失败模型将**彻底没有** shell 工具且没有任何失败信号。显式复查注册结果，缺失即抛错，
      // 让插件在 inventory 里变为 failed（fail-visible，FR-tool-019）。
      if (editor.get("shell") === undefined)
        throw new Error(
          "oc-harmony-shell: shell 工具注册失败（editor.get 取不到 shell）；" +
            "上游 editor.errors=" + JSON.stringify(editor.errors ?? null),
        )
    })
    // cleanup：宿主卸载插件时杀掉常驻 shell（FR-tool-005）
    return () => resident.dispose()
  },
}
