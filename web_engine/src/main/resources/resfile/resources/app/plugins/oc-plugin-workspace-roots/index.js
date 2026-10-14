/**
 * oc-plugin-workspace-roots —— 「选择工作区目录」对话框的壳侧能力面（规格 specs/203-plugin-workspace-picker）。
 *
 * 为什么必须是插件而不是补丁：渲染层是 ArkWeb/Chromium 同源加载的网页，**没有 Node**，因此
 *   - 看不到真实家目录（`HOME` 已被宿主改写为沙箱 `userData`）；
 *   - 触达不到 ArkTS（目录权限申请 / 应用信息页深链只在主进程可达）。
 * 而插件运行在**服务端进程**（默认 `OCR_HOST_MODE=inprocess` ⇒ 与 Electron 主进程同进程），
 * 上述两件事天然成立。故本插件经 `context.rpc.register` 暴露 5 个方法，UI 侧只做展示与交互。
 *
 * 数据面边界（specs/203 plan §4.1）：本 RPC 只承载**壳侧原生能力**（四个主目录路径、主目录内建目录、
 * 目录权限结果、应用信息页深链），**不承载会话/项目数据** —— 目录枚举仍走上游既有 `fs/list`。
 *
 * 传输：`POST /api/rpc/oc-harmony-workspace-roots/<method>`，载荷 `{ input }`，返回 `{ output }`。
 * 该端点是上游既有协议（`packages/protocol/src/groups/rpc.ts`），**无需任何 codegen**。
 *
 * 结果约定：所有方法都**不抛错**（避免 error union 与输出校验的耦合），统一返回
 * `{ ok, code, message, ... }` 形态的结构化结果；`code` 是稳定字符串，UI 据此给出可归因提示。
 * 唯一例外是输入本身非法（上游 RPC 层会以 `rpc.invalid_input` 拒绝），故输入 schema 保持宽松，
 * 具体校验在 handler 内做（见 `validateSegmentName` 与根包含性检查）。
 *
 * 准入（plugins/README.md §5）：不依赖 PTY、不 spawn、不依赖原生模块；只用 node 内建与
 * `electron`（经 `createRequire` 取 `systemPreferences` 权限桥）。
 */
import { createRequire } from "node:module"
import fs from "node:fs"
import path from "node:path"

/** 插件 id（同时是 RPC id 前缀与 profile/诊断里的名字） */
export const PLUGIN_ID = "oc-harmony-workspace-roots"

/** 四个主目录，顺序即 UI Tab 顺序（沙箱在前） */
export const ROOT_IDS = ["sandbox", "desktop", "documents", "download"]

/** 需要 OS 授权的主目录 → ArkTS `PermissionManagerAdapter` 的权限类型（沙箱免授权） */
const PERMISSION_TYPES = {
  desktop: "directory_desktop",
  documents: "directory_document",
  download: "directory_download",
}

/** 沙箱主目录相对 `app.getPath('userData')` 的子目录名（与 src-main/main.js `ensureWorkspace()` 同值） */
const SANDBOX_DIR_NAME = "workspace"

/** 宿主注入的三个用户主目录绝对路径（src-main/main.js `resolveUserRoots()`） */
const USER_ROOTS_ENV = "OCR_USER_ROOTS"

/** 日志前缀（与宿主一致，便于真机 hilog/trace 取证） */
const LOG_PREFIX = "[oc-desktop]"

/** ArkTS 侧已 JSBind 的原生能力（web_engine/src/main/ets/jsbindings/*） */
const BRIDGE = {
  check: "PermissionManagerAdapter.CheckPermissions",
  request: "PermissionManagerAdapter.RequestPermissionCode",
  appInfo: "ElectronApp.OpenApplicationInfoEntry",
}

/** 仅本插件使用：CJS 入口，用于解析 Electron 内建模块（ESM 下没有 `require`） */
const nodeRequire = createRequire(import.meta.url)

// ------------------------------------------------------------------ 契约定义

/** 宽松对象：输入校验在 handler 内做，避免上游输入解析把合法调用挡在门外 */
const ANY_OBJECT = { type: "object", additionalProperties: true }

/** 一个主目录的解析结果；不可用时 `path` 为 `""` 且 `reason` 给出人类可读原因（不使用 null 联合，降低 schema 风险） */
const ROOT_INFO_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: { type: "string" },
    path: { type: "string" },
    available: { type: "boolean" },
    reason: { type: "string" },
  },
  required: ["id", "path", "available", "reason"],
}

function resultSchema(properties) {
  return {
    type: "object",
    additionalProperties: false,
    properties,
    required: Object.keys(properties),
  }
}

/**
 * RPC 定义（`Rpc.PortableDefinition`）。
 * 上游按 JSON Schema 解析输入并编码输出（`packages/core/src/rpc.ts` 的 `parse`/`encode`），
 * 因此输出 schema **逐个属性声明且全部 required**，handler 返回同形对象，不做省略。
 */
