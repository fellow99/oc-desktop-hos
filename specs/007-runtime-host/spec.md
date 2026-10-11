# 宿主形态（007-runtime-host）—— 规格

> **Module:** 007-runtime-host ｜ **Status:** Proposed ｜ **Last Updated:** 2026-10-11 ｜ **上游基线:** opencode v2.0.26（Branch_v2.0.26）

## 1. 模块概述

### 1.1 目的（Why this module exists）

定义承载 opencode v2 服务端 bundle 的**宿主（host）抽象**，并把「宿主到底跑在哪种进程形态里」这一**结构性未知**交给 Phase 0 的 **P0-1 探针**裁决。本规格并列登记三个候选、五项测项、决策规则与结论落点：

| 候选 | 机制 | 已知证据 |
|------|------|----------|
| **A. utility 进程** | `utilityProcess.fork(src-main/sidecar.js)`，sidecar 内装配 env/argv 后 `import(<bundle>)` 并 `serve` | 旧工程：utility 内 `spawnSync('sh')` exit 0（🔶）；dsh：**utilityProcess 能否跑 Node 无任何验证数据**，且应用域 fork 出的 node 脚本 SIGSYS（✅）→ **生死未知** |
| **B. 主进程进程内** | `main.js` 内直接 `import(<bundle>)` 并按 CLI 语义 `serve` | dsh 的 Host 即此形态，**已在真机长期运行**（✅）；代价「宿主崩溃 = 应用级崩溃」 |
| **C. `worker_threads`** | 主进程内 `new Worker(src-main/sidecar.js)` 跑 bundle | dsh 用同机制在进程内跑 pnpm CLI：**JIT 可用、无证书、无新权限、`process.exit` 只退 worker**（✅）；代价：worker 内不能 `process.chdir`、与主进程共享进程内存 |

**本规格不预设结论**（工程规划 §3.2 明确「不预先拍板」）。

### 1.2 解决的问题（What pain points it addresses）

- **最高风险 R1**：若宿主形态选错，opencode 服务端根本起不来（界面永远停在 `host` 阶段失败），因此必须在写业务逻辑之前问清楚。
- **两份一手材料结论互斥**：⚠️ 冲突 C1/C2/C3（见 §7）。不裁决就只能靠猜，且任一侧的结论都会误导架构。
- **冲突证据必须登记**：应用域子进程 **JIT 被 seccomp 拦（`Signal 31` / SIGSYS）** 是原始观测事实，直接决定「utility 进程（本身是子进程）内能否 JIT」；不登记就无法复核结论。
- **形态差异会渗透到业务代码**：崩溃后果、退出清理、子进程管理纪律都随候选变化 → 必须有统一宿主契约把差异关在本模块内。
- **观测能力受限**：无 root、faultlog 不可读、🔶 应用域与 shell 域可见性不同 → 探针必须自证并落文档。

### 1.3 范围（Scope）

**包含**：

- 三候选的定义、机制、已知证据与未验证项（并列登记，不预设结论）；
- 统一宿主契约（`start` → 句柄 `{ kind, port, url, shutdown, onExit }`）与「下游零改动」要求；
- P0-1 五项探针的测项定义、观测口径、记录字段、真机矩阵与出口判据；
- 决策规则（A → B → C）与结论落点（`docs/真机验证记录.md` + 本规格目录）；
- 崩溃 / 退出可观测性要求与「不得依赖 `exit`/`close` 事件」的收尸纪律；
- `src-main/sidecar.js` 的定位（A 与 C 的共用宿主入口；若未启用则保留）。

**不包含**：

- 服务端 `argv`/env 的具体取值与健康检查接口（见 `008-server-ui-load`）；
- 启动阶段时序与退出钩子编排（见 `002-lifecycle`）；
- 渲染通道（见 `001-render-channel`）；
- JIT 受限权限的申请流程（见 `006-signing-identity`；本模块只消费其授予结果）。

## 2. 用户故事

