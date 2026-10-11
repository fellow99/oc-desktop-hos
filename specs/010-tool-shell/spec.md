# 命令执行工具 shell（010-tool-shell）—— 规格

> **Module / Status: Proposed / Last Updated: 2026-10-11 / 上游基线: opencode v2.0.26（Branch_v2.0.26）**
>
> **上游基线**：opencode `v2.0.26`（tag `v2.0.26`，提交 `9b4ec5714d`，分支 `Branch_v2.0.26`）。本规格的全部上游引用与补丁契约均以该基线为准。
> **证据标注口径**（沿用 `docs/工程规划-V2.md` §0.2）：✅ **实测**（真机或上游源码直接验证）｜🔶 **沿用**（同型工程或既有调研结论，本工程未复现）｜⬜ **待验证**（本工程必须自行实测）｜⚠️ **冲突**（一手材料互斥）。
> **真机事实来源**：`dsh-desktop-hos` 的真机记录（设备 `3QC0226526001227` / HarmonyOS 6.1.0.135 / API 24 / 2in1），经 `docs/工程规划-V2.md` §2.5 转述；本工程**尚无任何真机记录**，故本规格内凡涉及设备行为的条目一律同时给出「来源」与「本工程复验状态」。

## 1. 模块概述

### 1.1 目的

给 opencode v2 服务端（跑在鸿蒙设备宿主内）提供一条**在设备上真正可用**的命令执行通路：模型可见的 shell 工具在宿主进程内 `spawn` **一个常驻 `/system/bin/sh`**，用**哨兵行协议**判定命令完成并取回退出码，并在工具层叠加**路径围栏**（fail-closed）。

模块存在的直接原因：上游 v2 的 shell/终端能力依赖两个原生变体 —— `#pty`（`@lydell/node-pty`，模块顶层 `createRequire`）与 `#persistent-pty-binary`（`opencode-pty` 助手 ELF）。本工程两者都**打桩**（补丁 `0003-runtime-stubs-ohos`，`docs/工程规划-V2.md` §3.6），且 PTY 在平台上**平台级不可用**（SELinux 拒 `forkpty` / `openpty` / `posix_openpt` / `popen`，`EACCES`）。因此「命令执行」不能靠打开某个开关恢复，必须在 `ohos` 条件下新建一个**非 PTY 执行后端**。

### 1.2 解决的问题

| # | 问题 | 性质 | 若不处理的后果 |
|---|---|---|---|
| 1 | PTY 平台级不可用（`forkpty` / `openpty` 被 SELinux 拒，无官方应用级 API） | 平台硬约束（L1） | 任何「接 PTY 就有终端」的设计必然失败；上游 `#pty` / `#persistent-pty-binary` 变体在设备上只会抛错或拖垮 bundle import |
| 2 | **子进程退出不可观测**：观测到的事件序列只有 `proc:spawn → stdout:end → stderr:end → stdout:close`，**永无 `proc:exit` / `proc:close`**；`cp.exec` **永不回调**；每 spawn 净泄漏 1 个僵尸（实测 4 spawns → 4 zombies；单会话累计 30 个） | 平台硬约束（L1） | 「一命令一 spawn + 等 exit」的模型会：拿不到退出码、丢僵尸、并留下永不结束的调用 |
| 3 | **shell 子进程整体绕过既有文件围栏与审批**：子进程以应用同一 uid 运行，可直接读写用户目录，不经过文件工具的路径检查、不触发任何审批 | 平台硬约束（L1）+ 本工程配置（L3） | 一旦把 shell 交给模型，权限/审批体系被整体旁路 —— 等于引入一条静默的越权通道 |
| 4 | v2 的设备侧适配层没有「非 PTY 命令执行」分支 | 上游接口缺口（L4） | 需要用条件变体 + 最小改动补丁注入后端，而不是改上游 `node` 变体 |
| 5 | 设备命令集与模型预期不一致（无 `bash` / `git` / `rg` / `curl`；存在 `toybox` 悬空软链） | 平台硬约束（L1） | 模型按 Linux 桌面假设写命令 → 大量 `not found`，且失败原因不可见 |

