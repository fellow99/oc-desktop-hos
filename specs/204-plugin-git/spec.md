# Git 操作插件（204-plugin-git）—— 规格

> **Module:** 204-plugin-git ｜ **Status:** Proposed ｜ **Last Updated:** 2026-10-17 ｜ **上游基线:** opencode v2.0.26（Branch_v2.0.26）
>
> **证据口径**（沿用 `docs/工程规划-V2.md` §0.2）：✅ **实测**（真机或上游源码直接验证）｜🔶 **沿用**（同型工程或既有调研结论，本工程未复现）｜⬜ **待验证**（本工程必须自行实测）。
> **完整设计来源**：[`docs/204-插件-GIT.md`](../../docs/204-插件-GIT.md)（已评审通过，2026-10-17；脱敏声明与操作清单在其 §18）。

## 1. 模块概述

### 1.1 目的

在**没有 `git` 的鸿蒙设备**上恢复版本控制能力：把纯 JS 的 git 实现 `isomorphic-git` 嵌入本应用，经壳专用 opencode 插件向模型提供一组 git 工具，并让应用自带的「文件状态 / 分支 / 差异」界面在该设备上重新可用。

本模块由三半构成，边界清晰：

- **工具半**：`plugins/oc-plugin-git/` 注册 **21 个 `git_*` 工具**（一动词一工具），全部文件 IO 在**仓库根 chroot** 内完成。
- **VCS 半**：同一插件经 `context.vcs.transform` 以 `id: "git"` **覆盖内置 `opencode.vcs.git`**（后者必然 spawn `git`），使上游既有 diff / 分支 / 状态渲染管线在无 `git` 设备上工作。
- **凭据半**：插件经 `context.rpc.register` 暴露 4 个凭据方法；渲染层由**最小上游补丁** `patches/v2.0.26/0008-*.patch` 新增「设置 → Git」页（自门控），凭据落在 `~/.git-credentials`（git 原生格式、`0600`），**口令永不进入对话/日志**。

依赖物化是**唯一新增构建步骤**（`collect-app.mjs` 的 `collectPluginRuntime()`），运行时仍是 `L1 仅本地`（不允许按需安装）。

### 1.2 解决的问题

- **设备无 `git`**：toybox 不提供、`PATH` 无等价物（✅ `docs/鸿蒙环境能力清单-v2.0.26.md` G9）。因此上游 `opencode.vcs.git` 走 `gitExecutable` + 子进程必然失败（✅ `packages/core/src/plugin/vcs/git.ts:31-56`；真机日志出现 `worktree discovery failed … strategy=git`）。
- **能力清单的旧结论需更新**：G9 记为「不可（本轮）…纯 JS 只读可行但写操作不可行」——本模块以插件 + 构建期物化依赖的方式推翻「写操作不可行」，并把结论回写能力清单（FR-204-044）。
- **带账号仓库无凭据入口**：上游插件无 UI 钩子（✅ `docs/203-插件-选择工作区目录.md` §2 `#13`），`Credential` 服务是 provider/integration 维度、落在 SQLite（✅ `packages/core/src/credential.ts`），不能承载 git 凭据 ⇒ 必须有最小补丁。
- **围栏必须自含**：本壳没有 dsh 的一次性提权 + 审批面板（⬜ 本工程无 sandbox-policy 装配）⇒ 越界只能**明确拒绝**，不能「申请后放行」。

### 1.3 范围

**包含**：

- 壳专用插件 `plugins/oc-plugin-git/`（`index.js` + `lib/*` + `tests/*` + `README.md` + `package.json`）。
- 构建期依赖物化：`scripts/collect-app.mjs` 新增 `collectPluginRuntime()`、期望工具表新增 21 项、`--force-plugin-runtime`。
- 宿主侧门禁脚本 `scripts/verify-git-plugin.mjs`。
- 上游 UI 补丁 `patches/v2.0.26/0008-git-credentials-settings.patch`（设置 → Git 页；i18n `en.ts` / `zh.ts`）。
- VCS provider 覆盖（`lib/vcs.js`）。
- 文档同步：`plugins/README.md`、`README.md`、`docs/鸿蒙环境能力清单-v2.0.26.md`、`docs/工程规划-V2.md`（能力结论回写）。
- 本模块 `spec.md` / `plan.md` / `tasks.md` / `test-cases.md` 与 `docs/204-插件-GIT.md`。
- 真机编译、部署与 `--inspect` 功能测试（含无账号 / 带账号两条 git 链）。

