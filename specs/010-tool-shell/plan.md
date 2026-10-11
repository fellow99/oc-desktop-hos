# 010-tool-shell 技术方案（plan）

> 模块：010-tool-shell ｜ 对应规格：[spec.md](./spec.md) ｜ Last Updated: 2026-10-11
> 上游基线：opencode `v2.0.26`（`Branch_v2.0.26` / `9b4ec5714d`）｜ 证据口径：✅ 实测 ／ 🔶 沿用 ／ ⬜ 待验证

## 1. 技术上下文

| 项 | 值 | 来源 |
|---|---|---|
| 运行期 | Electron 37（`v37.2.3-20260825.1`）= Node **22.17.0** / Chromium 138 / ABI v138 | `docs/工程规划-V2.md` §3.4 ✅ |
| 服务端形态 | stock CLI bundle：宿主内 `import("dist-node/opencode.mjs")` + `argv = ["node","opencode.mjs","serve","--hostname","0.0.0.0","--port","<随机>"]` | 同上 §3.5 ✅ |
| 宿主形态 | **三候选待裁决**：① utility 进程 ② 主进程进程内 ③ `worker_threads`（Phase 0 P0-1） | 同上 §3.2 ⬜ |
| 设备侧 shell | `/system/bin/sh` = **mksh R59**（非 toysh）；`toybox` 0.8.12 | dsh 真机 ✅（本工程 ⬜ 复验） |
| 执行可行性 | `fork` + `execve` + 管道 + PATH 查找放行；`/system/bin/sh`、`/bin/sh`、`/system/bin/toybox` 可 spawn | dsh 真机 ✅（本工程 ⬜ 复验） |
| PTY | **平台级不可用**（SELinux 拒 `forkpty`/`openpty`/`posix_openpt`/`popen`，`EACCES`；无官方应用级 API） | dsh 真机 ✅（本工程 ⬜ 复验） |
| 子进程退出 | 事件序列只有 `proc:spawn → stdout:end → stderr:end → stdout:close`；`proc:exit`/`proc:close` 从不触发；`cp.exec` 永不回调；每 spawn 净 +1 僵尸 | dsh 真机 ✅（本工程 ⬜ 复验） |
| 构建期 | Windows 宿主机 Node + `bun`（构建上游 bundle）；`bun`/`hvigorw` 的 `.bat` 需经 `cmd /c`；MSYS 下 `MSYS_NO_PATHCONV=1` | 同上 §6.4 🔶 |

**依赖**

| 依赖 | 来源 | 用途 |
|---|---|---|
| `node:child_process` | Node 22.17.0 内置 | `spawn` 常驻 shell（**禁** `exec`/`execFile`） |
| `node:path` | Node 内置 | 围栏的词法归一化 |
| `node:crypto` | Node 内置 | 每次调用一次性 token |
| 上游 shell 工具实现与注册点 | `../opencode`（`packages/core`，⬜ 位置待定位） | 工具身份、参数与结果渲染的宿主 |
| `#pty` / `#persistent-pty-binary` `ohos` stub | 本工程补丁 `0003-runtime-stubs-ohos`（`docs/工程规划-V2.md` §6.2） | 先决条件：不加载 glibc `.node`、不拖垮 bundle import |

## 2. 关键决策

| # | 决策 | 备选与理由 | 状态 |
|---|---|---|---|
| D1 | 后端为**非 PTY 常驻单 shell**，完成判定用哨兵行 | 备选「一命令一 spawn + 等退出」被否：退出不可观测 + 僵尸线性泄漏（FR-010-013/014/015） | 已决策 |
| D2 | 后端以 `ohos` 条件变体提供，**不改动上游 `node` 变体** | 备选「直接改 `node` 变体」被否：破坏 `git apply --reverse --check` 幂等与上游可追溯性（§6.2 规则） | 已决策 |
| D3 | 交付形态：候选补丁 **`0006-shell-fence`**（`patches/v2.0.26/`），在 shell 工具注册点前插入围栏与后端选择 | 备选「壳层另起一个同名工具」不可行：需要上游工具注册接口；备选「宿主侧包装」不可行：工具在 bundle 内部 | 已决策（补丁号与落点 ⬜ 待 Phase 0 核对） |
| D4 | 围栏为**词法**判定（不访问文件系统、不解析 symlink） | 备选「realpath 解析」被否：应用域 `symlink` 本就 `EACCES`，且解析会引入 TOCTOU 与不可判定性 | 已决策 |
| D5 | 允许根恰为「项目目录 + 沙箱临时目录」 | 备选「再加用户目录」被否：`Desktop` 为 `system_basic`（上架障碍），用户目录直写需系统授权且绕过审批（§3.8、§8.3） | 已决策 |
| D6 | 围栏 `enforce` 为默认；`warn`/`off` 视为显式安全降级并响亮声明 | 备选「无开关」被否：排障与对照实验需要，但必须留痕 | 已决策 |
| D7 | 命令集限定为系统自带 `toybox` + mksh 能力；不随包分发自有 ELF | 二进制证书（`certType: 4`）对个人主体不可得（`docs/ACL申请清单.md`） | 已决策 |
| D8 | 若 P0-1 定标为 `worker_threads`（候选 C），shell 子进程挂在 worker 内，`process.chdir` 不可用 | worker 内不能 `process.chdir`（§3.2）→ 会话 `cwd` 只能经 `spawn(..., {cwd})` 与 shell 内 `cd` 表达 | ⬜ 待 P0-1 |

