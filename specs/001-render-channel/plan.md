# 渲染通道（001-render-channel）—— 实现方案

> **Module:** 001-render-channel ｜ **Status:** Proposed ｜ **Last Updated:** 2026-10-11 ｜ **上游基线:** opencode v2.0.26（Branch_v2.0.26）
> 对应规格：[spec.md](./spec.md)

## 1. 技术上下文

### 1.1 运行时环境

- Electron-on-HarmonyOS 运行时 `v37.2.3-20260825.1`（Electron 37.2.0 / Node 22.17.0 / Chromium 138 / ABI v138），主进程即 ArkTS UIAbility 进程内 `runBrowser`（🔶 harmonypc-electron 文档核实）。
- R1 的渲染进程由运行时经 `childProcessManager.startArkChildProcess` 启动（非 fork/exec，默认带 `--no-zygote`）；R2 的 `Web` 组件在**应用进程内**，不经 Electron 渲染进程。
- 宿主形态（007）未定 → 本模块只依赖契约「宿主句柄提供 `port` 与 `url`」，与候选 A/B/C 无关。
- 设备域名与地址：`deviceTypes: ["2in1","tablet"]`；loopback 在渲染侧被隔离（🔶）→ URL 用局域网 IPv4。

### 1.2 依赖

| 依赖 | 版本/来源 | 用途 |
|------|-----------|------|
| `../harmonypc-electron`（web_engine HAR） | submodule，物理拷贝进本工程 | ArkWeb 容器与桥接层骨架 |
| Electron 37 `app.commandLine` | 运行时内置 | 安全上下文提升、代理绕过开关 |
| opencode v2 内嵌 UI | `dist-node/assets/app-archive.bin`（003 解压后） | 被渲染的 SPA；CSP 由其下发 |
| `node:os` `networkInterfaces()` | Node 22.17.0 内置 | 选取可达局域网地址 |
| 004 / 007 / 008 模块 | 本工程 | 凭据、宿主端口、健康检查与 SPA 可达性 |

## 2. 关键决策

| 决策 | 结论 | 依据 |
|------|------|------|
| 目标通道 | R2（ArkWeb）为默认目标，R1 仅回退 | 上架口径 N1（🔶 dsh 审核原文）；工程规划 §3.3 |
| 通道数量 | 同一时刻只用一个通道承载 UI | 避免双连接、双状态分叉 |
| URL 形态 | `http://<局域网IP>:<port>/`，无局域网地址时回退 `127.0.0.1` | loopback 隔离（🔶） |
| 是否自建本地 server 承载 loading | 否，loading 为本地内容 | 无必要引入额外进程与端口 |
| R2 loading 载体 | ArkTS 页面（`electron/src/main/ets/pages/`） | 与 ArkWeb 组件同栈，最省事 |
| R1 loading 载体 | `src-main/main.js` 内联 HTML 字符串 | 不新增资源文件，避免与 `collect-app` 投放冲突 |
| R2 必备配置 | `domStorageAccess(true)` + `databaseAccess(true)` | 🔶 dsh PoC（缺则 `localStorage` 为 `null`） |
| R2 明文 HTTP | ⬜ 待 P0-2 第 ⑦ 项定论后写入配置 | 未验证 |
| R1 安全上下文 | `unsafely-treat-insecure-origin-as-secure` 指向目标 origin | 明文来源否则非安全上下文 |
| CSP | 一律不改写；被拦截即登记 `⚠️冲突` | CSP 由服务端下发且含必要哈希 |
| 探针 | P0-2 八项 × 两通道，结论落 `docs/真机验证记录.md` | 工程规划 §10 |

## 3. 数据模型

### 3.1 实体定义

通道句柄（两实现共同契约，`src-main/main.js` 闭包内构造）：

```js
{
  kind: 'R2' | 'R1',
  url: 'http://<host>:<port>/',
  open: (url) => Promise<void>,
  setStage: (stage) => void,      // { id, text, state, detail }
  hideLoading: () => void,
  dispose: () => Promise<void>,
}
```

