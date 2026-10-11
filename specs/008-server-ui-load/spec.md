# 服务端与 UI 加载（008-server-ui-load）—— 规格

> **Module:** 008-server-ui-load ｜ **Status:** Proposed ｜ **Last Updated:** 2026-10-11 ｜ **上游基线:** opencode v2.0.26（Branch_v2.0.26）

## 1. 模块概述

### 1.1 目的（Why this module exists）

在 007 定标的宿主内，以 **stock CLI bundle 语义**启动 opencode v2 服务端，并让渲染层加载其**同源内嵌 UI**：

- 启动契约：`process.argv = ["node", "opencode.mjs", "serve", "--hostname", "0.0.0.0", "--port", "<随机>"]`，密码走 `OPENCODE_PASSWORD`，等价于在设备内执行 `opencode serve`；
- 就绪判据：`GET /api/info`（带凭据）返回 200，超时上限 30s；
- 内嵌 UI：服务端把 SPA 与 `/api/*` **同源托管**（UI 资产以 brotli 归档 `app-archive.bin` 内嵌），所以本工程**零前端工程、零自定义协议、零 preload 桥、零 CORS 配置**；
- 离线与降级：用 env 关闭 models 快照拉取、文件监听、`fff` 索引。

### 1.2 解决的问题（What pain points it addresses）

- **v2 结构性重定位**（✅ 源码核实）：包结构拆为 `packages/{core,server,cli,protocol,schema,app,desktop,util,…}`；服务端入口为 `ServerProcess.run/start`；命令行 `serve [--hostname|--port|--cors|--service|--stdio]`（**无 `--mdns`、无 `opencode web`**）；API 前缀为 `/api/*`（139 端点），服务信息合并为 `GET /api/info`；事件面 `/api/event`（SSE，首事件 `server.connected`）。
- **密码必填**：无 `OPENCODE_PASSWORD`/`OPENCODE_SERVER_PASSWORD` 会失败或进程内随机生成（UI 无从得知）→ 必须由壳注入（见 004）。
- **loopback 隔离**：🔶 渲染侧不能用 `127.0.0.1` → 必须 `--hostname 0.0.0.0` + 局域网地址。
- **端口冲突与白屏**：固定端口会与其它进程冲突，且失败常表现为白屏 → 随机端口 + 可回读 + 健康检查。
- **Node 版本错位**：v2 产物默认以 `target: "node26"` 构建，设备为 Node 22.17.0 → 依赖补丁 0001 与 host 侧门禁（005）。
- **离线环境**：设备可能无外网 → models 快照拉取、文件监听、`fff` 索引都必须能关（✅ 上游支持 env 开关）。
- **原生件加载会中断 bundle**：`#pty` 在模块顶层 `createRequire`，加载失败会中断整个 bundle 的 import → 必须靠补丁 0003 的 `ohos` 变体（005）。

### 1.3 范围（Scope）

**包含**：

- 启动契约：`argv` 与 `env` 的完整集合与单一来源分工（密码归 004、沙箱变量归 002）；
- 端口策略（随机高位端口 + 实际端口回读）与绑定地址；
- 健康检查（`GET /api/info`，带凭据，退避轮询，30s 超时）与就绪判据；
- 内嵌 UI 的同源加载契约（`/` → SPA，`/api/*` → API，未命中回落 `index.html`）与断言口径；
- 三项降级开关（models / watcher / fff）与 mDNS 禁用；
- 启动诊断信息（bundle 哈希、assets 目录、端口、耗时、Node 版本）；
- 逃生口（Phase 1 备选：新增 Vite 入口直接调用 `ServerProcess.start`）的触发条件与不预设原则。

**不包含**：

- 宿主形态与探针（见 `007-runtime-host`）；
- 渲染通道实现与八项探针（见 `001-render-channel`）；
- 密码生成与请求头钩子（见 `004-request-hooks`）；
- 阶段时序与退出清理（见 `002-lifecycle`）；
- 插件通道（`201-plugin-runtime`）与搜索兜底实现（Phase 2）。

## 2. 用户故事

- 作为用户，我希望应用启动后看到的是完整的 opencode Web UI（会话、流式响应、工具调用可视化、diff、主题、多语言），不需要额外安装任何东西。
- 作为用户，我希望在无外网时也能正常启动并使用已有能力（不因联网动作卡死）。
- 作为研发，我希望有一个明确的「服务端就绪」判据（`GET /api/info` 200），而不是靠猜。
- 作为研发，我希望能在 host 侧先验证服务端与 UI（摆脱真机往返）。
- 作为研发，我希望端口冲突、assets 缺失、原生件加载失败这类问题各自表现为具体错误，而不是统一的白屏。

