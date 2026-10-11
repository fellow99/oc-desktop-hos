# 渲染通道（001-render-channel）—— 规格

> **Module:** 001-render-channel ｜ **Status:** Proposed ｜ **Last Updated:** 2026-10-11 ｜ **上游基线:** opencode v2.0.26（Branch_v2.0.26）

## 1. 模块概述

### 1.1 目的（Why this module exists）

把 opencode v2 内嵌 Web UI（服务端同源托管的 SPA）显示到鸿蒙 PC 桌面窗口。本模块定义**两条渲染通道**：

- **R2（目标形态）**：ArkTS `Web` 组件（ArkWeb）加载 `http://<局域网IP>:<port>/`，Electron 只作 Node 宿主；
- **R1（回退形态）**：Electron `BrowserWindow`（Chromium 138）加载同一 URL。

模块职责是「选通道、给 URL、管 loading、把两通道的能力差异测清楚」：URL 构造与阶段化就绪判定归本模块，服务端与宿主只提供端口与就绪信号。

### 1.2 解决的问题（What pain points it addresses）

- **上架合规**：🔶 dsh 0.1.5 审核原文「应用渲染打开网页时，未使用 ArkWeb 组件，不符合应用市场审核标准」；纯 Chromium 通道不满足市场口径 → 必须有 R2 目标形态（工程规划 §2.5c N1、§3.3）。
- **长白屏**：首次启动需流式解压数十 MB 产物（见 003），直接加载真实 URL 会长时间白屏 → loading 页前置策略（工程规划 §5.1）。
- **失败不可见**：渲染失败若只表现为白屏，无法区分「产物 / 宿主 / 健康检查 / 加载 / CSP」哪一阶段出错 → 阶段化 fail-visible。
- **两通道能力未知**：ArkWeb 对本工程 UI 的 `localStorage`、SSE、Service Worker、`crypto.subtle`、明文 HTTP、CSP 支持均未在本工程验证（⚠️/⬜）→ 必须先出矩阵再定 v1 形态。
- **非安全上下文**：`http://<局域网IP>:<port>` 不满足浏览器安全上下文，`crypto.subtle` / Service Worker / 通知可能受限。

### 1.3 范围（Scope）

**包含**：

- 渲染通道抽象与选择（含调试开关）；
- R2 的 `Web` 组件 URL、必备配置、注入通道、skill 声明口径；
- R1 的窗口创建、URL、安全上下文开关、与请求钩子的接线约定；
- loading 页策略（本地内容 + 阶段文本 + 失败可见 + 首屏后关闭）；
- 目标 URL 构造（局域网 IPv4 优先、回退 `127.0.0.1`；端口来自宿主）；
- P0-2 渲染通道探针八项测项的规格化（测项、记录字段、出口判据、文档落点）。

**不包含**：

- 请求头与凭据注入（见 `004-request-hooks`）；
- 服务端启动、argv/env、健康检查（见 `008-server-ui-load`）；
- 宿主形态三候选定标（见 `007-runtime-host`）；
- 产物解压与 marker（见 `003-artifact-bootstrap`）；
- 启动时序编排与退出清理（见 `002-lifecycle`）；
- ArkTS 侧托盘 / 状态栏 / 菜单（后续模块）。

## 2. 用户故事

- 作为用户，我希望应用启动后界面最终显示出来，中途有明确的阶段提示，而不是长时间白屏。
- 作为用户，我希望界面功能与 opencode 标准 Web UI 完全一致（会话、流式响应、工具调用可视化、diff、主题、多语言）。
- 作为上架负责人，我希望 v1 渲染走 ArkWeb，避免因「未使用 ArkWeb 组件」被退审。
- 作为研发，我希望 R2 存在阻断项时能切回 R1 继续验证服务端链路，而不被渲染层阻塞。
- 作为研发，我希望渲染失败的阶段与原因在设备上直接可见（loading 页文本 + `[oc-desktop]` 日志），无需 root 或 faultlog。

