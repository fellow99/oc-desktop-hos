# 应用与宿主生命周期（002-lifecycle）—— 实现方案

> **Module:** 002-lifecycle ｜ **Status:** Proposed ｜ **Last Updated:** 2026-10-11 ｜ **上游基线:** opencode v2.0.26（Branch_v2.0.26）
> 对应规格：[spec.md](./spec.md)

## 1. 技术上下文

### 1.1 运行时环境

- 主进程运行在 ArkTS UIAbility 进程内（Electron 37 / Node 22.17.0 / Chromium 138 / ABI v138）；窗口由运行时映射为 Ability（🔶 harmonypc-electron `runtime-manifest.json` 与 adapter 核实）。
- 启动入口：`src-main/main.js`（CommonJS 单文件入口，`require('electron')`）；宿主 bundle 为 ESM，由宿主入口按候选形态加载。
- 沙箱：`<userData>` = `/data/storage/el2/base/files`（hmfs，可写）；缓存目录 `/data/storage/el2/base/cache`。
- 宿主形态未定（007）→ 本模块只调用统一宿主契约，不感知候选差异。

### 1.2 依赖

| 依赖 | 版本/来源 | 用途 |
|------|-----------|------|
| `node:os` | Node 22.17.0 内置 | `tmpdir()` 覆写、`networkInterfaces()`（001 复用） |
| `node:path` / `node:fs` | 内置 | 沙箱目录构造、写入后回读校验 |
| Electron `app` | 运行时内置 | `before-quit` / `will-quit` 与窗口→退出语义 |
| `003` / `004` / `007` / `008` | 本工程模块 | 阶段判据、凭据来源、宿主契约、健康检查 |
| `docs/真机验证记录.md` | 工程文档 | 阶段耗时、僵尸与端口观测留证 |

## 2. 关键决策

| 决策 | 结论 | 依据 |
|------|------|------|
| 环境装配位置 | `src-main/main.js` 最早路径（建窗与加载宿主之前） | 宿主与 bundle 都依赖 `HOME`/`XDG_*` |
| `TMPDIR` 处理 | 设变量 + 覆写 `os.tmpdir()`（CommonJS 单例共享） | 🔶 真机变量对 Node 无效 |
| 目录可写判定 | 写入探针文件后回读校验 | 🔶 hmdfs `chmod` 静默失效 |
| 阶段模型 | 固定五阶段枚举 + 单一阶段表 | 工程规划 §5.2 时序 |
| 健康检查超时 | 30s（可配置） | 工程规划 §5.2 |
| 退出清理 | `before-quit` 与 `will-quit` 双钩、幂等 | Electron 语义；清理失败不得阻塞退出 |
| 子进程退出码 | 哨兵行解析 stdout，不用事件 | 🔶 `exit`/`close` 永不触发 |
| 宿主崩溃观测 | A/C 用退出或错误信号；B 用 `/api/info` 连续失败兜底 | 候选 B 无法自观测 |
| 2in1 后台 | v1 不做后台常驻，最小化不算后台 | 🔶 `aa dump -a` 仍 `#FOREGROUND` |
| 产物与 marker | 退出时保留 | 避免重复解压；升级交给 003 |

## 3. 数据模型

### 3.1 实体定义

阶段表（模块内常量，驱动时序与展示；超时的 ⬜ 值在实现时按实测收紧）：

| id | 判据 | 超时 | 失败处理 |
|----|------|------|----------|
| `env` | 沙箱目录可写（回读校验通过） | 5s | fail-visible |
| `artifact` | 003 的 marker 命中或解压成功 | 无上限（解压耗时未知 ⬜） | fail-visible |
| `host` | 宿主启动返回句柄（含端口） | 60s ⬜ | fail-visible |
| `health` | `GET /api/info` 200（带凭据） | 30s | fail-visible |
| `load` | 001 的首屏就绪信号 | 60s ⬜ | fail-visible |