## 3. 数据模型

| 类型 | 字段 | 说明 |
|---|---|---|
| `ShellSession` | `shellPath` / `pid` / `stdin` / `stdout` / `stderr` / `state` / `spawnCount` / `queue` | 进程内单例；`state ∈ {idle, busy, closed}`；`queue` 保证串行化 |
| `SentinelFrame` | `token` / `text` / `beginLine` / `endLine` / `capturedBytes` / `exitCode` / `truncated` | 纯数据；由协议层构造与解析 |
| `FenceDecision` | `verdict ∈ {allow, deny, unanalyzable}` / `offendingToken` / `normalizedPath` / `reason` | 纯数据；围栏层产出 |
| `AllowRootSet` | `projectRoot` / `sandboxTmp` | 两个绝对路径；来自宿主注入 |
| `CommandResult` | `exitCode`（`number \| "unknown"`）/ `output`（`Buffer`）/ `cancelled` / `timedOut` / `truncatedKeeping` | 工具返回 |
| `CommandInventory` | `direct[]` / `toyboxOnly[]` / `absent[]` / `danglingSymlinks[]` / `shadowedByShell[]` | 静态清单 + 设备复验后回填（见 `docs/toybox命令清单.md`） |
| `ZombieBudget` | `spawnCount` / `resetCount` / `expectedZombies` | 诊断记账，写入 `[oc-desktop]` 日志 |

**围栏允许根与来源**：`projectRoot` = 服务端项目根（v2 `config.directory` / `GET /api/location`，见 `specs/011-workspace-auth/`）；`sandboxTmp` = `<userData>/tmp` = 被 patch 的 `os.tmpdir()`（见 `specs/012-data-dirs-sqlite/`）。两者都由宿主在启动时注入并写入诊断日志，**不由模型输入决定**。

## 4. 接口契约

### 4.1 spawn 契约

```
spawn("/system/bin/sh", [], {
  cwd: sessionCwd,                     // 项目根或显式会话 cwd
  stdio: ["pipe", "pipe", "pipe"],
  env: hostEnv,                        // HOME / XDG_* / TMPDIR / PATH（specs/012-data-dirs-sqlite/）
})
```

- 禁止：`exec` / `execFile`、`process.execPath` 作目标、`statSync` 判可执行性（FR-010-002/003）。
- 懒惰 spawn：首次工具调用时创建；进程内唯一（FR-010-013）。

### 4.2 哨兵行框架（发往 stdin）

```
printf '\n__OC_SH_BEGIN__ %s\n' '<token>'
{ <command>
} 2>&1
__oc_rc=$?
printf '\n__OC_SH_END__ %s %s\n' '<token>' "$__oc_rc"
```

- `<token>` = 每次调用 `crypto.randomBytes(8).toString("hex")`（16 位十六进制）。
- 捕获窗口 = 起始行之后、与本次 token 精确匹配的结束行之前。
- 结束行 `\n` 前缀保证「命令行输出不以换行结尾」也不污染标记（FR-010-009）。
- 退出码语义与实测一致：`0` 成功 / `1` 一般失败 / `127` 命令未找到（dsh ✅，本工程 ⬜）。

### 4.3 围栏判定契约

```
fence({ command, cwd, roots }) -> FenceDecision
```

判定顺序：① 词法切分（尊重单双引号与反斜杠）→ ② 抽取路径候选（含 `/` 的 token、以 `.`/`~` 开头、重定向目标）→ ③ 以 `cwd` 为基准词法归一化 → ④ 命中允许根 ⇒ `allow`；否则 `deny`；含不可判定构造 ⇒ `unanalyzable`（按拒绝处理）。

### 4.4 工具契约

| 项 | 值 |
|---|---|
| 工具名 | 与上游 v2 基线一致（本规格按 `bash` 口径书写；⬜ 名称与注册点在 Phase 0 回填） |
| 参数 | `command`（必填）；超时/截断可由配置提供默认值（MAY 暴露为可选参数） |
| 结果 | `Exit code: <rc>` + 输出正文；截断追加 `[output truncated: kept N of M bytes]`；取消追加 `[command cancelled]`；超时明确标注退出码未知 |
| 错误 | 围栏拒绝 / 超时不可恢复 / 会话不可用为工具级错误；非零退出码不是错误 |

## 5. 实现策略