- 阶段对象：`{ id: 'env'|'artifact'|'host'|'health'|'load', text, state: 'running'|'ok'|'failed', detail }`
- 探针记录：`{ channel: 'R2'|'R1', index: 1..8, title, result: 'pass'|'fail', errorText, evidence, device }`
- 错误摘要：`globalThis.__renderError = '<stage>: <message>'`（截断 ≤ 2500 字符）

### 3.2 状态转换

```
idle → loading(env) → loading(artifact) → loading(host) → loading(health) → loading(load)
     → ready（首屏就绪信号）→ loading 关闭
任一阶段失败 → failed(stage, detail)（保持可见，可重试/退出）
ready 之后渲染异常 → error（写 __renderError，不自动回 loading）
```

### 3.3 校验规则

- `url.host` 必须为「局域网非 internal IPv4」或 `127.0.0.1`；`url.port` 必须等于宿主回传端口（008），不得硬编码。
- `stage.id` 必须取自枚举 `env|artifact|host|health|load`。
- R2 `open()` 前必须断言存储开关为真（`domStorageAccess === true && databaseAccess === true`），否则拒绝打开并写 `__renderError`（fail-closed）。
- R1 通道必须已安装请求钩子（004）才允许 `open()`（否则服务端 401 会表现为白屏）。

## 4. 接口契约

### 4.1 本模块提供

| 接口 | 说明 |
|------|------|
| `createRenderChannel(kind)` | 创建 R2/R1 通道实现 |
| `openUi({ url, onStage })` | 打开 UI 并绑定阶段回调（由 002 驱动调用） |
| `pickReachableHost()` | 局域网非 internal IPv4 优先，回退 `127.0.0.1` |
| `globalThis.__renderError` | 渲染失败摘要（供诊断面板与日志） |
| ArkTS 侧容器页契约 | `Web` 组件实例、存储开关、`onPageEnd`、`onErrorReceive` |

### 4.2 本模块消费

| 来源 | 契约 |
|------|------|
| 007-runtime-host | 宿主句柄 `{ port, url, shutdown }`（形态无关） |
| 008-server-ui-load | `GET /api/info` 200 = 可加载；`GET /` 返回含 v2 UI 标记的 SPA |
| 004-request-hooks | R1 的 `Authorization` 注入与 `Host`/`Origin` 改写 |
| 环境变量 | `OPENCODE_PASSWORD`（R2 分支持有凭据方式 ⬜ 待 P0-2） |
| 构建期开关 | `oc-desktop.renderChannel=R2|R1`（构建/调试开关，最终键名随骨架落地对齐） |

## 5. 实现策略

### 5.1 关键算法

- **启动顺序**：建窗口 → 立即渲染 loading → 由 002 推进阶段 → `open(url)` → 首屏就绪信号 → `hideLoading()`。
- **可达地址**：遍历 `os.networkInterfaces()`，取首个 `family === 'IPv4' && !internal && address` 非空者；无则 `127.0.0.1`。
- **R2**：ArkTS `Web({ src: url, controller })`，`domStorageAccess(true)`、`databaseAccess(true)`；以 `onPageEnd` 为首屏信号（⬜ 是否需要 `onProgressChange === 100` 更稳，待探针第 ① 项确认）。
- **R1**：`new BrowserWindow({ show: false })` → 内联 loading → `loadURL(url, { extraHeaders })` → `did-finish-load` → `show()`；启动前 `app.commandLine.appendSwitch("unsafely-treat-insecure-origin-as-secure", origin)`。
- **外链口径**：R2 侧统一在 ArkWeb 内打开；`module.json5` 不声明 `browsable` / `viewData`。

### 5.2 错误处理

- `open()` 失败（R1 `loadURL` reject / R2 `onErrorReceive`）→ 写 `__renderError` + 阶段转 `failed` + `console.error('[oc-desktop] render ...')`。
- 首屏就绪超时（⬜ 门限随 002 统一）→ 判失败，保留诊断文本，不回退空白页。
- 通道不可用（R2 探针 fail）→ 调试开关切 R1；切通道必须重建窗口，不做热切换。
- R2 能力缺项（如 SW 不可用）→ 记为「能力缺项」并登记文档；不改写 UI 行为。