## 3. 功能需求

### 3.1 通道抽象与选择

- FR-001-001 系统 MUST 提供统一的渲染通道抽象：`open(url)`、`setStage(stage)`、`hideLoading()`、`dispose()`；R2 与 R1 各为实现。
- FR-001-002 通道选择 MUST 由一个集中开关决定（构建期默认值 + 运行期调试覆盖），默认目标为 **R2**；R1 为回退（⬜ 默认值由 P0-2 结论定稿）。
- FR-001-003 系统 MUST NOT 在两个通道上同时渲染同一 UI（避免双连接与状态分叉）。
- FR-001-004 两通道 MUST 加载**同一 URL**，MUST NOT 对某一通道改写路径前缀或查询串。

### 3.2 R2（ArkWeb，目标形态）

- FR-001-005 R2 MUST 使用 ArkTS `Web` 组件，URL = `http://<局域网IP>:<port>/`（同源）。
- FR-001-006 R2 MUST 开启 `domStorageAccess(true)` 与 `databaseAccess(true)`；🔶 dsh PoC 实测：缺 `domStorageAccess` 时 `localStorage` 为 `null`，UI 首屏即 `TypeError: Cannot read properties of null (reading 'getItem')`。
- FR-001-007 R2 MUST NOT 注入 preload 桥、MUST NOT 使用自定义协议（上游 UI 按 `location.origin` 调 `/api/*`，同源即可）。
- FR-001-008 R2 的明文 HTTP 放行策略（`cleartextTraffic` 类配置）MUST 在 P0-2 第 ⑦ 项定论后才算落地；⬜ 待验证：配置项名称与生效范围。
- FR-001-009 R2 MAY 使用 `javaScriptOnDocumentStart` 作为注入通道（按需启用，不预设用途）。
- FR-001-010 R2 MUST NOT 在 `electron/src/main/module.json5` 声明 `entity.system.browsable` / `ohos.want.action.viewData` 等浏览器类 skill（🔶 上架整改口径），外链一律在 ArkWeb 内打开。
- FR-001-011 R2 MUST 承载 `/api/event`（SSE）长连接；通道侧 MUST NOT 缓存或缓冲事件流，断线重连由 UI 自身负责。

### 3.3 R1（Chromium，回退形态）

- FR-001-012 R1 MUST 使用 Electron `BrowserWindow` + `loadURL(<同一 URL>)`。
- FR-001-013 R1 MUST 通过 `app.commandLine.appendSwitch("unsafely-treat-insecure-origin-as-secure", "http://<host>:<port>")` 把明文来源提升为可信来源；⬜ 待验证：该开关对 `crypto.subtle` / Service Worker 的实际生效项（P0-2 第 ⑥ 项记录）。
- FR-001-014 R1 MUST 走 `004-request-hooks` 的凭据注入与 `Host`/`Origin` 改写。
- FR-001-015 R1 MUST 保证生产构建不带 `--inspect` 与 remote-debugging 开关（debug 构建按构建参数另行门控）。

### 3.4 loading 页与 URL

- FR-001-016 系统 MUST 先显示 loading 页（本地内容），再加载真实 URL；loading 页 MUST 展示当前阶段，阶段集合至少为 `env`、`artifact`、`host`、`health`、`load`。
- FR-001-017 任一阶段失败时 loading 页 MUST 显示「失败阶段 + 原因摘要」（fail-visible），MUST NOT 静默降级为空白页；允许提供重试/退出操作。
- FR-001-018 真实 URL MUST 由「宿主实际端口 + 可达地址」构造：局域网非 internal IPv4 优先，回退 `127.0.0.1`；端口 MUST NOT 硬编码。
- FR-001-019 首屏就绪信号（R2 `onPageEnd` / R1 `did-finish-load`）到达后 MUST 关闭 loading；就绪判定 MUST 有超时上限，超时按失败处理（⬜ 超时门限随 `002-lifecycle` 统一）。
- FR-001-020 渲染异常 MUST 写入 `globalThis.__renderError`（摘要截断 ≤ 2500 字符），供 `002-lifecycle` 展示与日志采集。