1. **先核对上游接入点**（Phase 0，随 P0-1 一起）：定位 v2 shell 工具的注册点、其后端调用面（是否经 `#pty`/`#persistent-pty-binary`），确认 D3 的补丁落点；若上游无单一接入点，退化方案是在工具实现的最内层函数前插入「后端选择 + 围栏」两步，仍保持 1~2 处判空/替换的最小改动。
2. **补丁 0006-shell-fence 形态**：`packages/core/package.json` 的 `imports` 增加 `"ohos"` 条目（指向新变体）+ 新增变体文件（哨兵行后端）+ 工具内注入围栏调用；全部为「新增文件 + 少量开关式改动」，追加到补丁列表末尾并跑 reverse-check（§6.2 六条硬规则）。
3. **宿主环境装配**（`src-main/`）：`PATH` 前置 `/system/bin`；把项目根与 `<userData>/tmp` 注入服务端（`config.directory` + 环境变量），并在 `[oc-desktop]` 日志中打印两者。
4. **协议层与围栏层做成无外部依赖的纯模块**（便于裸 Node 单测），会话层只负责 `spawn` / 写入 / 读取 / 排空 / 重置。
5. **缩短诊断回路**：先在 host 侧用 Node 22.17 直接单测协议与围栏，再上真机测 spawn 与哨兵；真机结论写入 `docs/真机验证记录.md`。
6. **诚实降级**：PTY、交互式程序、内容搜索的缺席在工具描述中明示；不允许「静默空结果」。

## 6. 测试与验证

| 层 | 手段 | 覆盖 |
|---|---|---|
| 单元（裸 Node，无需设备） | `node:test` 驱动纯模块 | 哨兵行构造与解析（含近似字符串不误判）、退出码 0/1/127、stdout/stderr 合流与行序、截断后继续排空、串行化、围栏 allow/deny/unanalyzable、重定向目标参与判定、拒绝先于审批 |
| 静态断言（构建期） | `grep` 守卫 | 代码中**无** `exec`/`execFile`、无 `'exit'`/`'close'` 事件依赖、无 `process.execPath` 作 spawn 目标、无 `statSync` 判可执行性；补丁 reverse-check 全绿 |
| host 侧门禁 | `scripts/smoke-node22.mjs`（`docs/工程规划-V2.md` §6.4） | Node 22.17 下 bundle 可加载、`GET /api/info` 200、`GET /` 返回 SPA；工具注册与描述可见 |
| 真机（Phase 0/1） | `hdc shell "hilog -x \| grep oc-desktop"` + 诊断日志 + `/proc/<pid>/stat` | spawn 放行、事件序列、僵尸计数、哨兵退出码、围栏拒绝真实生效、应用退出清理 |
| 先决探针 | Phase 0 **P0-1**（宿主形态三候选 × 五项） | 决定 shell 挂在哪一层宿主；`docs/真机验证记录.md` P0-1 矩阵 |

**门禁口径**：真机条目在**未执行时一律标 ⬜**；任何「设备上没有跑过」的结论不得写成 ✅。

## 7. 文件清单

| 路径 | 角色 | 状态 |
|---|---|---|
| `patches/v2.0.26/0006-shell-fence.patch` | 条件变体 `"ohos"` 条目 + 哨兵行后端 + 围栏注入点 | 计划（Phase 0 核对后生成） |
| `patches/v2.0.26/0003-runtime-stubs-ohos.patch` | `#pty` / `#persistent-pty-binary` 打桩（**先决条件**） | 计划（第 2 条补丁） |
| `src-main/main.js` | `PATH` 装配、项目根与 `<userData>/tmp` 注入、生命周期绑定与退出清理 | 计划 |
| `src-main/` 下协议/围栏模块（宿主侧单测入口） | 纯函数：框架构造、哨兵解析、围栏判定 | 计划 |
| `scripts/smoke-node22.mjs` | host 侧门禁 | 计划（见 004/005 模块） |
| `specs/010-tool-shell/{spec.md,plan.md}` | 本模块规格与方案 | 本次创建 |
| `docs/toybox命令清单.md` | 命令可达性三分类事实来源 | 本次创建 |
| `docs/真机验证记录.md` | P0-1 矩阵与复验结论落点 | 本次创建 |

## 8. 与规格的交叉引用

| 规格条目 | 本方案落点 |
|---|---|
| FR-010-001 ~ FR-010-005 | §4.1 spawn 契约、§5.1/5.2 接入点与补丁 |
| FR-010-006 ~ FR-010-012 | §4.2 哨兵行框架、§4.4 工具契约、§6 单元测试 |
| FR-010-013 ~ FR-010-019 | §3 `ShellSession` / `ZombieBudget`、§5.3 宿主装配、§6 真机验证 |
| FR-010-020 ~ FR-010-027 | §4.3 围栏判定契约、D4/D5/D6 |
| FR-010-028 ~ FR-010-031 | §4.4 结果渲染、§6 单元测试（截断/超时/取消） |
| FR-010-032 ~ FR-010-035 | §5.6 诚实降级、`docs/toybox命令清单.md`、`docs/鸿蒙环境能力清单.md` |
| 假设 1~6 | §1 技术上下文、§2 D8、§5.1、§6 先决探针 |
| 约束 1~5 | §2 D7、§5.6、`docs/ACL申请清单.md` |