- 作为用户，我希望无论服务端跑在哪种宿主里，界面的行为完全一致（不需要我知道进程形态）。
- 作为研发，我希望能用一次探针把「哪种宿主可用」问清楚，且结论可复核、带原始失败证据。
- 作为研发，我希望宿主崩溃/挂掉能被观测到，而不是表现为界面卡死。
- 作为研发，我希望定标切换候选时，`002-lifecycle` / `008-server-ui-load` 的调用代码零改动。
- 作为评审者，我希望冲突证据（两套互斥结论与 SIGSYS 现象）被原样登记，而不是被选择性引用。

## 3. 功能需求

### 3.1 宿主抽象与候选登记

- FR-007-001 系统 MUST 提供统一宿主契约 `start({ bundlePath, argv, env, cwd })` → 句柄 `{ kind, port, url, shutdown(code), onExit(cb) }`；调用方（002/008/001）MUST NOT 感知候选差异。
- FR-007-002 本规格 MUST 并列登记三候选（A/B/C）且**不对任一候选预设结论**；每个候选 MUST 登记「机制 + 已知证据 + 未验证项」。
- FR-007-003 三候选的实现 MUST 可**并存**于工程内（共用装配逻辑 + 各自入口），使定标后的切换成本最小，且切换 MUST NOT 改变宿主契约。
- FR-007-004 规格与文档中的候选表述 MUST 区分「已知证据（✅/🔶）」与「未验证（⬜）」；MUST NOT 把部分现象表述为结论。
- FR-007-005 系统 MUST NOT 在运行时自动切换候选（形态是构建/定标期决策）；运行时的失败处理只有 fail-visible 与重试。

### 3.2 P0-1 探针（五项 × 三候选）

- FR-007-006 探针 MUST 对三候选**各跑五项**，产出「候选 × 项」真机矩阵：
  1. **JS/JIT 示性**：`new Function` + 计算密集递归，观察是否 `SIGSYS`（`Signal 31`）或其它中断；
  2. **异步 `spawn("/system/bin/sh", ["-c", "echo hi"])`**：**分别观察** stdout 输出与 `exit`/`close` 事件是否触发；
  3. **`spawnSync` 同命令**：观察是否同步返回（`status`/`stdout`）或被阻塞；
  4. **`import(<bundlePath>)`**：加载成功/失败、内存占用（`process.memoryUsage()`）、耗时；
  5. **监听 `0.0.0.0` + 外部访问**：以局域网 IP 请求 `GET /api/info`（带凭据）并记录状态码与响应。
- FR-007-007 每项 MUST 记录：结论（`pass`/`fail`/`partial`）、失败原文（信号名、退出码、错误首行）、证据（日志行 / `globalThis` 摘要 / 外部请求结果）、设备与运行时版本。
- FR-007-008 探针 MUST NOT 依赖 root / faultlog；观测点 MUST 为应用域（🔶 应用域与 shell 域的可见性不同，shell 侧结论不可直接采信）。
- FR-007-009 探针 MUST 与业务主流程解耦（可单独触发），但 MUST 复用统一日志前缀 `[oc-desktop]` 与诊断落点，使取证命令一致。
- FR-007-010 探针结果 MUST 可在设备本机获取（界面文本或落盘文件），使 `hdc` 能取回；⬜ 待验证：`hdc file recv` 与应用域目录可读性，验证方式：真机做一次取回实验。

### 3.3 决策规则与结论落点

- FR-007-011 定标 MUST 按以下顺序执行：
  1. 若 **A** 的「进程内 JS/JIT（①②③）+ 加载 bundle（④）+ 起 HTTP 服务（⑤）」全绿 → **选 A**（隔离性最好：sidecar 崩溃不带走 UI，且与旧工程路径一致）；
  2. 否则若 **B** 全绿（重点 ①④⑤）→ **选 B**（dsh 已验证形态），同时登记其代价并采用「常驻单 shell + 哨兵行」的子进程纪律；
  3. 否则 → **选 C**，并以 B 的进程管理纪律执行。
