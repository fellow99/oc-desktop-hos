# 应用与宿主生命周期（002-lifecycle）—— 规格

> **Module:** 002-lifecycle ｜ **Status:** Proposed ｜ **Last Updated:** 2026-10-11 ｜ **上游基线:** opencode v2.0.26（Branch_v2.0.26）

## 1. 模块概述

### 1.1 目的（Why this module exists）

编排应用从「进程起来」到「首屏可用」再到「干净退出」的全生命周期：

1. **环境装配**：把沙箱可写目录映射为宿主可用的 `HOME` / `XDG_*` / `TMPDIR` / `PATH`（工程规划 §5.3）；
2. **启动时序**：`env → artifact → host → health → load` 五阶段顺序推进，每阶段可观测、失败即可见；
3. **退出清理**：`before-quit` / `will-quit` 关闭宿主、回收子进程与僵尸、释放端口；
4. **崩溃与僵尸观测**：在无 root、无 faultlog 的前提下把「崩溃 / 僵尸 / 卡住」变成可读事实；
5. **2in1 最小化与后台语义**：明确 v1 立场（最小化不构成后台、不做后台常驻）。

### 1.2 解决的问题（What pain points it addresses）

- **卡住不说**：宿主起不来、产物解压失败、健康检查超时若没有阶段可见性，现场只剩一张白屏（工程规划 §5.2 纪律：不允许「卡住但不说」）。
- **沙箱错位**：🔶 真机 `homedir()` = `/storage/Users/currentUser` 不可写、`/tmp` 与 `os.tmpdir()` 不可写且 `TMPDIR` 对 Node 无效 → 不装配就等于宿主随机写失败。
- **退出残留**：宿主进程 / 常驻 shell / 端口不清理会跨启动累积（🔶 每 spawn 泄漏 1 个僵尸）。
- **退出事件不可用**：🔶 子进程 `exit`/`close` 事件永不触发、`cp.exec` 永不回调 → 不能依赖事件做清理，必须自己收尸。
- **后台语义幻觉**：🔶 2in1 最小化后 `aa dump -a` 仍显示 `#FOREGROUND`、`onBackground` 不触发 → 任何「最小化后继续跑」的假设都不成立，必须显式登记。

### 1.3 范围（Scope）

**包含**：

- 环境装配（`HOME`/`USERPROFILE`、`XDG_*`、`TMPDIR` + `os.tmpdir()` 覆写、`PATH`、`OPENCODE_CLIENT`、可选 `OPENCODE_DB`）与目录可写校验；
- 五阶段启动时序的编排、阶段枚举、阶段文本、超时门限、耗时记录；
- 退出清理（宿主关闭、子进程与僵尸回收、端口释放、产物与 marker 保留策略）；
- 崩溃与僵尸观测（宿主异常退出、`/proc` 观测口径、诊断摘要汇总）；
- 2in1 最小化 / 后台 / 开机自启的 v1 立场与登记。

**不包含**：

- 渲染通道实现与 loading 页渲染细节（见 `001-render-channel`，本模块只驱动阶段文本）；
- 产物形态与解压算法（见 `003-artifact-bootstrap`）；
- 宿主形态三候选定义与探针（见 `007-runtime-host`，本模块只调用统一宿主契约）；
- 服务端 argv / env 细节与健康检查接口定义（见 `008-server-ui-load`）；
- 请求头 / 凭据注入与 `NO_PROXY`（见 `004-request-hooks`）；
- 托盘 / 状态栏 / 通知 / 深链（Phase 2+）。

## 2. 用户故事

- 作为用户，我希望启动过程中任何一步失败都能看到「卡在哪一步、为什么」，而不是盯着白屏。
- 作为用户，我希望退出应用后系统里不残留后台进程、端口占用或占内存的僵尸。
- 作为研发，我希望判断「是产物问题还是宿主问题」只需要看阶段与日志，而不是反复重启试。
- 作为研发，我希望 2in1 的窗口最小化行为有明确结论（是否触发 `onBackground`、是否算后台），避免按错误假设写代码。
- 作为评审者，我希望沙箱映射是单一来源且可审计（哪些变量由谁设置、值是什么）。

## 3. 功能需求

### 3.1 环境装配（沙箱映射）