## 3. 功能需求

### 3.1 启动契约

- FR-008-001 宿主 MUST 以 CLI 语义启动 bundle：先设 `process.argv = ["node", "opencode.mjs", "serve", "--hostname", "0.0.0.0", "--port", "<随机>"]`，再 `import(<userData>/opencode-dist/opencode.mjs)`；MUST NOT 使用 `opencode web`（v2 无该命令）。
- FR-008-002 绑定地址 MUST 为 `0.0.0.0`（🔶 loopback 隔离）；MUST NOT 把渲染层访问路径建立在 `127.0.0.1` 上。
- FR-008-003 端口 MUST 为随机高位端口，且宿主 MUST 能**回读实际端口**；⬜ 待验证：stock CLI `serve` 是否输出/暴露实际端口（若不可回读，退化为「宿主自选高位随机端口 + 启动前占用探测」）。
- FR-008-004 系统 MUST 经 `OPENCODE_PASSWORD` 注入密码（来源唯一为 004）；MUST NOT 依赖服务端进程内随机生成。
- FR-008-005 系统 MUST 设置 `OPENCODE_NODE_ASSETS_DIR` = `<userData>/opencode-dist/assets`（非 SEA 时产物前导从此读 `app-archive.bin`、原生件与 wasm）。
- FR-008-006 系统 MUST 设置三项降级开关：`OPENCODE_DISABLE_MODELS_FETCH=1`、`OPENCODE_FILEWATCHER_DISABLE=1`、`OPENCODE_DISABLE_FFF=1`；MAY 另设 `OPENCODE_MODELS_PATH` 指向随包快照。
- FR-008-007 系统 MUST NOT 启用 mDNS、MUST NOT 依赖局域网服务发现（v2 `serve` 已无 `--mdns`）。
- FR-008-008 系统 MUST 设置 `OPENCODE_CLIENT=desktop`（由 002 作为单一来源维护）；MAY 设 `OPENCODE_DB` 指向 `<userData>/data/opencode/opencode.db`。
- FR-008-009 启动参数与环境变量 MUST 由**单一装配函数**产出（见 007 的 `assembleHostEnv`），MUST NOT 在多个模块重复拼接。

### 3.2 健康检查与就绪

- FR-008-010 系统 MUST 以 `GET /api/info`（带 Basic 凭据）返回 200 作为「服务端就绪」判据；超时上限 30s 且可配置。
- FR-008-011 健康检查 MUST 使用指数退避轮询（200ms 起步、1s 上限），并记录尝试次数与最后一次错误。
- FR-008-012 健康检查失败 MUST fail-visible（写 `__hostError` 并驱动 `health` 阶段失败），MUST NOT 无限静默重试。
- FR-008-013 就绪后系统 MUST 记录启动诊断：bundle 路径与 SHA-256（前 8 位）、`assets` 目录、绑定地址与端口、启动耗时、`process.versions.node`。
- FR-008-014 系统 MUST NOT 以「端口可连接」代替「`/api/info` 200」作为就绪判据（服务端可能在完成装配前已监听端口）。

### 3.3 内嵌 UI（同源 SPA）

- FR-008-015 系统 MUST 使用**服务端内嵌 UI**（`app-archive.bin`，由 `packages/cli/src/services/web-ui.ts` 同源托管）：`GET /` MUST 返回 SPA 的 `index.html`。
- FR-008-016 系统 MUST NOT 采用「关闭内嵌 UI + 自行打包前端 + 自定义协议 / preload 桥」路线（这是上游 `packages/desktop` 的做法，本工程不采用）。
- FR-008-017 UI 与 API MUST 同源：`/api`、`/api/*`、`/auth/*`、`/openapi.json` 走 API（路由未命中 → 404）；其余路径走 UI（未命中资源回落 `index.html`）。渲染层 MUST NOT 通过 CORS 配置或 CSP 改写来实现访问。
- FR-008-018 事件面 MUST 为 `/api/event`（SSE，首个事件 `server.connected`）；验收 MUST 覆盖「能读到首个事件」。
- FR-008-019 系统 MUST NOT 改写服务端下发的 CSP（含内联主题脚本 sha256 与 `worker-src blob:`）；R2 通道若因此拦截，必须登记到 `001-render-channel` 的探针结论（⚠️ 冲突登记，而不是改 CSP）。
- FR-008-020 UI MUST NOT 依赖工作区（项目）语义才能显示首屏；项目目录选择与授权属后续模块（`011-workspace-auth` 编号区间），本模块只保证「侧载 UI 可用」。