**不包含**：

- `rebase` / `blame` / `grep` / 子模块 / `worktree` / `LFS` / SHA-256 仓库 / SSH 传输。
- 运行时依赖安装（`L2` 档位不做）。
- ArkTS 改动、权限声明改动、`packages/protocol` / `packages/server` 改动。
- 父工程改动（**0**）；本模块规格**不进父工程 `specs/`**（需求方明示）。
- Git 分支改动（需求方明示「不改动」）。
- 「测试连接」按钮（评审裁决：本轮不做）。

---

## 2. 用户故事

| # | 角色 | 故事 |
|---|---|---|
| US-1 | 用户 | 我能在对话里让模型克隆并读懂一个公开仓库，不必先想办法装 git。 |
| US-2 | 用户 | 我能在设置里为带账号仓库填一次用户名/口令，之后模型 pull/push 不需要知道口令。 |
| US-3 | 用户 | 应用自带的变更列表 / 分支 / 差异界面在有 `.git` 的目录里重新工作。 |
| US-4 | 用户 | 模型只能在我给出的工作区内读写；越界必须明确拒绝。 |
| US-5 | 用户 | 任何失败都如实说明原因（缺凭据 / 被拒 / 冲突 / 越界 / 网络不可达），不假装成功、不无限重试。 |
| US-6 | 维护者 | 我能在构建期看到「工具表 / 依赖版本 / 禁用项」是否合规，而不是等真机才发现。 |

---

## 3. 功能需求

> 编号：`FR-204-NNN`（`docs/工程规划-V2.md` §9.1 的扩展模块段）。MUST / MUST NOT / SHOULD 为验收口径。

### 3.1 git 引擎与工具面

| 编号 | 需求 | 级别 | 证据 |
|---|---|---|---|
| FR-204-001 | 插件 MUST 用纯 JS 实现（`isomorphic-git@1.44.2` + `isomorphic-git/http/node`）在设备侧完成 git 操作；MUST NOT 依赖任何外部 `git` 二进制或原生模块 | MUST | ✅ 库为纯 JS；✅ 依赖闭包 55 包 / 8.4 MB（宿主 PoC）；⬜ 真机 |
| FR-204-002 | 插件 MUST 注册且仅注册 21 个工具：`git_init` `git_clone` `git_status` `git_diff` `git_log` `git_show` `git_add` `git_commit` `git_branch` `git_checkout` `git_reset` `git_merge` `git_cherry_pick` `git_revert` `git_stash` `git_tag` `git_remote` `git_fetch` `git_pull` `git_push` `git_config`（一动词一工具） | MUST | ✅ 设计 §10；⬜ 真机 |
| FR-204-003 | 每个工具 MUST 接受可选 `dir`（相对会话目录解析；缺省 = 会话目录），且 MUST 校验其落在项目根内（FR-204-010） | MUST | 设计 §8；⬜ host 单测 + 真机 |
| FR-204-004 | 任何工具 MUST NOT 携带凭据字段（用户名/口令/token）；凭据只经 FR-204-020 的文件读取 | MUST | 设计 §9、§10；⬜ 静态断言可核对 schema |
| FR-204-005 | 上游库缺失的三项能力 MUST 由插件自建：`git_show`（commit/tree/blob/tag 展示）、`git_diff`（unified diff / stat / 二进制判定）、`git_revert`（反向提交，fail-closed） | MUST | ✅ `Object.keys(isomorphic-git)` 74 项无 `show`/`diff`/`revert`；✅ `cherryPick` 无 `reversal` 参数；⬜ 真机 |
| FR-204-006 | `rebase` MUST NOT 交付；被请求时 MUST 明确回「本平台不支持（上游库无此原语）」，MUST NOT 静默用 merge 冒充 | MUST | ✅ 设计 §1、§14 |
| FR-204-007 | 工具注册后 MUST 逐个 `editor.get(name)` 复查；任一缺失 MUST 抛错使插件在 `GET /api/plugin` 中为 `failed`（fail-visible） | MUST | ✅ 上游 `Editor` 语义；✅ 同型插件范式（`oc-plugin-harmony-search`） |