### 1.3 范围

**包含**：

- 非 PTY 执行后端：常驻单 shell 的 `spawn` 契约、哨兵行协议、退出码恢复、输出保真。
- 会话生命周期：惰性 spawn、单例、存活判定、重置成本、应用退出清理。
- 工具层**路径围栏**：允许根集合、词法归一化、重定向目标、不可判定构造、fail-closed 顺序、拒绝后的升级提示。
- 超时、取消、输出截断、命令串行化。
- 能力披露与降级可见性（toybox 可达性分类、PTY/搜索不可用的明示）。
- 与上游的接线面：`ohos` 条件变体、候选补丁 `0006-shell-fence`、宿主侧环境装配（`PATH`）。

**不包含**：

- **PTY / 终端面板**。平台级不可用（`docs/工程规划-V2.md` §7.2、§7.4b），本模块不尝试任何迂回。
- 进程沙箱（koffi / landlock 类）。本围栏是**工具层**判定，不是内核沙箱。
- 内容搜索（`fff` / `rg` 路径）与 `#fff` 纯 JS 变体 —— 属 Phase 2 的搜索专项（候选补丁 `0004-search-ohos`）。
- 后台任务 / 作业控制（`job_*` 语义等价物）。
- 插件通道（见 `specs/201-plugin-runtime/`）、项目目录授权（见 `specs/011-workspace-auth/`）、数据目录与 sqlite（见 `specs/012-data-dirs-sqlite/`）。
- 上游补丁的生成与幂等判定机制本身（见 `docs/工程规划-V2.md` §6.2）。

## 2. 用户故事

- 作为**使用者**，我希望在设备上让模型读改项目文件、跑构建/校验命令，而不是因为设备没有 `bash` 就失去整条工具链。
- 作为**使用者**，我希望命令能返回**真实退出码与完整输出**，而不是永远挂起或返回空结果。
- 作为**使用者**，我希望命令默认被限制在**我选定的项目目录**与**应用沙箱临时目录**内；越界操作要么被拒绝，要么明确来问我。
- 作为**使用者**，我希望应用退出后不残留失控的 shell 子进程，也不希望僵尸随使用时长无限增长。
- 作为**模型使用者**，我希望工具描述如实说明「这是非 PTY、非交互的常驻 shell」「哪些命令不存在」，这样我不会反复试错。
- 作为**评审者**，我希望围栏的残余风险被**如实写入规格**，而不是包装成「已沙箱化」。

## 3. 功能需求

> 编号规则沿用 `docs/工程规划-V2.md` §9.1：`FR-010-NNN`。每条标注 MUST / SHOULD / MAY，并在「来源 / 状态」列给出证据口径。

### 3.1 执行后端

| 编号 | 需求 | 强度 | 来源 / 状态 |
|---|---|---|---|
| FR-010-001 | 执行后端 MUST 在**服务端宿主进程内**用 `node:child_process.spawn` 启动子进程；目标 MUST 为绝对路径 `/system/bin/sh`（回退候选 `/bin/sh`、`/system/bin/toybox`），MUST NOT 依赖 PATH 查找 | MUST | ✅ dsh 真机（三者均可 spawn 并取回正确 stdout）；⬜ 本工程复验 |
| FR-010-002 | MUST NOT 使用 `child_process.exec` / `execFile`；MUST NOT 依赖 `'exit'` / `'close'` 事件作为完成信号 | MUST | ✅ dsh 真机（`cp.exec` 永不回调、`proc:exit` 从不触发）；⬜ 本工程复验 |
| FR-010-003 | MUST NOT 使用 `process.execPath` 作为 spawn 目标；MUST NOT 用 `statSync` / `accessSync` 判定可执行性 | MUST | ✅ dsh 真机（`process.execPath` 路径 `ENOENT`；`/system/bin/sh` 与 `/bin/sh` 均 `EACCES` 却能 spawn）；⬜ 本工程复验 |
| FR-010-004 | 后端 MUST 以 `stdio: ['pipe','pipe','pipe']` 建立三管道，并将 stdin 用于注入框架、stdout 作为唯一协议流、stderr 仅承载 shell 级诊断 | MUST | 🔶 dsh 实测同口径；⬜ 本工程复验 |
| FR-010-005 | 后端 MUST 由 `ohos` 条件变体（或等价的条件分支）提供，MUST NOT 改动上游 `node` 变体 | MUST | `docs/工程规划-V2.md` §3.6（`ohos` 条件 + 补丁 0001 前置 `"ohos"`）；⬜ 变体名与接入点在 Phase 0 核对 |