### 3.5 P0-2 渲染通道探针（八项）

- FR-001-021 系统 MUST 提供可复现的八项探针，对 **R2 与 R1 各测一次**，产出「通道 × 项」可用性矩阵：① SPA 首屏；② `localStorage` 与 IndexedDB；③ `fetch('/api/info')`（带凭据）；④ `/api/event` SSE 长连接（首个事件 `server.connected`）；⑤ Service Worker 注册（UI 含 blob worker）；⑥ `crypto.subtle`；⑦ 明文 HTTP 策略；⑧ CSP（内联主题脚本 sha256 与 `worker-src blob:`）。
- FR-001-022 每项 MUST 记录：结论（通过 / 失败）、失败原文（错误名 + 首行）、证据（loading 页文本或 `hilog` 关键字 `oc-desktop`）、设备与运行时版本。
- FR-001-023 探针结论 MUST 写入 `docs/真机验证记录.md` 与 `specs/001-render-channel/`，并回写工程规划 §3.3/§5.4 的 ⬜ 项（是否保留 `0.0.0.0` + 头改写）。
- FR-001-024 探针 MUST NOT 依赖 root / faultlog；观测点 MUST 为应用域（🔶 应用域与 shell 域的可见性不同，shell 侧结论不可直接采信）。
- FR-001-025 若 R2 全绿则 v1 MUST 以 R2 为默认、R1 降为对照基线；若 R2 存在阻断项，v1 MUST 以 R1 交付，并把阻断项登记到 `docs/鸿蒙环境能力清单.md`，不得静默降级。

## 4. 关键实体

| 实体 | 说明 | 关键属性 |
|------|------|----------|
| 渲染通道（RenderChannel） | 两实现的共同契约 | `kind`(`R2`/`R1`)、`url`、`open(url)`、`setStage(stage)`、`hideLoading()`、`dispose()` |
| 阶段（LoadingStage） | loading 页阶段模型 | `id`(`env`/`artifact`/`host`/`health`/`load`)、`text`、`state`(`running`/`ok`/`failed`)、`detail` |
| 目标同源地址（TargetOrigin） | 被加载的 URL 组成 | `host`（局域网 IPv4 或 `127.0.0.1`）、`port`（宿主实际端口）、`scheme`(`http`) |
| 探针记录（ProbeRecord） | P0-2 单项结果 | `channel`、`index`(1..8)、`title`、`result`(`pass`/`fail`)、`errorText`、`evidence`、`device` |
| 通道错误（RenderError） | 渲染失败摘要 | `stage`、`message`、`at`（时间戳） |

## 5. 验收场景

### 场景 1：R2 首屏成功

- Given 产物已就位（003）、宿主已就绪（007/008）、`GET /api/info` 返回 200
- When 打开 R2 通道并加载 `http://<局域网IP>:<port>/`
- Then loading 页可见 → 阶段推进到 `load` → SPA 首屏可见 → loading 关闭；`localStorage` 非 `null`；页面内 `fetch('/api/info')` 返回 200

### 场景 2：R2 缺 `domStorageAccess`（负例，必须被暴露）

- Given R2 未开启 `domStorageAccess(true)`
- When UI 首屏读写本地存储
- Then 探针第 ② 项记为 `fail` 并记录错误原文；MUST NOT 仅表现为无提示白屏

### 场景 3：R1 回退可用

- Given R2 存在阻断项且调试开关指向 R1
- When 打开 R1 通道
- Then `BrowserWindow` 加载同 URL 成功、`crypto.subtle` 可用、请求头与凭据钩子生效（004）

### 场景 4：产物未就位时 fail-visible