### 3.2 围栏与文件访问

| 编号 | 需求 | 级别 | 证据 |
|---|---|---|---|
| FR-204-010 | 仓库根 MUST 唯一取自 `context.location.project.directory`；`dir` 解析结果不满足「等于根或以 `根 + 分隔符` 开头」时 MUST 拒绝并说明（不落到 `node:fs`） | MUST | 设计 §8；⬜ host 单测 + 真机 |
| FR-204-011 | 适配器 MUST 对每个路径做 `join → normalize → 前缀包含` 校验；`..` 逃逸、绝对路径、根外软链 MUST 一律拒绝 | MUST | 设计 §8；⬜ host 单测 |
| FR-204-012 | 适配器的**每个**方法 MUST 声明为 `async`（含 `rm`）；MUST NOT 在参数非法时同步抛错（否则 isomorphic-git 判成 callback 方言并永久挂起） | MUST | 🔶 dsh 真机事故（工具结果未知、会话卡死）；⬜ 本工程契约测试 |
| FR-204-013 | 越界时 MUST 明确拒绝并提示换项目根；MUST NOT 提供「提权后放行」通道（本壳无审批面） | MUST | 设计 §8-4；⬜ 真机 |

### 3.3 凭据

| 编号 | 需求 | 级别 | 证据 |
|---|---|---|---|
| FR-204-020 | 凭据 MUST 存放在 `~/.git-credentials`（设备上 `<userData>/.git-credentials`），格式 MUST 与 `git credential-store` 同形（一行一条带 userinfo 的 URL，userinfo 百分号编码），权限 MUST 为 `0600` | MUST | ✅ `HOME` 改写（`src-main/main.js:236-241`）；🔶 dsh 同名实现；⬜ 真机 |
| FR-204-021 | 匹配 MUST 按「协议 + `host[:port]`（大小写不敏感）」；带路径的行 MUST 按前缀匹配且优先于裸主机行；同分时文件靠后的行覆盖靠前的；坏行/注释 MUST 跳过而不抛错 | MUST | 🔶 dsh `git-credentials.test.mjs` 语义；⬜ 本工程单测 |
| FR-204-022 | `onAuth` MUST 在命中时返回 `{username,password}`、未命中时返回 `{cancel:true}` 并由工具报「未配置凭据 + 主机 + 设置入口 + 文件路径 + 可照抄占位行」；`onAuthFailure` MUST 报「凭据被拒绝」且最多重试 1 次；MUST NOT 把裸 401/403/404 抛给模型 | MUST | ✅ `onAuth` 契约；⬜ 真机 |
| FR-204-023 | 插件 MUST 经 `context.rpc.register` 提供 `credentials.describe` / `credentials.list` / `credentials.save` / `credentials.remove`；所有 handler MUST 为 async；MUST NOT 回传口令值 | MUST | ✅ RPC 范式（同型插件）；⬜ 真机 |
| FR-204-024 | 渲染层 MUST 经最小补丁新增「设置 → Git」页：口令框 `type="password"`、保存后只显示「已配置（长度 N）」、页面 MUST 显示凭据文件绝对路径；RPC 不可达时该页 MUST 整页隐藏（自门控） | MUST | ✅ 插件无 UI 钩子；✅ 设置页注册点；⬜ 真机 |
| FR-204-025 | 凭据明文 MUST NOT 出现在对话记录、hilog 日志、`opencode.json`/`cordis.*`、以及任何提交/文档 | MUST | 设计 §9.3；⬜ 四类载体检索 |

