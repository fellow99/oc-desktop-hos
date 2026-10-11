# 宿主形态（007-runtime-host）—— 实现方案

> **Module:** 007-runtime-host ｜ **Status:** Proposed ｜ **Last Updated:** 2026-10-11 ｜ **上游基线:** opencode v2.0.26（Branch_v2.0.26）
> 对应规格：[spec.md](./spec.md)
> **说明**：本方案是「三候选并存 + 探针定标」的**方案骨架**，不含定标结论；定标后的收敛实现以 P0-1 结论回写本文件。

## 1. 技术上下文

### 1.1 运行时环境

- 应用进程：ArkTS UIAbility 进程内 `runBrowser`（Electron 37.2.0 / Node 22.17.0 / Chromium 138 / ABI v138）。
- 子进程模型：运行时的子进程走 `childProcessManager.startArkChildProcess`（`CustomChildProcess extends ChildProcess` → `nativeContext.runArkProcess`），**不是 fork/exec**，默认带 `--no-zygote`（🔶 harmonypc-electron 文档核实）→ utility 候选的可行性不能套用常规 Electron 经验。
- `worker_threads`：Node 内建线程，运行在同一进程内（🔶 dsh 用其跑 CLI 负载验证过 JIT 可用、无需证书与额外权限）。
- 已登记冲突：⚠️ 应用域子进程 JIT 被 seccomp 拦（SIGSYS）与「utility 无任何验证数据」（见 spec §7.1/§7.2）。
- 权限前提：JIT 相关受限权限 `ohos.permission.kernel.ALLOW_WRITABLE_CODE_MEMORY`（见 006）；其是否对 worker/utility 同样必需 ⬜ 待验证。

### 1.2 依赖

| 依赖 | 版本/来源 | 用途 |
|------|-----------|------|
| Electron `utilityProcess` | 运行时内置 | 候选 A 的进程创建（可用性 ⬜） |
| Node `worker_threads` | Node 22.17.0 内置 | 候选 C |
| `node:child_process` | 内置 | 探针 ②③（异步/同步 spawn）与哨兵行 |
| `003-artifact-bootstrap` | 本工程 | `bundlePath` 契约 |
| `008-server-ui-load` | 本工程 | argv/env 契约与 ⑤ 项外部访问断言 |
| `006-signing-identity` | 本工程 | JIT 权限状态（解释 ① 结果） |
| `scripts/probes/host-probe.mjs` | 本工程 | 矩阵驱动与记录产出 |

## 2. 关键决策

| 决策 | 结论 | 依据 |
|------|------|------|
| 是否预设宿主形态 | **不预设**；三候选并存 + P0-1 定标 | 工程规划 §3.2（⚠️ 冲突 C1/C2） |
| 定标顺序 | A → B → C（spec §3.3 规则） | 隔离性优先，其次已验证形态，最后兜底 |
| 契约 | 统一 `HostHandle`，下游零改动 | 把形态差异关在本模块内 |
| 装配逻辑 | 单一函数（env/argv + `import(bundle)`） | 避免三份实现语义漂移 |
| 入口文件 | `src-main/sidecar.js` 同时作为 A 与 C 的宿主入口，B 复用装配函数 | 不改动工程规划的 `src-main/` 文件清单 |
| 运行期切换 | 不自动切换候选 | 形态是定标期决策；运行期只做 fail-visible 与重试 |
| 退出码获取 | 哨兵行解析 stdout | 🔶 `exit`/`close` 永不触发 |
| B 的代价 | 「宿主崩溃 = 应用级崩溃」必须登记 | 工程规划 §3.2 |
| C 的纪律 | 以 B 的进程管理纪律执行 | 同上 |
| sidecar 未启用时 | 保留实现并标注「未启用」 | 回归/备选复用 |
| 探针落点 | `scripts/probes/host-probe.mjs` + `docs/真机验证记录.md` | 工程规划 §10 P0-1 |

## 3. 数据模型

### 3.1 候选定义（常量表，供实现与文档共用）

| id | 创建方式 | 关闭方式 | 退出观测 | 已知限制 |
|----|----------|----------|----------|----------|
| A | `utilityProcess.fork(sidecarPath, [], { env, stdio })` | `child.kill()`（若不可用则按运行时手段） | 子进程退出事件/退出码（⚠️ 事件可靠性待探针 ②） | JIT 与 bundle 加载**未验证**；子进程可能受 seccomp 限制 |
| B | 主进程内 `await import(bundlePath)` | 服务端 `shutdown` / 关闭监听 | **无法自观测** → `/api/info` 连续失败兜底 | 宿主崩溃 = 应用级崩溃；不能靠事件收尸 |
| C | `new Worker(sidecarPath, { workerData })` | `worker.terminate()` | worker `error`/`exit` | 不能 `process.chdir`；共享进程内存；`import` 大 bundle 的内存峰值 ⬜ |