环境映射（`bootstrapEnvironment()` 返回值）：

```js
{
  userData: '/data/storage/el2/base/files',
  vars: {
    HOME, USERPROFILE, XDG_DATA_HOME, XDG_CACHE_HOME, XDG_CONFIG_HOME,
    XDG_STATE_HOME, TMPDIR, PATH, OPENCODE_CLIENT, OPENCODE_DB,
  },
  verified: [{ name: 'TMPDIR', ok: true }],
}
```

状态机：

```
booting(env) → booting(artifact) → booting(host) → booting(health) → booting(load) → ready
任一阶段失败 → failed(stage, detail)（可 retry：从失败阶段起重推）
ready → quitting（before-quit / will-quit）→ stopped
```

### 3.2 校验规则

- 每个映射目录必须通过「写探针文件 → 读回 → 删除」三步校验；失败即 `env` 阶段失败。
- `TMPDIR` 必须等于 `<userData>/tmp`；覆写后自检 `os.tmpdir() === process.env.TMPDIR`。
- 阶段序必须单调递增；回退或跳跃视为缺陷（记日志并中断）。
- 诊断摘要必须是脱敏文本（屏蔽密码值），长度 ≤ 2500 字符。

## 4. 接口契约

### 4.1 本模块提供

| 接口 | 说明 |
|------|------|
| `bootstrapEnvironment()` | 装配沙箱环境并返回 `EnvMapping`；失败抛结构化错误 |
| `runStartupSequence(ctx)` | 顺序推进五阶段，调用 003/007/008/001 的对应入口 |
| `installShutdownHooks(host)` | 安装 `before-quit` / `will-quit` 清理（幂等） |
| `recordDiagnostics()` | 汇总 `__*Error` 为脱敏摘要 |
| `globalThis.__stageError` | 失败阶段摘要（与 `__hostError` / `__extractError` / `__renderError` 并列） |
| ArkTS 侧 | 关闭窗口即退出应用的语义，与宿主生命周期绑定（007 定标后固化） |

### 4.2 本模块消费

| 来源 | 契约 |
|------|------|
| 003-artifact-bootstrap | `ensureArtifact()` → `{ root, sha256, skipped }` |
| 007-runtime-host | `startHost()` → 宿主句柄；`shutdown(code)` 语义 |
| 008-server-ui-load | `waitHealthy({ timeoutMs })` → `{ ok, status, errorText }` |
| 004-request-hooks | 密码变量名与「已注入」事实（本模块不生成密码） |
| 001-render-channel | `openUi()` 的首屏就绪信号（`load` 阶段判据） |
| 环境变量 | `TMPDIR` / `XDG_*` / `HOME` / `PATH` / `OPENCODE_CLIENT`（本模块写入 `process.env`） |

## 5. 实现策略

### 5.1 关键算法

- **装配顺序**：解析 `userData`（运行时注入的 `--user-data-dir`）→ 计算映射表 → `mkdir -p` → 写探针文件 → 读回 → 删探针 → 设 `process.env` → 覆写 `os.tmpdir` → 自检。
- **时序推进**：`for (const stage of STAGES) { trace.start(stage); await runner[stage](); trace.ok(stage); }`，异常统一被捕获为 `failed(stage, detail)`。
- **健康轮询**：`health` 阶段以 200ms 起步、1s 上限的指数退避；同样的轮询在 `ready` 之后用于兜底检测「进程内服务是否已死」。
- **退出**：置 `quitting` 标记 → 关常驻 shell 会话 → 关宿主（按 007 定标的手段）→ 清僵尸 → `will-quit` 只做日志级兜底（不再阻塞）。

### 5.2 错误处理