### 5.3 降级

- 唯一降级路径为 R2 → R1；R1 亦失败时保持 `failed` 状态并暴露诊断，**不静默**。
- 降级决定必须来自探针矩阵或人工调试开关，且写入 `docs/真机验证记录.md`。

## 6. 测试与验证

### 6.1 host 侧

- 复用 `008` 的 `scripts/smoke-node22.mjs` 保证「UI 可从 Node 侧取到」（`GET /` 含 v2 UI 标记、`GET /api/event` 首事件）——渲染层不可用时先排除服务端原因。
- 纯函数部分（可达地址选择、阶段状态机、URL 拼接）做离线断言（测试框架统一由 `005-build-pipeline` 决定，⬜ 待定）。
- P0-2 探针在 host 侧只准备脚本与断言文本；**结论必须在真机采集**。

### 6.2 真机命令

```bash
# 构建与安装（debug）
hvigorw assembleHap --mode module -p product=default -p buildMode=debug --no-daemon
hdc app install -r electron/build/default/outputs/default/electron-default-signed.hap
hdc shell aa start -a EntryAbility -b org.fellow99.oc.OCDesktop

# 取证
hdc shell "hilog -x | grep oc-desktop"        # 阶段与错误
hdc shell aa dump -a                          # Ability 状态
hdc fport tcp:19229 tcp:9229                  # debug 构建下评估 R1 渲染侧 JS（CDP）
```

- 探针落点：`scripts/probes/render-probe.mjs`（host 侧驱动 + 真机侧断言清单），八项逐条输出 `ProbeRecord` 并汇总到 `docs/真机验证记录.md`。
- 明文 HTTP 与 loopback：真机访问 URL 时必须用局域网 IP（`hdc shell ifconfig` 取值，命令可用性 ⬜ 待验证）。

### 6.3 验收口径

- P0-2「八项 × 两通道」矩阵齐备且证据可复现；R2 全绿则以 R2 验收 spec §5 场景 1/5，否则以 R1 验收并登记 R2 阻断项。

## 7. 文件清单

| 文件（相对工程根） | 用途 |
|--------------------|------|
| `electron/src/main/ets/pages/`（loading 页与 Web 容器页，命名随骨架落地对齐） | R2 载体与阶段文本 |
| `web_engine/src/main/ets/components/`（ArkWeb 封装组件） | `Web` 组件配置、存储开关、`onPageEnd`/`onErrorReceive` |
| `electron/src/main/module.json5` | 明文 HTTP 策略与 skill 声明（移除 `browsable`/`viewData`） |
| `src-main/main.js` | R1 通道、内联 loading、`pickReachableHost()`、通道选择开关、`__renderError` |
| `scripts/probes/render-probe.mjs` | P0-2 八项探针驱动与记录产出 |
| `docs/真机验证记录.md` | 探针矩阵落点（新增 P0-2 章节） |

## 8. 与规格的交叉引用

| 规格需求 | 落点 |
|----------|------|
| FR-001-001 ~ 004（通道抽象与选择） | `src-main/main.js`（`createRenderChannel`/`openUi`）+ 构建期开关 |
| FR-001-005 ~ 011（R2） | `electron/src/main/ets/pages/`、`web_engine/src/main/ets/components/`、`electron/src/main/module.json5` |
| FR-001-012 ~ 015（R1） | `src-main/main.js`（窗口创建、`appendSwitch`） |
| FR-001-016 ~ 020（loading 与 URL） | `src-main/main.js` + ArkTS 页面（阶段状态机、`pickReachableHost`） |
| FR-001-021 ~ 025（P0-2 探针与结论回写） | `scripts/probes/render-probe.mjs`、`docs/真机验证记录.md`、`docs/鸿蒙环境能力清单.md` |