### 3.4 VCS provider 覆盖

| 编号 | 需求 | 级别 | 证据 |
|---|---|---|---|
| FR-204-030 | 插件 MUST 经 `context.vcs.transform` 注册 `id: "git"` 的 provider 以覆盖内置实现；MUST NOT 依赖任何上游源码改动 | MUST | ✅ `VcsEditor.add` = `Map.set`；✅ 插件激活晚于 `internal.pre`；⬜ 真机 |
| FR-204-031 | provider MUST 实现 `init` / `info` / `base` / `branches` / `status` / `diff`，语义与上游一致（`Info.branch.{current,default}`、`BranchList: string[]`、`FileStatus{file,additions,deletions,status}`、`diff` 返回含 `patch` 的 `FileDiff.Info[]`） | MUST | ✅ `packages/schema/src/vcs.ts`、`packages/plugin/src/promise/vcs.ts`；⬜ 真机 |
| FR-204-032 | `setup()` 成功注册后 MUST 打印一行诊断（`[oc-desktop]` 前缀，含工具数 / provider id / 凭据路径）；工具与 VCS 注册 MUST 分别 try/catch，任一失败 MUST 在日志中可见 | MUST | ✅ 上游对 provider 异常静默（`protect`/`review`）；⬜ 真机 hilog |
| FR-204-033 | 覆盖 MUST 可单点回退（注释注册调用即回到「仅工具」形态），回退后 21 个工具 MUST 不受影响 | MUST | 设计 §12.4；⬜ 构建/单测可验证 |

### 3.5 构建、装配与文档

| 编号 | 需求 | 级别 | 证据 |
|---|---|---|---|
| FR-204-040 | `collect-app.mjs` MUST 新增 `collectPluginRuntime()`：在构建机临时目录物化 `isomorphic-git@1.44.2` + `diff@9.0.0`，复制到 `resfile/resources/app/plugins/oc-plugin-git/node_modules/`；MUST 断言两包版本、`http/node` 入口存在、包数与总体积上限；失败 MUST 抛错（不静默产出空包）；MUST 支持幂等快路径与 `--force-plugin-runtime` | MUST | ✅ 插件目录被 `cpSync` 整体物化；✅ Node 裸包解析查插件自身 `node_modules`；⬜ 构建日志 |
| FR-204-041 | `collect-app.mjs` 的工具元数据期望表 MUST 新增 `oc-plugin-git` 的 21 项；不符 MUST 构建期失败 | MUST | ✅ 现状 #9；⬜ 构建日志 |
| FR-204-042 | 插件源码 MUST 通过既有静态断言（无 PTY / 无 spawn / 无 `.node` / 无 `exec` 家族）与 `node --check`（ESM）；第三方物化目录 MUST NOT 被这些断言扫描 | MUST | ✅ 断言只扫源目录；⬜ 构建日志 |
| FR-204-043 | 本模块 MUST NOT 新增权限声明、MUST NOT 改 ArkTS、MUST NOT 改 `packages/protocol` / `packages/server`、MUST NOT 改父工程 | MUST | ✅ 设计 D13；⬜ diff 核对 |
| FR-204-044 | 文档 MUST 同步：`plugins/README.md`（§5 登记纯 JS 第三方依赖可构建期物化、§7 加插件行）、`README.md`（能力缺口中 git/VCS 状态）、`docs/鸿蒙环境能力清单-v2.0.26.md`（G9 行标注本轮已交付）、`specs/README.md`（编号表） | MUST | 设计 §16；⬜ 评审 |
| FR-204-045 | 插件的第三方模块 MUST 懒加载（首次工具调用时 `import()`），MUST NOT 在模块顶层 import 第三方包 | MUST | ✅ 构建期工具元数据检查会 import 插件并跑 `setup()`；⬜ 构建日志 |

---

## 4. 关键实体