- FR-007-012 每个被否决的候选 MUST 记录否决依据（哪一项失败、失败原文），MUST NOT 只写「不可用」。
- FR-007-013 无论定标结果如何，服务端 MUST **只在一个宿主内运行**，其生命周期 MUST 与 `before-quit` / `will-quit` 绑定，且失败 MUST fail-visible。
- FR-007-014 定标结论 MUST 同时写入 `docs/真机验证记录.md` 与 `specs/007-runtime-host/`（本规格集把该模块定名为 `007-runtime-host`；工程规划 §3.2 提到的记录落点以本目录为准），且 MUST 包含：选定候选、规则条目、否决依据、设备与运行时版本、执行日期。
- FR-007-015 定标后 MUST 回写工程规划 §3.2/§11.1（R1）的处置状态与 `docs/鸿蒙环境能力清单.md` 的对应条目。

### 3.4 崩溃、退出与收尸可观测性

- FR-007-016 宿主 MUST 提供可观测的退出信号：候选 A 记录子进程退出码/信号；候选 C 监听 worker `error`/`exit`；候选 B **无法自观测** → MUST 用「带凭据的 `GET /api/info` 连续失败 N 次」兜底（N 与间隔由 002 的阶段/守卫定义）。
- FR-007-017 宿主 MUST NOT 依赖子进程 `exit`/`close` 事件做收尸或读取退出码（🔶 真机永不触发）；需要退出码时 MUST 用哨兵行（`sh -c '<cmd>; echo "__RC=$?"'`）从 stdout 解析。
- FR-007-018 宿主 MUST 在退出时清理自身创建的全部子进程与僵尸并释放端口；清理 MUST 幂等。
- FR-007-019 宿主崩溃 MUST NOT 被静默重试掩盖：MUST 产生 `HostExitInfo` 并在日志/界面提示（由 002 展示）。
- FR-007-020 宿主句柄 MUST 暴露 `port`（实际端口）供 001/004/008 使用；MUST NOT 依赖固定端口。

### 3.5 sidecar 与共用装配逻辑

- FR-007-021 `src-main/sidecar.js` MUST 作为候选 A 与候选 C 的**共用宿主入口**（同一「env/argv 装配 + `import(bundle)`」逻辑）；候选 B 复用同一装配函数并在主进程内调用。
- FR-007-022 若最终定标非 A，`src-main/sidecar.js` MUST 保留实现并在文档中标注「未启用」（回归或备选时可复用），MUST NOT 删除。
- FR-007-023 三个候选 MUST NOT 各自实现一份 env/argv 装配（避免语义漂移）；装配逻辑 MUST 是单一函数。

## 4. 关键实体

| 实体 | 说明 | 关键属性 |
|------|------|----------|
| 宿主候选（HostCandidate） | 三候选之一 | `id`(`A`/`B`/`C`)、`mechanics`、`knownEvidence[]`、`unverified[]` |
| 探针项（ProbeItem） | P0-1 单项定义 | `index`(1..5)、`title`、`howToObserve`、`passCriteria` |
| 探针矩阵（ProbeMatrix） | 候选 × 项的结果集 | `device`、`runtime`（Electron/Node/Chromium/ABI）、`rows[]`(`candidate`,`item`,`result`,`errorText`,`evidence`) |
| 宿主句柄（HostHandle） | 统一对外契约 | `kind`(`A`/`B`/`C`)、`port`、`url`、`shutdown(code)`、`onExit(cb)` |
| 宿主退出信息（HostExitInfo） | 崩溃/正常退出记录 | `kind`(`clean`/`crash`/`unknown`)、`code`、`signal`、`at`、`evidence` |
| 定标决策（HostDecision） | 结论与依据 | `chosen`、`rule`（§3.3 第几条）、`rejected[]`、`decidedAt`、`device` |

## 5. 验收场景

### 场景 1：探针矩阵齐备

- Given 设备已安装 debug HAP、产物已就位（003）
- When 依次在 A/B/C 三个宿主内执行五项探针
- Then 产出 3 × 5 矩阵，每格含结论、失败原文与证据；矩阵落 `docs/真机验证记录.md`