- Given 解压失败（003 报 `globalThis.__extractError`）
- When 渲染层启动
- Then loading 页停在 `artifact` 阶段并显示原因；MUST NOT 出现无提示白屏

### 场景 5：SSE 与 CSP

- Given UI 已加载
- When UI 订阅 `/api/event`
- Then 收到首个事件 `server.connected`；CSP 未被任何一层改写，`worker-src blob:` 场景可用（⬜ R2 结论待探针）

### 场景 6：探针矩阵齐备

- Given Phase 0 的 P0-2 执行完毕
- When 查阅文档
- Then `docs/真机验证记录.md` 含 R2/R1 各八项结论与证据；工程规划 §3.3/§5.4 对应 ⬜ 项已回写

## 6. 非功能需求

- **性能**：loading 页 MUST 在窗口创建后立即显示（不等产物与宿主）；各阶段耗时与首屏耗时 MUST 可度量并记录（⬜ 实测值待采集）。
- **可靠性**：单通道失败 MUST 可切另一通道（调试开关、需重建窗口，不要求热切换）。
- **可维护性**：两通道共享同一 URL / 阶段 / 错误摘要契约，差异集中在少数配置项（存储开关、安全上下文、CSP 与明文 HTTP 探针）。
- **安全性**：MUST NOT 放宽服务端下发的 CSP；MUST NOT 引入 preload 桥或 `nodeIntegration`；明文 HTTP 仅在「随机端口 + 密码（004）+ 局域网地址」组合下使用。
- **幂等性**：重复设置阶段文本、重复 `dispose()`、重复 `hideLoading()` MUST 无副作用。

## 7. 假设与约束

- 假设：✅ 上游 UI 按 `location.origin` 解析服务端地址（`packages/app/src/runtime/platform/web.ts`）→ 同源加载不需要 preload 桥、不需要 CORS、不需要打包前端工程。
- 假设：🔶 ArkWeb 能承载同类 Web UI（dsh PoC 已承载其自身 Web UI）；本工程 UI 为 opencode v2 SPA，⬜ 待验证。
- 约束：loopback 隔离（🔶）→ 服务端必须 `0.0.0.0` + 渲染层用局域网地址；R2 是否因此仍需要头改写 ⬜ 待 P0-2 判定。
- 约束：服务端 CSP 含 `worker-src blob:` 与内联主题脚本哈希（✅ `packages/cli/src/services/web-ui.ts`）→ R2 若拦截必须登记 `⚠️冲突` 而非改 CSP。
- ⬜ 待验证：ArkWeb 的明文 HTTP 放行配置形式与生效范围（P0-2 第 ⑦ 项）。
- ⬜ 待验证：ArkWeb 对 SSE 长连接与 Service Worker（含 blob worker）的支持（P0-2 第 ④⑤ 项）。
- ⬜ 待验证：`unsafely-treat-insecure-origin-as-secure` 在本运行时是否真正提升 `crypto.subtle` / SW（P0-2 第 ⑥ 项）。
- ⬜ 待验证：R2 通道是否需要以及如何注入请求头（与 004 的 R2 分支联动）。

## 8. 依赖

**上游（被本模块消费）**：

- `packages/cli/src/services/web-ui.ts`（CSP 与同源托管语义）、`packages/app`（`location.origin` 解析）—— 决定「同源加载即可」这一前提。

**本工程（被本模块消费）**：

- `003-artifact-bootstrap`：产物就位（loading 阶段 `artifact` 的判据）。
- `007-runtime-host`：宿主句柄提供实际端口与 URL。
- `008-server-ui-load`：`GET /api/info` 健康判据与内嵌 UI 可达性。

**下游（消费本模块）**：

- `002-lifecycle`：启动时序中的 `load` 阶段、阶段文本、超时与 `__renderError`。
- `004-request-hooks`：R1 的凭据与头改写接线；R2 分支的「是否需要」由本模块探针结论驱动。
- 后续托盘 / 菜单 / 外链模块：统一走 ArkWeb 内打开的外链口径。