### 3.2 探针矩阵结构

```js
{
  device: '<型号>', os: '<HarmonyOS 版本>', runtime: 'Electron 37.2.0 / Node 22.17.0 / Chromium 138 / ABI v138',
  rows: [
    { candidate: 'A', item: 1, title: 'JS/JIT 示性', result: 'pass|fail|partial',
      errorText: '<Signal 31 (core dumped) | ...>', evidence: '<日志行 / globalThis 摘要>', durationMs },
    // ... 3 × 5
  ],
  decision: { chosen: 'A|B|C', rule: 1|2|3, rejected: [{ candidate, item, errorText }], decidedAt },
}
```

### 3.3 状态转换

```
idle → probing（逐候选逐项执行）→ matrixReady → deciding → decided(chosen)
                     └─ 探针自身异常 → probeError（记录并继续下一项，不掩蔽）
decided → 收敛实现（把非选定候选标为未启用）→ verify（回归：下游代码零改动）
```

### 3.4 校验规则

- 每项必须给出 `result`；`fail`/`partial` 必须带 `errorText`；禁止空结论。
- 候选 ⑤ 项的判定必须来自**进程外部的 HTTP 请求**（用局域网 IP），不能用宿主内自测代替。
- ①②③ 必须分开记录「事件是否触发」与「是否拿到结果」，不得合并为一句「spawn 正常/异常」。
- ④ 项必须记录耗时与内存占用数值（可为近似值，但不得留空）。

## 4. 接口契约

### 4.1 本模块提供

| 接口 | 说明 |
|------|------|
| `startHost({ bundlePath, argv, env, cwd })` | 统一入口；内部按定标候选分派（未定标时可按探针参数指定候选） |
| `HostHandle` | `{ kind, port, url, shutdown(code), onExit(cb) }` |
| `assembleHostEnv(argv, env)` | 单一装配函数：合并环境、设置 `process.argv`、返回待启动参数 |
| `runProbeMatrix()` | 执行 3 × 5 探针并返回 `ProbeMatrix`（含决策建议但不写结论） |
| `globalThis.__hostError` / `__hostExit` | 宿主启动失败摘要与退出信息落点 |
| 探针可视化 | 失败/结果文本可在 loading 页查看（复用 001 的阶段文本通道），并落盘到 `<userData>` 供取回 |

### 4.2 本模块消费

| 来源 | 契约 |
|------|------|
| 003-artifact-bootstrap | `artifactRoot()` → `<userData>/opencode-dist/opencode.mjs` |
| 008-server-ui-load | `argv`（`serve --hostname 0.0.0.0 --port <随机>`）与 env 集合；`GET /api/info` 断言 |
| 002-lifecycle | 阶段时序（`host`/`health`）、退出钩子、哨兵行纪律 |
| 004-request-hooks | 凭据（⑤ 项与健康检查需要 `Authorization`） |
| 006-signing-identity | JIT 权限是否获批（解释 ① 项结果） |
| 运行时 | `utilityProcess`（A）、`worker_threads`（C）、`app.commandLine`（端口相关） |

## 5. 实现策略

### 5.1 关键算法

- **候选 A**：
  ```js
  const child = utilityProcess.fork(sidecarPath, [], {
    env: assembleHostEnv(argv, env), serviceName: 'opencode-host', stdio: 'pipe',
  })
  // 端口由宿主内服务端回传：约定 sidecar 通过 stdout 打印 `__OC_PORT=<n>` 哨兵行
  ```
  ⬜ 待验证：`utilityProcess.fork` 在本运行时可用；若不可用，A 直接判否决（记入矩阵）。
- **候选 B**：主进程内 `await import(pathToFileURL(bundlePath).href)`（`process.argv` 已被装配函数设置），成功后从服务端返回值/`/api/info` 获取端口。
- **候选 C**：
  ```js
  const worker = new Worker(sidecarPath, { workerData: { bundlePath, argv, env } })
  // 端口经 worker 的 postMessage（`{ type: 'port', value }`）回传
  ```
- **端口回传统一**：无论候选，宿主 MUST 通过「哨兵行（stdout）/ postMessage / 直接返回值」把**实际端口**交回主进程，主进程不推断端口。
- **收尸**：主进程维护「宿主 + 常驻 shell」清单，退出时按「先关宿主、后关 shell」顺序处理；不使用 `exit`/`close` 事件做判据，必要时用 `/proc` 与哨兵行核对。
- **崩溃兜底**：A/C 订阅退出信号；B 由 002 的 `health` 守卫做连续失败计数兜底（阈值与间隔在 002 的阶段表中定义）。

### 5.2 错误处理