### 场景 2：A 全绿 → 定标 A

- Given A 的 ①②③④⑤ 全为 `pass`
- When 应用决策规则
- Then 选定 A；结论含规则条目「规则 1」；`specs/007-runtime-host/` 与本规格同步更新；B/C 记为「未采用（无需否决依据）」

### 场景 3：A 部分失败 → 评估 B

- Given A 在 ①（JIT 示性，SIGSYS）或 ④（加载 bundle 失败）或 ⑤（无法起服务）失败
- When 应用决策规则
- Then 记录 A 的否决依据（失败项 + 原文），继续评估 B

### 场景 4：B 全绿 → 定标 B 并登记代价

- Given A 被否决、B 的 ①④⑤ 全绿
- When 应用决策规则
- Then 选定 B；规格与 `docs/鸿蒙环境能力清单.md` 登记「宿主崩溃 = 应用级崩溃」代价与「常驻单 shell + 哨兵行」纪律

### 场景 5：A/B 均失败 → 定标 C

- Given A 与 B 均被否决（例如 ④ 加载失败或 ⑤ 起服务失败）
- When 应用决策规则
- Then 选定 C；登记 worker 的限制（不得 `process.chdir`、共享进程内存）与「以 B 的进程管理纪律执行」

### 场景 6：冲突证据原样登记

- Given 探针在应用域子进程内复现 JIT 失败
- When 撰写结论
- Then 矩阵中给出原始现象（信号名/退出码 + 命令），并在 §7 冲突表中与该现象互相引用，MUST NOT 只写结论性描述

### 场景 7：宿主崩溃可观测（三候选各自路径）

- Given 宿主被外部终止或抛出未捕获异常
- When 观测退出信号或健康检查连续失败
- Then 产生 `HostExitInfo` 并在日志可见；A/C 有退出信息，B 有兜底信号（连续失败计数）

### 场景 8：契约不变性

- Given 定标结论从 B 改为 C（假设回归）
- When 切换实现
- Then `002-lifecycle` / `008-server-ui-load` / `001-render-channel` 的调用代码零改动（仅宿主实现切换）

## 6. 非功能需求

- **性能**：宿主启动耗时、`import(bundle)` 耗时与内存占用 MUST 被测量并记录（⬜ 实测值待采集）；候选 C 与 A 会各有一份额外堆内存（记录实际值）。
- **可靠性**：宿主启动失败不得静默；崩溃可观测；退出清理幂等；不依赖不可靠的进程事件。
- **可维护性**：统一宿主契约 + 单一装配函数 + 三入口并存；结论与依据必须文档化，使后续替人复核可行。
- **安全性**：不新增权限申请（JIT 权限由 006 负责）；不依赖 ELF 执行；密码不落盘（004）；宿主不额外开放网络监听面（只占一个端口）。
- **幂等性**：重复 `start()`/`shutdown()`、重复清理无副作用；探针可重复执行且结果稳定（同设备同环境）。

## 7. 假设与约束

### 7.1 ⚠️ 冲突登记（必须原样保留，不得选择性引用）

| 冲突 | 旧工程 opencode-harmony（🔶） | dsh-desktop-hos（✅ 真机） | 本模块处置 |
|------|-------------------------------|----------------------------|------------|
| **C1** | 主进程 `spawn` 挂起至 watchdog、`spawnSync` 卡死整进程 → 服务端必须放 utility 进程 | 主进程内运行 Host 与 bash 工具**可用**；挂起根因是「子进程 exit/close 事件永不触发」，阻塞式 `spawnSync` 反而能拿到结果 | 视为**同一现象的不同解读**（挂起 ≠ 不可用）：P0-1 用 ①②③ 分别测「异步事件 / 同步等待 / JIT」 |
| **C2** | utility 进程内 `spawnSync` 正常 → utility 可跑服务端 | **「utilityProcess 能否跑 Node 无任何验证数据」**，且应用域 fork 出的 node 脚本 SIGSYS | P0-1 第 ①④⑤ 项在 utility 内定生死 |
| **C3** | 服务端跑在 sidecar（子进程）内 | **应用域子进程 JIT 被 seccomp 拦** | 同 C1/C2；登记为最高风险（工程规划 R1） |

