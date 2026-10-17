/**
 * oc-plugin-git —— 在没有 git 的设备上提供 git 能力（规格 specs/204-plugin-git）。
 *
 * 三件事：
 *   1. 21 个 `git_*` 工具（一动词一工具，仓库根 chroot 围栏）
 *   2. VCS provider 覆盖（`id: "git"`），让应用自带的 diff / 分支 / 状态界面重新工作
 *   3. 凭据 RPC（`oc-harmony-git`），供「设置 → Git」页读写 `~/.git-credentials`
 *
 * 刻意不做的事：
 *   - **不在模块顶层 import 第三方包**：构建期 `collect-app.mjs` 的导入式工具元数据检查会跑
 *     `setup()`，而那时依赖可能还没物化；第三方模块一律在首次使用时懒加载（见 `lib/runtime.js`）。
 *   - **不 spawn 任何进程、不引用原生模块**：符合 `plugins/README.md` §5 的准入条件。
 */
import { createFence } from "./lib/fence.js"
import { createAuth } from "./lib/auth.js"
import {
  describeCredentialsFile,
  gitCredentialsPath,
  readCredentials,
  removeCredential,
  saveCredential,
} from "./lib/credentials.js"
import { buildTools, TOOL_NAMES } from "./lib/tools/index.js"
import { createVcsProvider } from "./lib/vcs.js"

export const PLUGIN_ID = "oc-harmony-git"
export const RPC_ID = "oc-harmony-git"
const LOG_PREFIX = "[oc-desktop]"

export { TOOL_NAMES }

// ------------------------------------------------------------------ RPC 契约

const RESULT = (properties) => ({
  type: "object",
  additionalProperties: false,
  properties,
  required: Object.keys(properties),
})

const ENTRY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    protocol: { type: "string" },
    host: { type: "string" },
    username: { type: "string" },
    passwordLength: { type: "integer" },
    hasPath: { type: "boolean" },
  },
  required: ["protocol", "host", "username", "passwordLength", "hasPath"],
}

const definition = {
  id: RPC_ID,
  events: {},
  methods: {
    "credentials.describe": {
      input: { type: "object", additionalProperties: true },
      output: RESULT({
        path: { type: "string" },
        exists: { type: "boolean" },
        mode: { type: "string" },
        count: { type: "integer" },
        message: { type: "string" },
      }),
    },
    "credentials.list": {
      input: { type: "object", additionalProperties: true },
      output: RESULT({
        path: { type: "string" },
        entries: { type: "array", items: ENTRY_SCHEMA },
      }),
    },
    "credentials.save": {
      input: { type: "object", additionalProperties: true },
      output: RESULT({
        ok: { type: "boolean" },
        code: { type: "string" },
        message: { type: "string" },
        path: { type: "string" },
      }),
    },
    "credentials.remove": {
      input: { type: "object", additionalProperties: true },
      output: RESULT({
        ok: { type: "boolean" },
        code: { type: "string" },
        message: { type: "string" },
      }),
    },
  },
}

/** 主机名/协议白名单校验（避免把任意字符串拼进凭据文件） */
function normalizeHost(host) {
  if (typeof host !== "string") return ""
  const trimmed = host.trim()
  if (trimmed.length === 0) return ""
  if (/\s/u.test(trimmed)) return ""
  if (!/^[A-Za-z0-9.\-:[\]]+$/u.test(trimmed)) return ""
  return trimmed.toLowerCase()
}

function normalizeProtocol(protocol) {
  const value = typeof protocol === "string" && protocol.length > 0 ? protocol.toLowerCase() : "https"
  return value === "http" || value === "https" ? value : ""
}

function handleDescribe(file) {
  const info = describeCredentialsFile(file)
  return { ...info }
}

function handleList(file) {
  const entries = readCredentials(file).map((entry) => ({
    protocol: entry.protocol,
    host: entry.host,
    username: entry.username,
    passwordLength: entry.password.length,
    hasPath: entry.path.length > 0,
  }))
  return { path: file, entries }
}