### 3.2 哨兵行协议与退出码

| 编号 | 需求 | 强度 | 来源 / 状态 |
|---|---|---|---|
| FR-010-006 | 单次调用的完成 MUST 由 stdout 上出现的**本次调用专属**结束哨兵行判定 | MUST | ✅ dsh 真机结论（完成只能靠流 EOF/哨兵）；⬜ 本工程复验 |
| FR-010-007 | 退出码 MUST 由 shell 在命令结束后读取 `$?` 并写入结束哨兵行带回；等价语义为 `sh -c '<cmd>; echo "__RC=$?"'` | MUST | ✅ dsh 真机（`__RC=0/1/127` 已实测）；⬜ 本工程复验 |
| FR-010-008 | 每次调用 MUST 生成**一次性随机 token**；解析器 MUST 只接受与本次 token 精确匹配的结束行 | MUST | 设计决策（本规格确定） |
| FR-010-009 | 起始行与结束行 MUST 独立成行（前置 `\n`），使命令行输出即便不以换行结尾也不会污染标记 | MUST | 设计决策（本规格确定） |
| FR-010-010 | 命令 stdout 与 stderr MUST 在 shell 侧合流为同一 stdout 流，保持真实行序；捕获 MUST 按**逐字节**进行，不做文本解码后再编码 | MUST | 设计决策（本规格确定） |
| FR-010-011 | 退出码非零 MUST 作为**正常结果**返回（如 `Exit code: 1`），MUST NOT 作为工具异常抛出；仅围栏拒绝、超时不可恢复、会话不可用属工具级错误 | MUST | 设计决策（本规格确定） |
| FR-010-012 | 同一常驻 shell 上 MUST 串行化调用：同一时刻至多一条命令在途，并发调用 MUST 排队或显式拒绝 | MUST | 设计决策（本规格确定，约束由常驻单 shell 直接推导） |

### 3.3 会话生命周期与僵尸治理

| 编号 | 需求 | 强度 | 来源 / 状态 |
|---|---|---|---|
| FR-010-013 | 每个服务端宿主 MUST 复用**一个**常驻 shell 子进程（惰性 spawn、进程内单例） | MUST | ✅ 逻辑直接来自 L1 约束（一命令一 spawn 会线性泄漏僵尸）；⬜ 本工程复验 |
| FR-010-014 | 会话存活 MUST 以 stdout 的 `'end'` / `'close'` 推断；MUST NOT 等待 `'exit'` | MUST | ✅ dsh 真机（事件序列只有 `stdout:close`）；⬜ 本工程复验 |
| FR-010-015 | 重置（kill + 重新 spawn）MUST 被视为**昂贵操作**，触发条件限于「stdout 已关闭」「超时排空失败」「显式要求」；MUST NOT 在每条命令前重置 | MUST | ✅ dsh 真机（每次 spawn 恰好泄漏 1 僵尸）；⬜ 本工程复验 |
| FR-010-016 | 规格与实现 MUST 记录「每次 spawn 泄漏 1 僵尸、子进程退出不可观测」这一事实；MUST NOT 声称已消除僵尸 | MUST | ✅ dsh 真机（`/proc/<pid>/stat` 状态 `Z`；30 僵尸挂在主进程 pid）；⬜ 本工程复验 |
| FR-010-017 | 应用退出路径（`before-quit` / `will-quit`）MUST 关闭常驻 shell 并向其发送终止信号，且 MUST NOT 阻塞退出等待不可观测的 `exit` 事件 | MUST | `docs/工程规划-V2.md` §5.1（生命周期绑定）；⬜ 本工程复验 |
| FR-010-018 | 常驻 shell 使 `cwd` 与 shell 变量跨调用延续，MUST 在工具描述中告知模型（刻意属性，不是缺陷） | MUST | 设计决策（本规格确定） |
| FR-010-019 | 空命令 / 纯空白命令 / 超长命令（默认上限 65536 字符）MUST 在派发前拒绝 | MUST | 设计决策（本规格确定） |