- 候选创建失败（`utilityProcess` 不存在、`Worker` 构造抛错）→ 记 `__hostError` 并把该项标 `fail`（带错误首行）。
- `import(bundle)` 抛错 → 记录扁平化错误链（`AggregateError` 递归 + `cause`，深度 ≤ 6，截断 ≤ 2500 字符），标 ④ 项 `fail`。
- 探针某项自身异常 → 记录后继续下一项（不因单项异常丢失整张矩阵）。
- 定标后非选定候选的入口 MUST 保留但不可达（构建期开关或运行期常量门控）。

### 5.3 降级

- 候选降级 = 定标规则（A → B → C），**发生在 Phase 0 而非运行期**。
- 运行期唯一降级：宿主崩溃 → fail-visible 并允许「重试（重跑 host → health → load）」；不自动切换候选。

## 6. 测试与验证

### 6.1 host 侧

- **契约测试**：用假的宿主实现（stub）验证 `002`/`008`/`001` 只依赖 `HostHandle` 字段；断言切换 `kind` 时调用方代码零改动。
- **装配函数单测**：`assembleHostEnv()` 产出 `process.argv`、env 合并顺序（沙箱 env < 启动参数 env）、`OPENCODE_PASSWORD` 存在性，并断言不打印密码。
- **矩阵结构校验**：`runProbeMatrix()` 在 host 上用 Node 22.17 跑「B 的等价形态」（主进程内 import + `serve 127.0.0.1:4096`）与「C 的等价形态」（Node `worker_threads` 内 import + `serve`），断言矩阵 3 × 5 结构完整、`fail` 项带 `errorText`。**host 侧结果不代表设备结论**，仅用于排除代码缺陷。
- **哨兵行解析单测**：`sh -c '<cmd>; echo "__RC=$?"'` 的输出解析（含多行输出、末尾无换行、非零退出码）。

### 6.2 真机命令

```bash
hdc app install -r electron/build/default/outputs/default/electron-default-signed.hap
hdc shell aa start -a EntryAbility -b org.fellow99.oc.OCDesktop

# 探针触发与取证
hdc shell "hilog -x | grep oc-desktop"        # 矩阵行与失败原文
hdc fport tcp:19229 tcp:9229                  # debug 构建：CDP 中触发探针与查看 globalThis
# ⑤ 项必须由外部发起（局域网 IP + 凭据）
curl -u "<user>:<pass>" http://<设备局域网IP>:<port>/api/info

# 结果取回（⬜ 待验证：应用域目录可读性 / hdc file recv 可用性）
hdc file recv /data/storage/el2/base/files/host-probe.json ./host-probe.json
```

- 真机 MUST 记录：3 × 5 矩阵、每候选的否定/通过依据、内存与耗时数值、设备与运行时版本，落 `docs/真机验证记录.md`；定标结论同时回写本目录与工程规划 §3.2/§11.1。

### 6.3 验收口径

- 矩阵齐备且可复核；定标结论符合 spec §3.3 的规则并带否决依据；下游模块代码零改动；宿主崩溃在三个候选下各有可观测路径（A/C 有退出信息，B 有兜底信号）。

## 7. 文件清单

| 文件（相对工程根） | 用途 |
|--------------------|------|
| `src-main/main.js` | 宿主契约、候选分派、候选 B 实现、崩溃兜底、`__hostError` / `__hostExit` |
| `src-main/sidecar.js` | 候选 A 与 C 的共用宿主入口（env/argv 装配 + `import(bundle)` + 端口哨兵行/postMessage） |
| `scripts/probes/host-probe.mjs` | P0-1 五项探针驱动、矩阵产出与记录 |
| `docs/真机验证记录.md` | 矩阵与定标结论落点 |
| `docs/鸿蒙环境能力清单.md` | 「应用域子进程 JIT（SIGSYS）」「utility 无验证数据」「worker_threads 可用性」条目 |
| `specs/007-runtime-host/{spec.md,plan.md}` | 本模块规格与方案（定标后回写） |

## 8. 与规格的交叉引用

| 规格需求 | 落点 |
|----------|------|
| FR-007-001 ~ 005（宿主抽象与候选登记） | `src-main/main.js`（`startHost` / `HostHandle`）、本规格 §1.1 候选表 |
| FR-007-006 ~ 010（P0-1 探针） | `scripts/probes/host-probe.mjs`、`src-main/main.js`（探针触发）、`docs/真机验证记录.md` |
| FR-007-011 ~ 015（决策规则与结论落点） | `docs/真机验证记录.md`、本目录 `spec.md`/`plan.md`、工程规划 §3.2/§11.1 回写 |
| FR-007-016 ~ 020（崩溃、退出与收尸） | `src-main/main.js`（`onExit` / 兜底轮询）、`002-lifecycle` 的退出钩子 |
| FR-007-021 ~ 023（sidecar 与共用装配） | `src-main/sidecar.js`、`src-main/main.js`（`assembleHostEnv`） |