const definition = {
  id: PLUGIN_ID,
  events: {},
  methods: {
    roots: {
      input: ANY_OBJECT,
      output: resultSchema({
        home: { type: "string" },
        roots: { type: "array", items: ROOT_INFO_SCHEMA },
      }),
    },
    mkdir: {
      input: ANY_OBJECT,
      output: resultSchema({
        ok: { type: "boolean" },
        code: { type: "string" },
        message: { type: "string" },
        path: { type: "string" },
      }),
    },
    permissionCheck: {
      input: ANY_OBJECT,
      output: resultSchema({
        granted: { type: "boolean" },
        source: { type: "string" },
        message: { type: "string" },
      }),
    },
    permissionRequest: {
      input: ANY_OBJECT,
      output: resultSchema({
        code: { type: "number" },
        bridgeUnavailable: { type: "boolean" },
        message: { type: "string" },
      }),
    },
    openAppInfo: {
      input: ANY_OBJECT,
      output: resultSchema({
        ok: { type: "boolean" },
        message: { type: "string" },
      }),
    },
  },
}

// ------------------------------------------------------------------ 基础工具

/** 结构化结果：始终带齐 code / message，便于 UI 归类展示 */
function outcome(code, message) {
  return { ok: false, code, message: message || "" }
}

/**
 * 归一化路径：统一分隔符为 `/`、去尾部分隔符。**仅用于包含性判定**（不解析 symlink、不做大小写归一）。
 *
 * 统一分隔符是必要的：根路径由 `path.join` 生成（宿主 Windows 上带 `\`），而客户端目标路径来自上游
 * `canonicalPickerPath`（恒为 `/`）——只按单侧分隔符加边界比较会在混合分隔符下产生假阴性。
 */
function normalize(input) {
  const value = String(input || "").replace(/\\/g, "/")
  if (value.length <= 1) return value
  return value.replace(/\/+$/, "") || "/"
}

/**
 * `child` 是否位于 `root` 之内（含 `root` 自身）。
 * 大小写敏感；逐段比较以避免 `/a/bc` 被 `/a/b` 命中；含 `..` 的相对段一律拒绝
 * （字符串比较无法可靠判定 `..` 的归属，而 `load()` 侧的调用不会预先规范化）。
 */
function isWithin(root, child) {
  const base = normalize(root)
  const target = normalize(child)
  if (!base || !target) return false
  if (base.split("/").includes("..") || target.split("/").includes("..")) return false
  if (target === base) return true
  return target.startsWith(`${base}/`)
}

/** realpath 消解（失败即回落原路径：不能因无权限 stat 就放宽围栏之外的判定） */
function realPathOf(input) {
  try {
    return fs.realpathSync(input)
  } catch {
    return input
  }
}

/** 目录段名合法性（FR-203-014）：非空、单段、非 `.`/`..`、无控制字符、长度有界 */
function validateSegmentName(name) {
  const value = typeof name === "string" ? name : ""
  if (value.length === 0) return "名称不能为空"
  if (value === "." || value === "..") return "名称不能是 . 或 .."
  if (value.includes("/") || value.includes("\\")) return "名称不能包含路径分隔符"
  // 控制字符（含 NUL、换行）一律拒绝
  for (const char of value) {
    const code = char.codePointAt(0)
    if (code < 0x20 || code === 0x7f) return "名称不能包含控制字符"
  }
  if (Buffer.byteLength(value, "utf8") > 200) return "名称过长"
  return null
}

/** Electron 主进程面；宿主形态不支持时返回 undefined（由调用方给出可归因结果，不抛错） */
function electron() {
  try {
    const mod = nodeRequire("electron")
    if (mod && mod.app && typeof mod.app.getPath === "function") return mod
  } catch {
    return undefined
  }
  return undefined
}

/** 沙箱主目录：`<userData>/workspace`，不存在则创建（FR-203-003） */
function sandboxRoot(electronModule) {
  const userData = electronModule ? electronModule.app.getPath("userData") : process.env.HOME
  if (!userData) return { path: "", available: false, reason: "无法解析应用数据目录（userData）" }
  const target = path.join(userData, SANDBOX_DIR_NAME)
  try {
    fs.mkdirSync(target, { recursive: true })
  } catch (error) {
    return { path: target, available: false, reason: `沙箱目录创建失败：${error && error.message}` }
  }
  return { path: target, available: true, reason: "" }
}

/** 宿主注入的用户主目录（`{ desktop, documents, download }` → 绝对路径或 null） */
function userRootsFromEnv() {
  const raw = process.env[USER_ROOTS_ENV]
  if (typeof raw !== "string" || raw.length === 0) return undefined
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === "object" ? parsed : undefined
  } catch {
    return undefined
  }
}