- FR-002-001 系统 MUST 在任何 JS 宿主（主进程内 import / utility 进程 / worker）启动**之前**完成环境装配。
- FR-002-002 系统 MUST 把 `HOME` 与 `USERPROFILE` 指向 `<userData>` = `/data/storage/el2/base/files`（🔶 真机唯一可写的应用目录）。
- FR-002-003 系统 MUST 建立并导出 `XDG_DATA_HOME` = `<userData>/data`、`XDG_CACHE_HOME` = `<userData>/cache`、`XDG_CONFIG_HOME` = `<userData>/config`、`XDG_STATE_HOME` = `<userData>/state`（对应上游 `@opencode/util/global-roots`）。
- FR-002-004 系统 MUST 设置 `TMPDIR` = `<userData>/tmp` **并覆写 `os.tmpdir()`**；🔶 真机上环境变量对 Node 无效，仅设变量不成立。
- FR-002-005 系统 MUST 保证上述映射目录存在且可写，方式为「写入探针文件后回读校验」；🔶 hmdfs 上 `chmod` 静默失效，MUST NOT 依赖 `mode` 判定可写性。
- FR-002-006 系统 MUST 前置可用工具目录到 `PATH`（至少 `/system/bin`），并在调用外部命令时优先使用绝对路径（🔶 PATH 中 `/usr/local/bin`、`/usr/bin`、`/data/app/bin` 均不存在）。
- FR-002-007 系统 MUST 设置 `OPENCODE_CLIENT=desktop`；⬜ 待验证：该变量对服务端行为的实际影响（工程规划 O5；验证方式：设置与不设置各跑一次 `GET /api/info` 与启动日志对比）。
- FR-002-008 系统 MAY 显式设置 `OPENCODE_DB` = `<userData>/data/opencode/opencode.db`；⬜ 待验证：是否覆盖 `XDG_DATA_HOME` 的推导路径并避免写出多份数据库。
- FR-002-009 系统 MUST 以**单一来源**管理环境变量：本模块只装配沙箱与客户端标识，密码类由 `004-request-hooks` 注入、服务端开关类由 `008-server-ui-load` 注入；同一变量 MUST NOT 在两处赋值。

### 3.2 启动时序

- FR-002-010 系统 MUST 按固定顺序推进 `env → artifact → host → health → load` 五个阶段；同一阶段 MUST NOT 重入或并发。
- FR-002-011 任一阶段失败时系统 MUST 停止推进，把失败阶段与原因写入 `globalThis.__stageError`（摘要 ≤ 2500 字符），并驱动 loading 页显示（见 001）。
- FR-002-012 每个阶段 MUST 输出统一前缀日志（`[oc-desktop]`）与 hilog 关键字，使 `hdc shell "hilog -x | grep oc-desktop"` 可还原时序。
- FR-002-013 `health` 阶段 MUST 有超时上限；默认 30s 且可配置；超时 MUST 判失败（fail-visible），但 MUST 保留宿主侧日志与诊断（不直接判宿主死亡）。
- FR-002-014 系统 MUST 记录每阶段耗时与首启总耗时（⬜ 实测值待采集，落 `docs/真机验证记录.md`）。
- FR-002-015 系统 MUST 支持「重试」入口：失败态下从失败阶段起重推（产物已就绪时可跳过重复解压工作，但阶段仍要记录）。
- FR-002-016 启动时序 MUST 与 `007-runtime-host` 的宿主探针解耦：无论最终定标 A/B/C，阶段枚举与时序不变。

### 3.3 退出清理

- FR-002-017 系统 MUST 在 `before-quit` / `will-quit` 中关闭宿主：候选 A 终止 utility 进程、候选 B 触发服务端 `shutdown` 并关闭监听、候选 C `worker.terminate()` + 兜底（⬜ 具体手段随 007 定标）。
- FR-002-018 系统 MUST 关闭本应用启动的所有子进程会话（常驻单 shell 与哨兵行通道），使退出后无遗留进程。
- FR-002-019 系统 MUST NOT 在退出时删除 `<userData>/opencode-dist/` 与 marker 文件（避免每次启动重复解压；升级由 003 的 SHA-256 比对触发）。
- FR-002-020 系统 MUST 保证退出后无残留监听端口；⬜ 待验证：设备侧观测手段（`toybox netstat` 等 applet 可用性），验证方式：退出后执行端口查询并在 `docs/真机验证记录.md` 留证。
- FR-002-021 系统 MUST 定义「关窗即退出」语义（2in1 不做窗口级常驻）；宿主生命周期与窗口生命周期绑定，且该语义在 007 定标后保持不变。
- FR-002-022 退出清理 MUST 幂等：重复触发 `before-quit` / 重复调用关闭不得抛异常或产生二次副作用。