function handleSave(file, input) {
  const protocol = normalizeProtocol(input?.protocol)
  const host = normalizeHost(input?.host)
  const username = typeof input?.username === "string" ? input.username.trim() : ""
  const password = typeof input?.password === "string" ? input.password : ""
  if (!protocol) return { ok: false, code: "invalid-protocol", message: "protocol must be http or https", path: file }
  if (!host) return { ok: false, code: "invalid-host", message: "host is required (host or host:port)", path: file }
  if (username.length === 0) return { ok: false, code: "invalid-username", message: "username is required", path: file }
  if (password.length === 0) return { ok: false, code: "invalid-password", message: "password is required", path: file }
  try {
    saveCredential({ protocol, host, username, password }, file)
    return { ok: true, code: "ok", message: "saved", path: file }
  } catch (error) {
    return { ok: false, code: "write-failed", message: String(error?.message ?? error), path: file }
  }
}

function handleRemove(file, input) {
  const protocol = normalizeProtocol(input?.protocol)
  const host = normalizeHost(input?.host)
  const username = typeof input?.username === "string" ? input.username.trim() : undefined
  if (!protocol) return { ok: false, code: "invalid-protocol", message: "protocol must be http or https" }
  if (!host) return { ok: false, code: "invalid-host", message: "host is required" }
  try {
    const result = removeCredential({ protocol, host, username }, file)
    if (result.removed === 0) return { ok: false, code: "not-found", message: "no matching credential" }
    return { ok: true, code: "ok", message: `removed ${result.removed}` }
  } catch (error) {
    return { ok: false, code: "write-failed", message: String(error?.message ?? error) }
  }
}

// ------------------------------------------------------------------ 装配

export default {
  id: PLUGIN_ID,
  async setup(context) {
    const location = context?.location ?? {}
    const root = location.project?.directory ?? location.directory
    const cwd = location.directory ?? root
    const log = (message) => console.log(`${LOG_PREFIX} ${message}`)
    const credentialsFile = gitCredentialsPath()

    const fence = createFence({ root, cwd })
    const auth = createAuth({ file: credentialsFile, log: (message) => log(`auth: ${message}`) })
    const workspace = { fence, auth, log, credentialsFile }

    // 1) 工具：失败必须可见（插件在 GET /api/plugin 里变 failed，而不是静默少工具）
    if (!context?.tool || typeof context.tool.transform !== "function") {
      throw new Error(`${PLUGIN_ID}: unexpected plugin context (missing context.tool.transform)`)
    }
    const tools = buildTools(workspace)
    await context.tool.transform((editor) => {
      for (const tool of tools) editor.add(tool)
      const missing = TOOL_NAMES.filter((name) => editor.get(name) === undefined)
      if (missing.length > 0) {
        throw new Error(
          `${PLUGIN_ID}: tool registration failed (missing ${missing.join(", ")}); editor.errors=${JSON.stringify(editor.errors ?? null)}`,
        )
      }
    })

    // 2) VCS provider：失败不连带工具（只记日志）
    let vcsRegistered = false
    if (context?.vcs && typeof context.vcs.transform === "function") {
      try {
        await context.vcs.transform((editor) => {
          editor.add(createVcsProvider(workspace))
        })
        vcsRegistered = true
      } catch (error) {
        log(`plugin ${PLUGIN_ID}: vcs provider registration failed: ${error?.message ?? String(error)}`)
      }
    } else {
      log(`plugin ${PLUGIN_ID}: context.vcs.transform is unavailable; only tools are delivered`)
    }

    // 3) 凭据 RPC：失败同样只记日志（设置页会因 describe 失败而自行隐藏）
    let registration
    if (context?.rpc && typeof context.rpc.register === "function") {
      try {
        registration = await context.rpc.register(definition, {
          // 上游 promise 风味会对返回值直接 `.then()`：handler 必须 async
          "credentials.describe": async () => handleDescribe(credentialsFile),
          "credentials.list": async () => handleList(credentialsFile),
          "credentials.save": async (input) => handleSave(credentialsFile, input),
          "credentials.remove": async (input) => handleRemove(credentialsFile, input),
        })
      } catch (error) {
        log(`plugin ${PLUGIN_ID}: credentials rpc registration failed: ${error?.message ?? String(error)}`)
      }
    }

    log(
      `plugin ${PLUGIN_ID}: tools=${tools.length} vcsProvider=${vcsRegistered ? "git(override)" : "none"} ` +
        `credentials=${credentialsFile} root=${fence.root}`,
    )

    return () => {
      Promise.resolve(registration && registration.dispose ? registration.dispose() : undefined).catch(() => {})
    }
  },
}