### 3.4 工具层路径围栏（fail-closed）

| 编号 | 需求 | 强度 | 来源 / 状态 |
|---|---|---|---|
| FR-010-020 | 派发前 MUST 对命令字符串做 token 级路径检查；拒绝 MUST 发生在任何审批交互**之前** | MUST | `docs/工程规划-V2.md` §3.8（R8：shell 绕过围栏）；⬜ 本工程复验 |
| FR-010-021 | 允许根集合 MUST 恰为：① **当前项目目录**（服务端项目根，见 `specs/011-workspace-auth/`）② **沙箱临时目录**（`<userData>/tmp`，即被 patch 的 `os.tmpdir()`）。集合之外的路径一律拒绝 | MUST | `docs/工程规划-V2.md` §3.8；⬜ 本工程复验 |
| FR-010-022 | 判定 MUST 为**词法**归一化（以会话 `cwd` 为基准消除 `.` / `..`），MUST NOT 访问文件系统、MUST NOT 解析符号链接 | MUST | 设计决策（本规格确定） |
| FR-010-023 | 重定向与管道相关目标（`>` `>>` `<` `<>`）MUST 参与同一围栏判定，不得只检查命令操作数 | MUST | 设计决策（本规格确定） |
| FR-010-024 | 不可判定构造 MUST 按拒绝处理：变量展开（`$X` / `${X}`）、命令替换（`$(...)` / 反引号）、`eval`、嵌套 `sh -c` / `env` / `xargs` / `find -exec`、引号内路径拼接 | MUST | 设计决策（本规格确定） |
| FR-010-025 | 拒绝结果 MUST 带可见原因与「申请更宽范围」的提示，并接入 v2 的权限询问通道（由使用者在 UI 中裁决） | MUST | 设计决策（本规格确定） |
| FR-010-026 | 围栏 MUST NOT 被描述为沙箱；子进程以应用同一 uid 运行、拥有完整文件读写能力，这一事实 MUST 出现在规格与工具描述中 | MUST | ✅ dsh 真机（子进程同 uid、不经过文件围栏）；⬜ 本工程复验 |
| FR-010-027 | 围栏模式 MAY 提供 `enforce`（默认）/ `warn` / `off`；非 `enforce` 模式 MUST 在启动日志中**响亮**声明 | MAY | 设计决策（本规格确定） |

### 3.5 超时、取消、截断

| 编号 | 需求 | 强度 | 来源 / 状态 |
|---|---|---|---|
| FR-010-028 | 单次命令 MUST 有墙钟超时（默认 120000 ms，可配置）；超时后 MUST 先尝试**排空到哨兵**，仅在排空也失败时才重置会话 | MUST | 设计决策（本规格确定，重置成本由 FR-010-015 决定） |
| FR-010-029 | 取消（调用方中止）时 MUST NOT 丢弃已到达的输出：标记取消、优先排空到哨兵；失败再重置 | MUST | 设计决策（本规格确定） |
| FR-010-030 | 输出超过保留上限（默认 262144 字节）MUST 只截断**返回给模型**的内容并附截断标记，同时 MUST 继续排空直到结束哨兵以保持会话同步 | MUST | 设计决策（本规格确定） |
| FR-010-031 | 超时 MUST NOT 伪造成 `Exit code: 0`；退出码未知时 MUST 明确标注 | MUST | 设计决策（本规格确定） |