### 3.4 崩溃与僵尸观测

- FR-002-023 系统 MUST 观测宿主异常退出：候选 A 记录 utility 进程退出码；候选 C 监听 worker `error`/`exit`；候选 B 无法自观测 → MUST 用「带凭据的 `GET /api/info` 连续失败 N 次」作为兜底信号。
- FR-002-024 观测到宿主异常退出后系统 MUST 记录并在 UI 或日志中提示，MUST NOT 静默重试掩盖问题。
- FR-002-025 系统 MUST NOT 依赖子进程 `exit` / `close` 事件读取退出码（🔶 真机永不触发）；需要退出码时 MUST 用哨兵行（`sh -c '<cmd>; echo "__RC=$?"'`）从 stdout 解析。
- FR-002-026 系统 MUST 提供僵尸观测口径（`/proc/<pid>/stat` 状态为 `Z`）并在退出时统一回收；僵尸数 MUST 可在日志中观察（⬜ `/proc` 可读性待真机确认）。
- FR-002-027 系统 MUST 汇总诊断摘要（`__hostError` / `__extractError` / `__renderError` / `__stageError`）供失败态展示与日志导出。
- FR-002-028 系统 MUST NOT 在日志或诊断摘要中输出服务端密码等敏感值（一律脱敏）。
- FR-002-029 系统 MUST 保证「服务端只在一个宿主内运行」：渲染层、扩展 Ability、探针页面 MUST NOT 另起服务端实例。

### 3.5 2in1 最小化与后台语义

- FR-002-030 系统 MUST 按「最小化不构成后台」实现：🔶 真机最小化后 `aa dump -a` 仍为 `#FOREGROUND`，`onBackground` 不触发。
- FR-002-031 v1 MUST NOT 规划后台常驻 / 开机自启；退出即退出；`autoStartupManager` 无公开 setter（⬜ 待验证：是否存在可用替代接口）。
- FR-002-032 系统 MAY 在 `electron/src/main/module.json5` 声明 `KEEP_BACKGROUND_RUNNING` 并配合 `backgroundModes: ["taskKeeping"]`，但 MUST NOT 声明未实际使用的能力（声明与行为一致）。
- FR-002-033 2in1 最小化 / 后台 / 通知的结论 MUST 登记到 `docs/鸿蒙环境能力清单.md`（状态 + 根因层 + 证据）。

## 4. 关键实体

| 实体 | 说明 | 关键属性 |
|------|------|----------|
| 启动阶段（Stage） | 五阶段枚举 | `id`(`env`/`artifact`/`host`/`health`/`load`)、`order`、`timeoutMs`、`failVisible` |
| 阶段轨迹（StageTrace） | 单次启动的阶段记录 | `id`、`state`(`pending`/`running`/`ok`/`failed`)、`startedAt`、`durationMs`、`detail` |
| 环境映射（EnvMapping） | 沙箱变量单一来源 | `name`、`value`、`owner`(`lifecycle`/`hooks`/`server`)、`verified`（回读校验结果） |
| 宿主退出信息（HostExitInfo） | 宿主退出记录 | `kind`(`clean`/`crash`/`unknown`)、`code`、`at`、`evidence` |
| 诊断摘要（Diagnostics） | 失败态可读摘要 | `stage`、`errorKeys`（`__hostError` 等）、`text`（脱敏、≤2500 字符） |

## 5. 验收场景

### 场景 1：首次启动五阶段成功

- Given 应用冷启动、`<userData>/opencode-dist/` 为空
- When 应用启动
- Then 阶段依次为 `env → artifact → host → health → load` 且全部 `ok`；每阶段有 `[oc-desktop]` 日志；首屏可用；阶段耗时被记录

### 场景 2：产物阶段失败 fail-visible

- Given tar 包缺失或损坏（003 判定失败）
- When 应用启动
- Then 停在 `artifact` 阶段，loading 页与 `globalThis.__stageError` 均显示原因；`host` 及之后阶段不发生

### 场景 3：健康检查超时