### 7.2 直接观测证据（原文登记）

🔶 **应用域子进程 JIT 被 seccomp 拦（SIGSYS）**：`node -e …`、`node x.js`、`node --jitless -e`、`npm -v` → **`Signal 31 (core dumped)`（SIGSYS）**；而 `node -v` / `--v8-options` 正常、`python3 -c` 正常 → **子进程无法分配 JIT 可执行内存**；`danger-full-access` 后不变（非文件沙箱）。

### 7.3 其它假设与约束

- 假设 🔶：`fork` + `execve` + PATH 查找在 2in1 / API 24 上放行（可执行 `/system/bin/sh`、`/system/bin/toybox`）；而**应用域 fork 出的 node 脚本**受 seccomp 限制。
- 假设 ✅：`worker_threads` 机制可用于在进程内跑 CLI 类负载（dsh 用其跑 pnpm CLI：JIT 可用、无需证书、无需新权限、`process.exit` 只退 worker）；本工程 bundle 为 opencode v2 服务端，⬜ 待验证。
- 约束：本运行时子进程走 `childProcessManager.startArkChildProcess`（`CustomChildProcess extends ChildProcess` → `nativeContext.runArkProcess`），**不是 fork/exec**，默认带 `--no-zygote`（🔶 文档核实）→ utility 候选的可行性不能按 Chromium/Node 常规经验推断。
- ⬜ 待验证：`utilityProcess.fork` 在本运行时是否可用（验证方式：P0-1 在 A 内执行 ①②③④⑤）。
- ⬜ 待验证：`worker_threads` 的 JIT 是否同样依赖 `ohos.permission.kernel.ALLOW_WRITABLE_CODE_MEMORY`（若依赖，则 006 的 ACL 结果直接决定 B/C 可行性；验证方式：权限获批/未获批两种状态下各跑一次 ①）。
- ⬜ 待验证：worker 内 `import` 大型 ESM bundle 的可行性与内存峰值（验证方式：P0-1 第 ④ 项记录耗时与 `process.memoryUsage()`）。
- ⬜ 待验证：候选 A 内 `import` 的模块解析基准（utility 进程的 `__dirname` / `import.meta.url` 行为；验证方式：sidecar 打印路径到日志）。
- 约束：MUST NOT 预设结论；MUST NOT 把探针结论只留在会话里（必须落 `docs/真机验证记录.md` 与本规格目录）。
- 约束：MUST NOT 新增权限申请、MUST NOT 依赖 ELF 执行、MUST NOT 引入多宿主并发。

## 8. 依赖

**上游（被本模块消费）**：

- opencode v2 bundle 的 ESM 形态与「以 CLI 语义启动」的约定（`serve` 的具体 argv/env 由 `008-server-ui-load` 定义）；
- ✅ `ServerProcess.start` 的 `{address, shutdown}` 形态（作为「宿主内如何拿到端口与关闭句柄」的参考）。

**本工程（被本模块消费）**：

- `003-artifact-bootstrap`：`<userData>/opencode-dist/opencode.mjs` 的路径契约；
- `008-server-ui-load`：启动契约（argv/env）与健康检查实现（P0-1 第 ⑤ 项复用）；
- `002-lifecycle`：阶段时序、退出钩子与「常驻单 shell + 哨兵行」纪律；
- `006-signing-identity`：JIT 受限权限的授予状态（影响 ① 的结果解释）。

**下游（消费本模块）**：

- `002-lifecycle`（宿主生命周期与退出清理）、`008-server-ui-load`（宿主内启动服务端）、`001-render-channel`（宿主提供端口/URL）、`004-request-hooks`（作用域端口来源）。