### 3.6 能力披露与降级可见性

| 编号 | 需求 | 强度 | 来源 / 状态 |
|---|---|---|---|
| FR-010-032 | 工具描述 MUST 写明：后端为非 PTY、非交互的常驻 shell；无 TTY；`cwd` 跨调用延续；无 `bash` / `git` / `rg` / `curl` | MUST | ✅ dsh 真机（无 PTY；无 `bash`/`git`/`rg`/`curl`）+ 🔶 旧工程 opencode-harmony 同结论；⬜ 本工程复验 |
| FR-010-033 | 可用命令 MUST 按可达性分类披露：**直接可达**（软链已就位）/ **仅 `toybox <name>` 可达**（applet 已编译但无软链）/ **不存在**（未编译，含悬空软链）；MUST NOT 用 `ls` / `command -v` 判定可用性 | MUST | ✅ dsh 真机（`toybox 0.8.12`；`nc` 只能 `toybox nc`；42 个悬空软链；`command -v` 返回 alias）；⬜ 本工程复验 |
| FR-010-034 | `PATH` MUST 由宿主装配为「前置可用工具目录 + 系统默认」；调用外部命令 SHOULD 优先使用绝对路径 | SHOULD | `docs/工程规划-V2.md` §5.3（`/usr/local/bin`、`/usr/bin`、`/data/app/bin` 实测不存在）；⬜ 本工程复验 |
| FR-010-035 | 因平台不可用而缺席的能力（PTY / 交互式程序 / 内容搜索）MUST 明示，禁止静默失败或静默空结果 | MUST | `docs/工程规划-V2.md` §7.3、§7.4；⬜ 本工程复验 |

## 4. 关键实体

| 实体 | 说明 | 关键属性 |
|---|---|---|
| `ShellSession` | 进程内唯一的常驻 shell 会话 | `shellPath`、`pid`、`stdin`/`stdout`/`stderr`、`state`（`idle` / `busy` / `closed`）、`spawnCount`（僵尸预算计数） |
| `SentinelFrame` | 单次调用的框架文本与解析结果 | `token`、`beginLine`、`endLine`、`capturedBytes`、`exitCode`、`truncated` |
| `FenceDecision` | 围栏判定结论 | `verdict`（`allow` / `deny` / `unanalyzable`）、`offendingToken`、`normalizedPath`、`reason` |
| `AllowRootSet` | 允许根集合 | `projectRoot`（服务端项目根）、`sandboxTmp`（`<userData>/tmp`） |
| `CommandResult` | 工具返回值 | `exitCode`（可未知）、`output`（字节）、`cancelled`、`timedOut`、`truncatedKeeping` |
| `CommandInventory` | 设备命令能力清单（三分类） | `direct`、`toyboxOnly`、`absent`、`danglingSymlinks` |
| `ZombieBudget` | 僵尸治理的显式记账 | `spawnCount`、`resetCount`、`expectedZombies = spawnCount` |
| `HostEnvProbe` | 宿主侧环境装配结果 | `path`、`shPath`、`tmpdir`、`projectRoot`、`probeErrors[]` |

## 5. 验收场景

### 场景 1：首次命令成功（含退出码）

- **Given** 服务端宿主已就绪，项目目录已由使用者选定并授权（`specs/011-workspace-auth/`）
- **When** 模型调用 shell 工具执行 `echo hi` 后再执行 `false`
- **Then** 返回两条结果：`Exit code: 0` + `hi`；`Exit code: 1` + 空输出；且**只发生了 1 次 spawn**

### 场景 2：不依赖退出事件

- **Given** 常驻 shell 已启动
- **When** 对子进程状态持续观察
- **Then** 不出现任何依赖 `proc:exit` / `proc:close` 的代码路径；命令完成判定完全由结束哨兵行给出