/** 逐项校验「存在且是目录」（FR-203-005）；不满足者标记不可用并给出原因，**不静默换根** */
function userRoot(id, configured) {
  if (typeof configured !== "string" || configured.length === 0) {
    return { path: "", available: false, reason: `宿主未提供该主目录路径（${USER_ROOTS_ENV} 缺失或未解析）` }
  }
  try {
    if (!fs.statSync(configured).isDirectory()) {
      return { path: configured, available: false, reason: "路径存在但不是目录" }
    }
  } catch (error) {
    return { path: configured, available: false, reason: `路径不可访问：${error && error.code}` }
  }
  return { path: configured, available: true, reason: "" }
}

/** 解析四个主目录（FR-203-002/003/004/005），并落 `[oc-desktop]` 日志（FR-203-006） */
function resolveRoots() {
  const electronModule = electron()
  const sandbox = sandboxRoot(electronModule)
  const configured = userRootsFromEnv()
  const home = configured && typeof configured.home === "string" ? configured.home : ""
  const roots = [
    { id: "sandbox", path: sandbox.path, available: sandbox.available, reason: sandbox.reason },
    ...["desktop", "documents", "download"].map((id) => {
      const info = userRoot(id, configured ? configured[id] : undefined)
      return { id, path: info.path, available: info.available, reason: info.reason }
    }),
  ]
  for (const root of roots) {
    console.log(
      `${LOG_PREFIX} workspace-root ${new Date().toISOString()} ${root.id}=${root.available ? root.path : `<unavailable: ${root.reason}>`}`,
    )
  }
  return { home, roots }
}

/** 取某个 root id 的当前解析结果（`mkdir` 与权限动作共用） */
function rootById(id) {
  const resolved = resolveRoots()
  return resolved.roots.find((root) => root.id === id)
}

// ------------------------------------------------------------------ 原生能力桥

/**
 * 经 ArkTS 桥调用原生能力（主进程可达）。
 * 回调风格的绑定必须用 async 形式（sync 形式返回空信封，不可用）。
 */
async function callArkTS(electronModule, name, returnType, args) {
  const systemPreferences = electronModule && electronModule.systemPreferences
  if (!systemPreferences || typeof systemPreferences.callArkTSAsyncFunction !== "function") return undefined
  try {
    const envelope = await systemPreferences.callArkTSAsyncFunction(name, returnType, args)
    if (envelope === null || typeof envelope !== "object" || !("value" in envelope)) {
      // 回调回调返回的信封形状非预期：必须留痕，否则会被误归因成「桥不可用」（FR-203-024）
      console.log(`${LOG_PREFIX} workspace-root bridge ${name} unexpected envelope: ${JSON.stringify(envelope)}`)
      return undefined
    }
    return envelope.value
  } catch (error) {
    console.log(`${LOG_PREFIX} workspace-root bridge ${name} failed: ${error && error.message}`)
    return undefined
  }
}

// ------------------------------------------------------------------ handlers

/** 四个主目录解析（FR-203-003/004/005/006） */
function handleRoots() {
  return resolveRoots()
}

/** 在当前主目录内新建一个目录（FR-203-012…017）：段名校验 → 根包含性 → 判重 → mkdir */
function handleMkdir(input) {
  const id = input && typeof input.id === "string" ? input.id : ""
  const parent = input && typeof input.parent === "string" ? input.parent : ""
  const name = input && typeof input.name === "string" ? input.name : ""

  if (!ROOT_IDS.includes(id)) return { ...outcome("root-unknown", `未知主目录：${id || "<empty>"}`), path: "" }

  const invalid = validateSegmentName(name)
  if (invalid) return { ...outcome("invalid-name", invalid), path: "" }

  const root = rootById(id)
  if (!root || !root.available) {
    return { ...outcome("root-unavailable", root ? root.reason : "主目录不可用"), path: "" }
  }
  if (!parent || !path.isAbsolute(parent)) {
    return { ...outcome("invalid-parent", "父目录必须是绝对路径"), path: "" }
  }
  // 根围栏（FR-203-015）：服务端独立判定，不以 UI 判定为依据。
  // 先经 realpath 消解 symlink 再判定，避免「链接目录」把创建动作带出主目录
  // （应用域不能创建 symlink，但主目录内可能已存在链接；消解失败时回落原路径，判定不变宽）。
  const realRoot = realPathOf(root.path)
  const realParent = realPathOf(parent)
  if (!isWithin(realRoot, realParent)) {
    return { ...outcome("out-of-root", `父目录超出主目录范围：${parent}`), path: "" }
  }

  const target = path.join(realParent, name)
  if (!isWithin(realRoot, target)) {
    return { ...outcome("out-of-root", "目标目录超出主目录范围"), path: "" }
  }
  if (fs.existsSync(target)) return { ...outcome("exists", `已存在同名条目：${name}`), path: "" }

  try {
    // 非 recursive：父目录必须已存在，避免「一次调用顺带造出多级未知目录」
    fs.mkdirSync(target)
  } catch (error) {
    return { ...outcome("create-failed", `创建失败：${error && error.code}`), path: "" }
  }
  console.log(`${LOG_PREFIX} workspace-root mkdir ${target}`)
  return { ok: true, code: "", message: "", path: target }
}