### 3.4 降级与边界

- FR-008-021 内容搜索能力 MUST 处于**明示降级**状态：`fff` 不可用（需 FFI/`--experimental-ffi`）且 `rg` 不可执行（用户目录不可 exec + 需下载 glibc ELF）→ 搜索返回空并可见提示，MUST NOT 静默失败。
- FR-008-022 文件监听 MUST 为关闭状态（`OPENCODE_FILEWATCHER_DISABLE=1` 使 `Watcher` 为空实现）→ 插件与配置的**变更不热重载**属预期行为，MUST 在文档中明示。
- FR-008-023 宿主内启用的原生能力 MUST 与补丁集一致：`#sqlite` 走 better-sqlite3 变体、`#pty` 与 `#persistent-pty-binary` 为 stub、wasm 路径由产物前导注入；启动 MUST NOT 因原生件加载失败而中断（⬜ 设备侧确认；根因是上游 `#pty` 在模块顶层 `createRequire`）。
- FR-008-024 若实测发现 stock CLI 契约不足以表达所需端口 / 密码 / 降级开关，方可启用逃生口：按「新增一个 Vite 入口直接调用 `ServerProcess.start`」补入口（Phase 1 备选）；启用前 MUST 记录 stock 契约的具体不足与对照实验。
- FR-008-025 系统 MUST NOT 通过新增上游构建脚本或 fork 上游来表达启动参数。
- FR-008-026 服务端 MUST 只在 007 定标的单一宿主内运行，MUST NOT 重复起实例（与 `002-lifecycle` 的「服务端只在一个宿主内运行」一致）。
- FR-008-027 系统 MUST NOT 使用固定端口、MUST NOT 依赖 mDNS、MUST NOT 自建前端工程（三条硬边界）。

## 4. 关键实体

| 实体 | 说明 | 关键属性 |
|------|------|----------|
| 启动规格（ServerBootSpec） | argv/env 组合 | `argv`（六个元素固定）、`env`（开关集合）、`cwd`、`bundlePath` |
| 服务端点（ServerEndpoint） | 就绪后的地址 | `host`(`0.0.0.0`)、`port`（实际端口）、`url`（渲染层可达地址）、`passwordRef`（凭据句柄） |
| 健康检查（HealthCheck） | 就绪判据与过程 | `path`(`/api/info`)、`timeoutMs`(30000)、`attempts`、`lastError`、`readyAt` |
| UI 归档（UiArchive） | 内嵌 UI 来源 | `assetsDir`、`appArchiveBin`、`csp`（服务端下发，只读） |
| 启动诊断（BootDiagnostics） | 取证信息 | `bundleSha8`、`nodeVersion`、`assetsDir`、`port`、`startupMs` |
| 降级开关（DegradeSwitch） | 三项 env 开关 | `key`、`value`、`effect`（关闭能力描述）、`visibleIn`（何处明示） |

## 5. 验收场景

### 场景 1：host 侧门禁全绿

- Given `dist-node` 产物与 `assets` 就位
- When 执行 `node scripts/smoke-node22.mjs`（Node 22.17.0）
- Then `--version`、`--help`、`serve`、`GET /api/info` 200、`GET /` 返回含 v2 UI 标记的 SPA、`GET /api/event` 读到首个事件——六项全绿

### 场景 2：真机就绪

- Given 宿主（007 定标候选）已启动、密码已注入、router 层已装配
- When 渲染层请求 `http://<局域网IP>:<port>/`
- Then SPA 首屏可用；页面内 `fetch('/api/info')` 返回 200

### 场景 3：离线启动

- Given 设备无外网
- When 应用启动
- Then 服务端正常就绪（`OPENCODE_DISABLE_MODELS_FETCH=1` 生效），无因联网拉取导致的卡住或失败

### 场景 4：端口随机且可回读

- Given 连续两次启动应用
- When 比较两次的实际端口
- Then 端口不同且都被渲染层成功加载；日志中记录端口与来源方式

### 场景 5：SSE 首事件

- Given UI 已加载
- When 订阅 `/api/event`
- Then 收到首个事件 `server.connected`，后续事件持续到达（R2 结果待 001 探针）

### 场景 6：降级开关有效且明示

- Given 三项降级开关已设置
- When 观察启动日志与 UI 行为
- Then 无 watcher/fff 相关报错刷屏；搜索类操作返回空结果并有可见提示；文档明示「变更不热重载」

### 场景 7：不加逃生口（负面验收）