- 阶段失败：写 `__stageError`、`console.error('[oc-desktop] stage=<id> ...')`、切 loading 失败态；后续阶段不执行。
- 宿主异常退出：记录 `HostExitInfo`；若已处于 `ready`，提示「服务端不可用」并允许重试（重试 = 重跑 `host → health → load`）。
- 清理异常：逐步 `try/catch`，只记日志，绝不阻塞退出。
- 覆写失败（`os.tmpdir` 不可写）：降级为「变量 + 显式把临时目录传给宿主」并在日志标注（不静默）。

### 5.3 降级

- 本模块**不做能力降级**：任一阶段失败一律 fail-visible；通道级降级（R2 → R1）属 001。
- 唯一允许「继续运行」的情形：产物校验失败但旧产物仍完整（由 003 判定并给出可见提示），此时 `artifact` 记为 `ok(degraded)` 并记录原因。

## 6. 测试与验证

### 6.1 host 侧

- 单元/离线：阶段表驱动逻辑（顺序、超时、失败短路、从失败阶段重试）、`recordDiagnostics()` 的脱敏与截断、映射表的路径构造（Windows 与设备路径两套输入）。
- 复用 `scripts/smoke-node22.mjs` 作为 `health` 阶段的 host 侧对照（同一 `GET /api/info` 断言）。
- 负例：把 `XDG_DATA_HOME` 指向只读目录，断言 `env` 阶段失败且诊断可读。

### 6.2 真机命令

```bash
hvigorw assembleHap --mode module -p product=default -p buildMode=debug --no-daemon
hdc app install -r electron/build/default/outputs/default/electron-default-signed.hap
hdc shell aa start -a EntryAbility -b org.fellow99.oc.OCDesktop

hdc shell "hilog -x | grep oc-desktop"     # 阶段与失败取证
hdc shell aa dump -a                       # 2in1 最小化 / 后台语义
hdc shell "ps -A | grep oc-desktop"        # 进程与僵尸观测（applet 可用性 ⬜ 待验证）
hdc shell "netstat -anp | grep <port>"     # 退出后端口观测（⬜ 待验证 toybox netstat 可用性）
```

- 每轮真机验证 MUST 记录：设备型号与系统版本、五阶段耗时、失败注入方式与结果，落 `docs/真机验证记录.md`。

### 6.3 验收口径

- 冷启动五阶段全绿且首屏可用；四类失败注入（产物损坏、宿主起不来、健康超时、渲染失败）各产生一次可读的 fail-visible 结论；退出后无残留进程与端口。

## 7. 文件清单

| 文件（相对工程根） | 用途 |
|--------------------|------|
| `src-main/main.js` | 环境装配、阶段时序、退出清理钩子、诊断摘要 |
| `src-main/sidecar.js` | 候选 A 的宿主入口（关闭语义由本模块调用，见 007） |
| `src-main/tar-extract.js` | `artifact` 阶段的解压实现（见 003；本模块只调用其入口） |
| `scripts/probes/host-lifecycle-probe.mjs` | 僵尸 / 端口 / 退出信号观测探针（真机侧断言清单） |
| `electron/src/main/module.json5` | `KEEP_BACKGROUND_RUNNING` 与 `backgroundModes` 声明（与行为一致） |
| `docs/真机验证记录.md` | 阶段耗时、僵尸与端口观测留证 |

## 8. 与规格的交叉引用

| 规格需求 | 落点 |
|----------|------|
| FR-002-001 ~ 009（环境装配） | `src-main/main.js`（`bootstrapEnvironment()`） |
| FR-002-010 ~ 016（启动时序） | `src-main/main.js`（`runStartupSequence()` + 阶段表） |
| FR-002-017 ~ 022（退出清理） | `src-main/main.js`（`installShutdownHooks()`）、`src-main/sidecar.js` |
| FR-002-023 ~ 029（崩溃与僵尸观测） | `src-main/main.js`、`scripts/probes/host-lifecycle-probe.mjs` |
| FR-002-030 ~ 033（2in1 语义） | `electron/src/main/module.json5`、`docs/鸿蒙环境能力清单.md` |