/** 权限预检（FR-203-021）。沙箱免授权；桥不可用时 `source:"unavailable"` 且 `granted:false` */
async function handlePermissionCheck(input) {
  const id = input && typeof input.id === "string" ? input.id : ""
  if (id === "sandbox") return { granted: true, source: "sandbox", message: "" }
  const type = PERMISSION_TYPES[id]
  if (!type) return { granted: false, source: "unavailable", message: `未知主目录：${id || "<empty>"}` }
  const electronModule = electron()
  const value = await callArkTS(electronModule, BRIDGE.check, "boolean", [type])
  if (value === undefined) {
    return { granted: false, source: "unavailable", message: "权限检查桥不可用（权限只能在系统设置中调整）" }
  }
  return { granted: value === true, source: "bridge", message: "" }
}

/** 主动申请目录权限（FR-203-021）。回调 `0` = 已授权；**是否真的生效以一次全新列举为准**（FR-203-022） */
async function handlePermissionRequest(input) {
  const id = input && typeof input.id === "string" ? input.id : ""
  if (id === "sandbox") return { code: 0, bridgeUnavailable: false, message: "" }
  const type = PERMISSION_TYPES[id]
  if (!type) return { code: -1, bridgeUnavailable: false, message: `未知主目录：${id || "<empty>"}` }
  const electronModule = electron()
  const value = await callArkTS(electronModule, BRIDGE.request, "number", [type])
  if (value === undefined) {
    return { code: -1, bridgeUnavailable: true, message: "权限申请桥不可用（请在系统设置中开启）" }
  }
  const code = Number(value)
  return {
    code: Number.isFinite(code) ? code : -1,
    bridgeUnavailable: false,
    message: code === 0 ? "" : `系统未授予权限（回调码 ${code}）`,
  }
}

/** 「去系统设置」：深链到本应用信息页的「文件和文件夹」权限（FR-203-023） */
async function handleOpenAppInfo() {
  const electronModule = electron()
  const systemPreferences = electronModule && electronModule.systemPreferences
  if (!systemPreferences || typeof systemPreferences.callArkTSAsyncFunction !== "function") {
    return { ok: false, message: "应用信息页桥不可用（electron / systemPreferences 不可达）" }
  }
  try {
    await systemPreferences.callArkTSAsyncFunction(BRIDGE.appInfo, "void", [])
    // ArkTS 侧 `startAbility` 未 await（见 ElectronAppAdapter），此处只能证明「已发起」，
    // 不能证明系统设置页真的起来了 —— 故留痕供真机核对，UI 也在 ok:false 时就地提示。
    console.log(`${LOG_PREFIX} workspace-root openAppInfo dispatched`)
    return { ok: true, message: "" }
  } catch (error) {
    return { ok: false, message: `打开应用信息页失败：${error && error.message}` }
  }
}

// ------------------------------------------------------------------ 插件入口

/**
 * 上游插件契约：默认导出 `{ id, setup }`；`setup` 的返回值是清理函数。
 * 缺失 `context.rpc.register` 时**抛错**（fail-visible：插件在 inventory 里变 failed，
 * 而不是静默什么都不注册，导致 UI 以为是「非本壳部署」而回退）。
 */
export default {
  id: PLUGIN_ID,
  async setup(context) {
    if (!context || !context.rpc || typeof context.rpc.register !== "function")
      throw new Error(`${PLUGIN_ID}: unexpected plugin context (missing context.rpc.register)`)

    const registration = await context.rpc.register(definition, {
      // ⚠️ 全部 handler 必须是 async（返回 Promise）：上游 `PluginPromise.fromPromise` 的 promise 风味
      // 会对**返回值直接调用 `.then()`**，同步返回值会以
      // `TypeError: internalCall(...).then is not a function` 变成 `rpc.internal`（真机 500 实测）。
      roots: async () => handleRoots(),
      mkdir: async (input) => handleMkdir(input),
      permissionCheck: async (input) => handlePermissionCheck(input),
      permissionRequest: async (input) => handlePermissionRequest(input),
      openAppInfo: async () => handleOpenAppInfo(),
    })

    console.log(`${LOG_PREFIX} plugin ${PLUGIN_ID} registered (${Object.keys(definition.methods).join(", ")})`)

    return () => {
      Promise.resolve(registration && registration.dispose && registration.dispose()).catch(() => {})
    }
  },
}