| 实体 | 字段 | 说明 |
|---|---|---|
| `CredentialEntry` | `protocol` / `host`（含可选端口）/ `username` / `passwordLength` / `hasPath` | 只出现在 RPC 输出中；**不含口令值** |
| `CredentialFile` | 路径 `<userData>/.git-credentials`、`mode`（`600`）、`count` | §9.1 的文件形态 |
| `GitToolResult` | `content: string` / `metadata: object` | 工具返回值（`content` 为模型可读文本；`metadata` 带结构化摘要） |
| `ToolError`（可归因） | `content` 文本（缺凭据 / 越界 / 非仓库 / 冲突 / 服务端拒绝） | 以返回值上报，步骤不终结 |
| `VcsProvider` | `id: "git"` / `name` / `init` / `info` / `base` / `branches` / `status` / `diff` | §12 的覆盖对象 |
| `FileStatus` | `file` / `additions` / `deletions` / `status` | 上游 schema |
| `FileDiff.Info` | `file` / `patch` / 统计 | 上游 schema |
| 运行时常量 | `ISOMORPHIC_GIT_VERSION = 1.44.2` / `JSDIFF_VERSION = 9.0.0` | 构建脚本 pin + 装载断言 |

---

## 5. 验收场景

### 场景 1：插件装配与工具可见（正常）
应用启动后 `GET /api/plugin` 中 `oc-harmony-git` 为已加载；hilog 出现诊断行；会话内可见 21 个 `git_*` 工具。
**负例**：期望工具表与实现不符 → 构建期 `collect-app.mjs` 失败。

### 场景 2：本地仓库全链（正常）
在空目录 `git_init` → 写文件 → `git_add` → `git_commit` → `git_status` / `git_log` / `git_diff` 均成功，作者身份来自 `git_config` 或 Config 默认占位值。

### 场景 3：无账号远端只读 + 浅克隆（正常）
`git_remote`（`listServerRefs`）列出服务端分支；`git_clone`（`depth`/`singleBranch`）成功；`git_fetch` / `git_pull` 成功或「已是最新」。
**负例（必存）**：`git_push` 在无凭据时失败，且报「未配置凭据 + 主机 + 文件路径」。

### 场景 4：带账号仓库读写（正常，含副作用标注）
凭据经设置页写入 ≤ `0600` 文件 → `listServerRefs` 认证通过 → clone → 只读链 → 新建测试分支 → 提交 → 推送测试分支 → 附注标签 + 推送 → （AW-5，评审已裁决执行）默认分支提交推送 → 收尾删除测试分支。

### 场景 5：缺凭据与凭据被拒（负例必存）
删除凭据后访问带账号主机：报错点明主机、设置入口、`~/.git-credentials` 路径与可照抄占位行；错误口令：报「凭据被拒绝」，最多重试 1 次，**不出现无限重试**。

### 场景 6：围栏（负例必存）
`dir` 指向项目根之外（含 `..` 逃逸、绝对路径）：工具拒绝并说明；仓库内文件**未被创建**。

### 场景 7：promise 方言契约（负例必存）
适配器任一方法在被同步调用（无参）时 MUST 返回 rejected Promise 而非抛错；契约测试复刻 `isPromiseFs` 探测，断言每个方法 `constructor.name === 'AsyncFunction'`。

### 场景 8：VCS 覆盖生效（正常）
在有 `.git` 的工作区：应用自带界面显示当前分支与文件变更/差异；hilog 有诊断行。
**回退**：注释注册调用后重建，工具仍全可用，UI 回到既有降级状态。

### 场景 9：凭据页自门控（负例必存）
插件未加载 / RPC 不可达时，「设置 → Git」不出现，导航与路由行为与上游一致；不弹错误框。

### 场景 10：构建期门禁（正常 + 反向）
`collect-app.mjs` 全绿（静态断言 + 21 项工具元数据 + 物化断言）；`--check-only` 跳过物化仍全绿；反向用例（缺 `package.json`、工具名不符）按预期失败。

### 场景 11：基本功能回归（正常）
设置 `<DEEPSEEK_API_KEY>` → 创建工作区 → 完成一次真实对话，不因本模块退化。

### 场景 12：`revert` fail-closed（负例必存）
先制造工作区分叉，再 `git_revert` 目标提交：拒绝执行并列出冲突路径，**用户改动未被覆盖**。