- Given 宿主已启动但 `GET /api/info` 持续失败
- When 超过 30s 门限
- Then 判 `health` 阶段失败并保留宿主与请求日志；MUST NOT 无限静默等待

### 场景 4：退出清理

- Given 应用已可用（宿主在跑、常驻 shell 已建立）
- When 用户退出应用
- Then 宿主被关闭、常驻 shell 会话被关闭、无残留监听端口；再次启动不因端口冲突失败

### 场景 5：宿主异常退出可观测

- Given 宿主进程被外部终止（或 worker 抛未捕获异常）
- When 系统观测到退出信号或请求连续失败
- Then 产生 `HostExitInfo`（`crash` 或 `unknown` + 证据）并在日志可见；不静默重试

### 场景 6：2in1 最小化语义

- Given 应用在前台运行
- When 用户最小化窗口
- Then `hdc shell aa dump -a` 仍显示 `#FOREGROUND`、`onBackground` 不触发；应用行为与结论一致（不做后台任务）；结论已登记文档

## 6. 非功能需求

- **性能**：阶段推进不得忙等；健康检查与宿主兜底轮询 MUST 有退避；环境装配为一次性开销。
- **可靠性**：任何阶段失败 MUST 有可读结论（fail-visible）；退出路径 MUST 幂等且不得因清理失败阻塞退出。
- **可维护性**：阶段为单一枚举、日志为单一前缀、环境装配为单一来源；新增阶段必须同步更新阶段表与本规格。
- **安全性**：诊断摘要与日志 MUST 脱敏（不含密码）；沙箱映射 MUST 只指向 `<userData>`，MUST NOT 指向用户可见目录。
- **幂等性**：重复推进同一阶段、重复关闭宿主、重复触发退出清理均无副作用。

## 7. 假设与约束

- 假设 🔶：`/tmp` 与 `os.tmpdir()` 不可写，且 `TMPDIR` 环境变量对 Node 无效 → 必须覆写 `os.tmpdir()`。
- 假设 🔶：子进程 `exit`/`close` 事件永不触发、`cp.exec` 永不回调、每次 spawn 泄漏 1 个僵尸。
- 假设 🔶：`homedir()` = `/storage/Users/currentUser` 不可写；`<userData>` 与 `<cache>` 可写。
- 约束 ⚠️：宿主形态未定（工程规划 §3.2 冲突 C1/C2）→ 阶段时序与清理逻辑 MUST 对三候选同时成立，禁止依赖某一候选的专有行为。
- 约束：候选 B（主进程内）下宿主崩溃等价于应用级崩溃 → 崩溃观测只能靠健康检查兜底，MUST 在文档登记该盲区。
- ⬜ 待验证：`os.tmpdir` 覆写是否对本工程 bundle 内所有调用点生效（验证方式：真机观察宿主是否在 `<userData>/tmp` 落临时文件；不生效则改为向宿主注入等价配置）。
- ⬜ 待验证：`/proc/<pid>/stat` 在应用域是否可读（验证方式：应用内读自身与子进程状态并落日志）。
- ⬜ 待验证：2in1 最小化是否在任何平台版本下触发 `onBackground`（验证方式：`aa dump -a` 与日志对照）。
- ⬜ 待验证：hilog 的保留窗口与持久化能力（验证方式：长跑后查历史日志可用性）。

## 8. 依赖

**上游（被本模块消费）**：

- `@opencode/util/global-roots`（`XDG_*` 数据根语义，✅ 源码）—— 决定 `XDG_*` 的落点与目录名；
- `packages/cli/src/server-process.ts` 的 env 契约（✅ 源码）—— 决定 `OPENCODE_CLIENT` / `OPENCODE_DB` 等变量语义；
- Electron `app` 事件（`before-quit` / `will-quit`）与 harmonypc-electron 的窗口 ↔ Ability 映射。

**本工程（被本模块消费）**：

- `003-artifact-bootstrap`：`artifact` 阶段判据与 `__extractError`；
- `007-runtime-host`：`host` 阶段的宿主启动与关闭契约；
- `008-server-ui-load`：`health` 阶段的健康检查实现；
- `004-request-hooks`：密码与代理变量的单一来源（本模块不重复赋值）。

**下游（消费本模块）**：

- `001-render-channel`：阶段文本与失败态展示（`load` 阶段就绪信号回传本模块）；
- 未来托盘 / 通知 / 诊断面板模块：复用阶段轨迹与诊断摘要。