### 场景 3：围栏拒绝（fail-closed）

- **Given** 项目根为 `/data/storage/el2/base/files/<project>`，沙箱临时目录为 `<userData>/tmp`
- **When** 调用 `cat /etc/hostname` 或 `echo x > /storage/Users/currentUser/Documents/a.txt`
- **Then** 在派发前即被拒绝，返回值含越界路径与不可判定原因，**且未发生审批询问**（拒绝先于审批）

### 场景 4：审批升级路径

- **Given** 围栏拒绝了一次越界写入
- **When** 调用方带着更宽范围与理由重试一次
- **Then** 触发**一次**使用者审批；获批后该次调用放行，未获批则保持拒绝

### 场景 5：不可判定构造

- **Given** 围栏默认 `enforce`
- **When** 执行 `X=/etc; cat $X/hostname` 或 `cat $(printf /etc/hostname)`
- **Then** 判定为 `unanalyzable` 并按拒绝处理（如有升级通道，走一次审批）

### 场景 6：超时与排空

- **Given** 一次命令挂起不返回
- **When** 达到超时上限
- **Then** 先排空到结束哨兵并把已产生的输出交给模型；仅当排空亦失败时才重置会话，且结果中退出码标注为未知或哨兵值

### 场景 7：输出截断不破坏会话

- **Given** 命令产生超过上限的输出
- **When** 输出超过保留上限
- **Then** 只返回前 N 字节并附 `[output truncated: kept N of M bytes]`，会话仍同步（下一条命令的哨兵不被上一条的残留污染）

### 场景 8：应用退出清理

- **Given** 常驻 shell 处于 `idle`
- **When** 触发 `before-quit`
- **Then** shell 被关闭并收到终止信号；应用退出不被等待 `exit` 事件阻塞；`resetCount` 与 `spawnCount` 被写入诊断日志

### 场景 9：降级可见

- **Given** 设备无 PTY、无 `bash` / `git` / `rg` / `curl`
- **When** 模型尝试 `bash -c ...` 或 `rg foo`
- **Then** 工具结果明确显示命令不存在（`127`），工具描述与能力清单已提前披露该限制，**未出现静默空结果**

## 6. 非功能需求

- **失败可见**：每个阶段（宿主就绪 / shell spawn / 框架注入 / 哨兵解析 / 围栏判定 / 超时 / 重置）MUST 可观测：统一日志前缀 `[oc-desktop]`，禁止「卡住但不说」（`docs/工程规划-V2.md` §5.2）。
- **字节保真**：输出按字节捕获，非 UTF-8 字节与含 NUL 的二进制输出 MUST NOT 导致调用失败。
- **幂等与可重复**：围栏与协议层 SHOULD 为无外部依赖的纯函数，可在**裸 Node** 上被单元测试直接驱动（无需设备、无需上游 bundle）。
- **性能**：常驻 shell 使单次命令的额外开销仅为框架注入与哨兵解析；spawn 次数 MUST NOT 随调用次数线性增长。
- **安全下限**：子进程继承应用沙箱、无额外特权；围栏是**工具层**判定，安全下限是「应用沙箱 + 使用者的审批裁决」，不得声称更高。
- **可维护性**：与上游的耦合面 MUST 集中于条件变体与最小改动补丁；补丁遵循 `docs/工程规划-V2.md` §6.2 的幂等规则（`git apply --reverse --check` 判据、不落在既有补丁上下文区间、追加到列表末尾、正反向往返可还原 SHA-256）。

## 7. 假设与约束

**假设**