- Given stock CLI 契约满足端口/密码/开关三项需求
- When 评审启动实现
- Then MUST NOT 存在新增 Vite 入口或自定义 `ServerProcess.start` 调用；对照结论记录在案

## 6. 非功能需求

- **性能**：服务端启动耗时、`/api/info` 首次成功耗时 MUST 被测量（⬜ 实测值待采集）；健康检查退避轮询避免忙等。
- **可靠性**：端口冲突/占用、`assets` 缺失、原生件加载失败均须表现为具体错误（fail-visible），不得统一表现为白屏。
- **可维护性**：`argv`/env 集中单一来源；上游契约变化只需改一处；宿主被替换时本模块不受影响。
- **安全性**：绑 `0.0.0.0` 的暴露面由「强制密码 + 随机端口 + 不启用 mDNS」共同约束；MUST NOT 改 CSP/CORS；密码不落盘（004）；MUST NOT 以 `--inspect` 等调试开关进入生产。
- **幂等性**：健康检查可重复调用；重复启动（应用重启）不残留端口占用与实例。

## 7. 假设与约束

- 假设 ✅：v2 服务端入口为 `ServerProcess.run`（CLI 侧 `packages/cli/src/server-process.ts`）→ `ServerProcess.start`（`packages/server/src/process.ts`，Effect HTTP）；`ServerOptions` 可注入 `app`/`database`/`pty`/`events`/`models`/`config`/`fs` 等。
- 假设 ✅：`serve` 支持 `--hostname/--port/--cors/--service/--stdio`；**无 `--mdns`、无 `opencode web`**。
- 假设 ✅：密码必填（`OPENCODE_PASSWORD` / `OPENCODE_SERVER_PASSWORD`）。
- 假设 ✅：只需 `--bundle-only`（非 SEA）产物：`dist-node/{opencode.mjs, assets/**}`，其中 `assets/app-archive.bin` 为内嵌 UI。
- 假设 ✅：三项能力可由 env 关闭：`OPENCODE_DISABLE_MODELS_FETCH`（+可选 `OPENCODE_MODELS_PATH`）、`OPENCODE_FILEWATCHER_DISABLE`、`OPENCODE_DISABLE_FFF`。
- 假设 ✅：`packages/app` 生产构建把服务端地址解析为 `location.origin`（`VITE_OPENCODE_SERVER_MODE=origin`）→ 同源加载成立。
- 约束：Node 版本错位（构建目标 node26 vs 设备 Node 22.17）→ 必须依赖补丁 0001 与 host 门禁（005）。
- ⬜ 待验证：`--port 0` 时实际端口能否被回读（验证方式：host 侧用 stock bundle 启动并观察输出/接口；设备侧同样验证）。
- ⬜ 待验证：`--hostname 0.0.0.0` 与随机端口组合在设备上是否被允许（P0-1 第 ⑤ 项）。
- ⬜ 待验证：`OPENCODE_CLIENT=desktop` 对服务端行为的实际影响（工程规划 O5）。
- ⬜ 待验证：完全无外网时的启动稳定性（真机断网启动）。
- ⬜ 待验证：设备侧原生件加载是否真的不中断（补丁 0003 的生效证据）。
- ⬜ 待验证：服务端是否对请求来源（`Host`/`Origin`）做判定（与 004 的对照实验联动）。

## 8. 依赖

**上游（被本模块消费）**：

- `packages/cli/src/commands/{commands.ts,handlers/serve.ts}`（命令面）；
- `packages/cli/src/server-process.ts`（模式、密码、env 契约、端口/主机解析）；
- `packages/server/src/{process,options,routes,cors}.ts`（`ServerProcess.start`、`ServerOptions`、路由、CORS）；
- `packages/cli/src/services/web-ui.ts` + `packages/cli/src/{app-assets,app-archive}.ts`（内嵌 UI 与归档格式、CSP）；
- `packages/app/src/runtime/platform/web.ts`（`location.origin` 解析）。

**本工程（被本模块消费）**：

- `003-artifact-bootstrap`：`artifactRoot()` / `assetsDir()`；
- `007-runtime-host`：宿主与 `assembleHostEnv`；
- `004-request-hooks`：密码与凭据句柄；
- `002-lifecycle`：`health` 阶段、退出清理；
- `005-build-pipeline`：`scripts/smoke-node22.mjs` 复用同一断言。

**下游（消费本模块）**：

- `001-render-channel`：URL 与「可加载」判据（`GET /api/info` 200）；
- `004-request-hooks`：健康检查请求形态；
- `002-lifecycle`：阶段推进与失败展示；
- `005-build-pipeline`：host 侧门禁断言集。