---

## 6. 非功能需求

| 编号 | 需求 | 级别 | 说明 |
|---|---|---|---|
| NFR-204-001 | 启动 MUST NOT 因本模块劣化：第三方模块懒加载，插件 `setup()` 不做网络/磁盘重活 | MUST | 装载只在首次工具调用 |
| NFR-204-002 | 包体积增量 MUST ≤ 12 MB（实测 9.3 MB） | MUST | 构建期断言 |
| NFR-204-003 | `git_clone`（`depth:1`，中型公开仓库）SHOULD 在 60 s 内完成；超时 MUST 如实上报已用时与建议 | SHOULD | 纯 JS 性能，观察项 |
| NFR-204-004 | 所有插件日志 MUST 带 `[oc-desktop]` 前缀；凭据 MUST 只打印 host 与长度 | MUST | 与既有日志规范一致 |
| NFR-204-005 | 任何失败 MUST 可见（返回值或日志二者至少其一），MUST NOT 静默成功 / 空结果 | MUST | 与工程 fail-visible 纪律一致 |
| NFR-204-006 | 工具输出 MUST 有硬上限（单文件 diff 256 KiB、单次总量 1 MiB、日志行截断），超限 MUST 显式标注 | MUST | 防爆上下文 |

---

## 7. 假设与约束

| # | 假设/约束 | 影响 |
|---|---|---|
| A1 | 设备网络可达目标仓库主机（`github.com` 在同类设备/构建机均超时，已记录） | 无账号用例允许换可达等价仓库（D4） |
| A2 | 设备 `HOME=<userData>`、`XDG_CONFIG_HOME=<userData>/config` | 凭据文件与插件物化路径据此推导 |
| A3 | 宿主默认 `OCR_HOST_MODE=inprocess` | `--inspect` 可观测服务端；插件与主进程同进程 |
| A4 | 上游 provider 以 `id:"git"` 注册且编辑器为 `Map.set` 语义 | 覆盖成立；若上游改动则走 §12.4 回退 |
| A5 | 设备不支持软链、`hmdfs` 大小写不敏感 | 适配器不做软链语义；冲突如实报错 |
| A6 | 本壳无审批/提权面 | 越界只能拒绝，不做提权 |
| A7 | 上游版本 pin 在 v2.0.26（`9b4ec5714d`） | 升级需复跑 AC-1/AC-2/AC-6 |

---

## 8. 依赖

| 依赖 | 类型 | 用途 | 状态 |
|---|---|---|---|
| `isomorphic-git@1.44.2` + `isomorphic-git/http/node` | 第三方纯 JS（构建期物化） | git 实现与 HTTPS 传输 | 需物化（FR-204-040） |
| `diff@9.0.0` | 第三方纯 JS（构建期物化） | unified diff | 需物化 |
| `@opencode/plugin` 的 `context.tool` / `vcs` / `rpc` | 上游契约 | 工具 / VCS / RPC 注册 | ✅ 已存在 |
| `packages/schema/src/vcs.ts`、`packages/plugin/src/promise/vcs.ts` | 上游类型 | VCS 契约 | ✅ 已存在 |
| `POST /api/rpc/:rpcID/:method`、`sdk.api.rpc.call` | 上游协议 | 凭据页 → 插件 | ✅ 已存在（零 codegen） |
| `scripts/collect-app.mjs`、`src-main/main.js materializePlugins()` | 本工程 | 构建期投放 + 启动期物化 | 需扩展（FR-204-040） |
| `patches/v2.0.26/0008-*.patch` | 本工程 | 设置 → Git 页 | 待新增 |
| `node:fs` / `node:path` / `node:fs/promises` | Node 内建 | 适配器、凭据文件 | ✅ 可用 |
| `docs/204-插件-GIT.md` | 本工程 | 完整设计（已评审） | ✅ |

交叉引用：[`plan.md`](./plan.md) ｜ [`tasks.md`](./tasks.md) ｜ [`test-cases.md`](./test-cases.md)