- 假设 1 ⬜ **待验证**：本工程设备上「应用域 `spawn('/system/bin/sh')` 可用」与 dsh 真机一致（dsh 实测放行；本工程未复验）。
- 假设 2 ⬜ **待验证**：本工程设备上「子进程退出事件不触发、每次 spawn 泄漏 1 僵尸」与 dsh 真机一致。
- 假设 3 ⬜ **待验证**：`/system/bin/sh` 的身份与本工程设备一致（dsh 其设备上经 md5 比对裁定为 **mksh R59**，不是 toysh；不得用 `readlink /proc/self/exe` 或 `uname -a` 判定）。
- 假设 4 ⬜ **待验证**：上游 v2 的 shell 工具注册点与工具名（本规格按 `bash` 口径书写）可在 Phase 0 被定位，且存在可插入围栏与后端的单点（否则按 plan §2 的备选路线处置）。
- 假设 5 ⬜ **待验证**：`os.tmpdir()` 经 patch 后指向 `<userData>/tmp` 且该目录可写（`TMPDIR` 环境变量在设备上对 Node 无效，必须 patch，见 `specs/012-data-dirs-sqlite/`）。
- 假设 6 ⬜ **待验证**：项目目录授权在每次启动后仍可重复激活（Picker URI 仅临时授权，见 `specs/011-workspace-auth/`）。

**约束**

- 约束 1：**无 PTY**（L1）。交互式程序（`top` / `more` / `vi` 类）行为无法保证，本规格不承诺。
- 约束 2：**无内核沙箱**。子进程以应用 uid 运行，围栏可被绕过；残余风险必须如实记录，不得淡化。
- 约束 3：**僵尸不可能被回收**（无 `exit` 事件、无 root、无 faultlog）；治理手段只有「减少 spawn 次数」。
- 约束 4：**平台不提供执行权限**。`/system/bin/sh` 的执行由 SELinux 域 + seccomp 管辖，**不存在**可申请的执行类权限；本模块 MUST NOT 声明任何「执行 shell」权限（详见 `docs/ACL申请清单.md`）。
- 约束 5：**不随包执行自有 ELF**。用户目录与 el2 数据目录不可 exec；自有 ELF 需 AGC 二进制证书（`certType: 4`），个人主体不可得。因此命令集 MUST 限定为系统自带 `toybox` applet 与 mksh 内建。

## 8. 依赖

**上游（opencode v2.0.26）**

- `packages/core` 的 `imports` 条件变体表（`#pty` / `#persistent-pty-binary` 等）—— 本模块新增的执行后端变体与打桩变体共存于此机制。
- `packages/core/src/pty/pty.node.ts`、`packages/core/src/persistent-pty/binary.node.ts` —— 说明「为什么不能靠上游现成能力」：`#pty` 在**模块顶层**执行 `createRequire`，加载失败会中断整个 bundle 的 import（`docs/工程规划-V2.md` §2.2）。
- shell 工具的实现与注册点（Phase 0 定位，⬜）。
- `packages/server`（Effect HTTP）—— 宿主形态与生命周期绑定。

**本工程其它模块**

- `specs/011-workspace-auth/` —— 提供**项目目录**（允许根之一）与可写性前提。
- `specs/012-data-dirs-sqlite/` —— 提供**沙箱临时目录**（`os.tmpdir()` patch 结果）与宿主环境装配（`HOME` / `XDG_*` / `TMPDIR` / `PATH`）。
- `specs/007-runtime-entry/`（另建）—— 宿主形态（三候选定标）决定 shell 子进程挂在哪个宿主上；若定标为 `worker_threads`，需复核 `spawn` 在该形态下的行为（⬜）。
- `specs/201-plugin-runtime/` —— 插件在服务端进程内执行，与 shell 同权限，二者共同构成「进程内任意代码」的安全面。

**外部事实来源**

- `docs/鸿蒙环境能力清单.md`（本工程）—— 设备能力边界与根因分层的可引用版本。
- `docs/toybox命令清单.md`（本工程）—— 命令可达性三分类的事实来源。
- `docs/ACL申请清单.md`（本工程）—— 权限边界的可引用版本。
- `dsh-desktop-hos` 真机记录（转述于 `docs/工程规划-V2.md` §2.5、§3.8）—— dsh 真机来源；旧工程 `opencode-harmony` 记录 —— 沿用来源。
