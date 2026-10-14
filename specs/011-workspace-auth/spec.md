# 工作区（项目目录）选择与授权（011-workspace-auth）—— 规格

> **Module / Status: Proposed / Last Updated: 2026-10-11 / 上游基线: opencode v2.0.26（Branch_v2.0.26）**
>
> **证据口径**（沿用 `docs/工程规划-V2.md` §0.2）：✅ **实测**（真机或上游源码直接验证）｜🔶 **沿用**（同型工程或既有调研结论，本工程未复现）｜⬜ **待验证**（本工程必须自行实测）。
> **本工程状态**：尚无任何真机记录；凡设备行为条目均给出「来源」与「本工程复验状态」。设计依据为 `docs/工程规划-V2.md` §3.8、§5.3、§5.6、§8.2–§8.3。

## 1. 模块概述

### 1.1 目的

让使用者在设备上**选定一个工作目录**，把它作为 opencode v2 的**项目根**交给服务端（v2 的项目语义由目录决定：`config.directory` 注入 / `GET /api/location`、`GET /api/project` 只读查询），并解决「应用只能自由读写自身沙箱」带来的授权问题：

1. 应用沙箱（`userData` = `/data/storage/el2/base/files`）**可写**；
2. 用户家目录（`homedir()` = `/storage/Users/currentUser`）**不可写**，其下的 `Documents` / `Download` / `Desktop` 需**系统授权**；
3. 目录授权 MUST 走 ArkTS 侧的 `fileShare.activatePermission` / `requestDirectoryPermission`，且 **MUST 传真实路径**；Picker 返回的 **URI 仅临时授权**，**每次启动需重新授权**，卸载即清空。

模块的价值是「让模型有一个真实可写的项目根」，而不是「把整块磁盘交给模型」：授权面、可写性验证、项目根传递与失败可见性构成完整的契约。

### 1.2 解决的问题

| # | 问题 | 性质 | 若不处理的后果 |
|---|---|---|---|
| 1 | 应用只能自由读写自身沙箱；用户目录属主为 `file_manager`（`mode 2771`），应用 uid 落在 "other" | 平台硬约束（L1） | 未授权时目录 `R_OK`/`W_OK` 直接 `EACCES`，`writeFile`/`mkdir` 直接 `EPERM`；模型看到的是「工具坏了」而不是「没授权」 |
| 2 | Picker URI 仅**临时**授权、**每次启动需重新激活**、卸载即清空 | 平台硬约束（L1） | 把 URI 当作长期凭据会让第二次启动静默失败；把持久化写进配置会造成「跨安装的悬空授权」 |
| 3 | `Desktop` 目录权限为 `system_basic`（须 ACL），是当前**唯一的上架障碍**；⚠️ 2026-10-14 口径变更：该权限改由 `006-signing-identity` 声明并随 ACL 批次申请（见该模块 FR-006-011 / FR-006-025） | 平台硬约束（L1） | 若为了「顺手直写桌面」而在**本模块**自行申请，直接把上架路径堵死；上架前须复核该声明是否保留（`docs/ACL申请清单.md` §7.3 ⬜-6） |
| 4 | 授权生效可能要求**重启应用**（dsh 真机记录） | 平台硬约束（L1） | 用户授权后仍失败，且无提示 —— 必须显式引导 |
| 5 | 项目根是 shell 围栏的允许根之一 | 本工程配置（L3） | 两者不一致会出现「工具说在项目里、shell 说越界」的自相矛盾 |
| 6 | 上游 v2 无「目录选择器」概念（项目语义只认目录） | 上游接口缺口（L4） | 选择器必须由 ArkTS 侧或壳层 UI 承担，不能指望服务端弹窗 |

### 1.3 范围

**包含**：

- 目录选择入口（ArkTS Pickers 或壳层 UI）与产物：**真实路径** + 该路径的授权状态。
- 授权动作：`fileShare.activatePermission` / `requestDirectoryPermission` 的调用契约（传真实路径、启动重放、失败可见）。
- 可写性验证：把目录交给服务端前的写入探针与回读校验。
- 项目根传递：宿主 → 服务端（`config.directory` / 启动参数），并与 `GET /api/location` 的观测结果交叉校验。
- UI 内切换项目时的授权复用通道。
- 权限声明面：`READ_WRITE_DOCUMENTS_DIRECTORY` / `READ_WRITE_DOWNLOAD_DIRECTORY` / `FILE_ACCESS_PERSIST`；`READ_WRITE_DESKTOP_DIRECTORY` 自 2026-10-14 起**改由 `006-signing-identity` 声明并随 ACL 批次申请**（本模块不自行声明；见该模块 FR-006-011 / FR-006-025，上架前复核与回退点见 `docs/ACL申请清单.md` §7.3 ⬜-6 / §11）。

**不包含**：

- 任意用户目录的**持久**访问（只走系统 Picker + 授权通道；不绕过系统权限模型）。
- 桌面（`Desktop`）直写这一**能力**的规格与实现（注：该能力是否存在取决于 `006-signing-identity` 声明的 `READ_WRITE_DESKTOP_DIRECTORY` 是否获批 + 用户是否在系统设置里授权；本模块的规格范围是「目录授权与项目根传递」，不单独定义该能力的验收口径）。
- shell 执行本身（见 `specs/010-tool-shell/`）、数据目录与 sqlite（见 `specs/012-data-dirs-sqlite/`）。
- 文件选择器 UI 的具体视觉与交互细节（属 UI 规格；本规格只固定通道与契约）。
- 多工作区 / worktree 语义（`docs/工程规划-V2.md` §7.2 列为 Phase 2+）。

## 2. 用户故事

- 作为**使用者**，我希望第一次启动时被明确要求选一个项目目录，并知道该目录当前是否可写。
- 作为**使用者**，我希望授权过一次之后，应用能记住「我选的是哪个目录」（路径可以记住），但**不假装授权还在** —— 需要重新授权时明确告诉我怎么做。
- 作为**使用者**，我希望在 UI 里切换项目时不必重新走一遍系统设置，只需按提示确认一次授权。
- 作为**使用者**，我希望当目录不可写时看到「需要授权，去设置 → 应用 → 本应用 → 允许访问，然后重启应用」这类可执行指引，而不是 `EPERM`。
- 作为**评审者**，我希望规格明确「哪些权限不申请、为什么」（`READ_WRITE_DESKTOP_DIRECTORY` 是 2026-10-14 起改由 `006-signing-identity` 声明并申请的**例外**），避免后续为便利把上架路径堵死。

## 3. 功能需求

> 编号：`FR-011-NNN`（`docs/工程规划-V2.md` §9.1）。

### 3.1 目录选择与项目根传递

| 编号 | 需求 | 强度 | 来源 / 状态 |
|---|---|---|---|
| FR-011-001 | 应用 MUST 在宿主侧提供服务端启动前的工作区确定流程：默认项目根为沙箱内目录（`<userData>/projects/<name>`，可写），使用者选定其它目录后**替换**该项目根 | MUST | 设计决策；`userData` 可写为 ✅ dsh 真机（`hmfs`），本工程 ⬜ |
| FR-011-002 | 使用者选定的目录 MUST 以**真实路径**（绝对路径）在宿主内传递，MUST NOT 以 Picker URI 作为项目根 | MUST | `docs/工程规划-V2.md` §5.6；⬜ 本工程复验 |
| FR-011-003 | 宿主 MUST 把项目根交给服务端作为配置目录（v2 `ServerOptions.config.directory` / `config.directory`），并 MUST 在服务端就绪后以 `GET /api/location`（或等价只读接口）**交叉校验**生效的项目根 | MUST | `docs/工程规划-V2.md` §2.1、§5.6；⬜ 接口字段名与返回结构本工程核对 |
| FR-011-004 | UI 内切换项目 MUST 复用**同一授权通道**；项目根变化 MUST 对使用者可见（新的会话/文件操作使用新根），MUST NOT 出现「切了 UI 但服务端仍用旧根」的静默错配 | MUST | 设计决策；⬜ 生效方式（重建宿主 / 重启服务端 / 仅改会话根）本工程验证 |
| FR-011-005 | 项目根 MUST NOT 由模型输入决定（不得通过工具参数改写项目根） | MUST | 设计决策（与 `docs/工程规划-V2.md` §3.8 的「部署期状态不是模型输入」同口径） |

### 3.2 授权与可写性

| 编号 | 需求 | 强度 | 来源 / 状态 |
|---|---|---|---|
| FR-011-006 | 目录授权 MUST 经 ArkTS 侧 `fileShare.activatePermission` / `requestDirectoryPermission` 申请，并 MUST 传**真实路径** | MUST | `docs/工程规划-V2.md` §3.8、§5.6；⬜ 本工程复验（签名、返回码、约束） |
| FR-011-007 | 每次应用启动 MUST **重新激活**上次选定的目录授权；MUST NOT 把 Picker 的 URI 当作跨启动的持久凭据 | MUST | ✅ dsh 真机（Picker URI 仅临时授权、每次启动须 `activatePermission`、卸载清空）；⬜ 本工程复验 |
| FR-011-008 | 在把目录作为项目根交给服务端之前，宿主 MUST 做**写入探针 + 回读校验**（建临时文件 → 回读内容 → 删除）；探针失败 MUST 视为该目录不可用 | MUST | `chmod` 静默语义与「写入后回读」纪律：✅ dsh 真机（`hmdfs` 不落实 mode）；⬜ 本工程复验 |
| FR-011-009 | 目录不可用（未授权 / `EACCES` / `EPERM` / 探针失败）时 MUST 呈现可执行指引（授权路径 + 可能需要重启应用），MUST NOT 只抛错误码 | MUST | ✅ dsh 真机（三目录需在「设置 → 应用 → 本应用 → 允许访问」授权并重启应用）；⬜ 本工程复验 |
| FR-011-010 | 未授权时的回退行为 MUST 显式：回退到沙箱内默认项目根并在 UI 明示「当前用的是沙箱目录」，MUST NOT 静默回退 | MUST | 设计决策 |
| FR-011-011 | 权限声明面 MUST 限于 `READ_WRITE_DOCUMENTS_DIRECTORY`、`READ_WRITE_DOWNLOAD_DIRECTORY`（`normal` / `user_grant`，since API 11）与 `FILE_ACCESS_PERSIST`（`system_grant`，since API 11）；**例外（2026-10-14 口径变更）**：`READ_WRITE_DESKTOP_DIRECTORY`（`system_basic`）改由 `006-signing-identity` 依上游 `ACL申请清单-v1.md` 声明并随 ACL 批次申请，本模块 MUST NOT 自行声明亦 MUST NOT 依赖其已获批 | MUST | 🔶 dsh 已核对 SDK `PermissionDefinitions.json`；`docs/工程规划-V2.md` §8.2/§8.3；口径变更记录见 `docs/ACL申请清单.md` §11 |
| FR-011-012 | 对任意用户目录的**持久**访问 MUST 只走「系统 Picker + 持久授权」路线，不得自建绕过（如尝试 `symlink`、改 mode、越过挂载点直写） | MUST | ✅ dsh 真机（应用域 `symlink` `EACCES`、`chmod` 不落实）；⬜ 本工程复验 |
| FR-011-013 | 授权与项目根状态 MUST 写入 `[oc-desktop]` 结构化日志（路径、授权结果、探针结果、时间戳），供真机取证 | MUST | `docs/工程规划-V2.md` §5.2（fail-visible 纪律） |

### 3.3 与其它能力的接口面

| 编号 | 需求 | 强度 | 来源 / 状态 |
|---|---|---|---|
| FR-011-014 | 项目根 MUST 同时作为 shell 工具的路径围栏允许根（与 `specs/010-tool-shell/` 的 `AllowRootSet.projectRoot` 同一取值，由宿主单点注入） | MUST | 设计决策；⬜ 本工程复验 |
| FR-011-015 | 项目根路径 MUST 采用**绝对路径 + 不做 symlink 解析**（应用域 `symlink` 不可用；一律 copy 物化） | MUST | ✅ dsh 真机（应用域 symlink `EACCES`）；🔶 旧工程同结论；⬜ 本工程复验 |
| FR-011-016 | 依赖 `hardlink` 的写入路径 MUST 被禁用（原子写只走 `rename`） | MUST | ✅ dsh 真机（hmdfs 无 `.link` → `EPERM`）；⬜ 本工程复验 |
| FR-011-017 | 项目根之上的路径（沙箱外、用户目录外）MAY 允许**只读**使用，但 MUST NOT 因此获得 shell 围栏的允许根（只读与可写两面分别界定） | MAY | 设计决策 |

## 4. 关键实体

| 实体 | 说明 | 关键属性 |
|---|---|---|
| `WorkspaceSelection` | 一次工作区选定的结果 | `realPath`（绝对真实路径）、`source`（`picker` / `settings` / `sandbox-default`）、`uri`（若来自 Picker，仅临时用途）、`selectedAt` |
| `DirectoryPermission` | 目录权限声明与授权记录 | `permission`（`READ_WRITE_DOCUMENTS_DIRECTORY` / `READ_WRITE_DOWNLOAD_DIRECTORY` / `FILE_ACCESS_PERSIST`）、`grantMode`、`grantedAt` |
| `DirAuthActivation` | 一次启动内的授权激活 | `realPath`、`activatedAt`、`result`（`ok` / `denied` / `unsupported`）、`restartRequired` |
| `WriteProbe` | 可写性探针结果 | `realPath`、`ok`、`errno`、`probeFile`、`readBackMatches` |
| `ProjectRoot` | 交给服务端的项目根 | `path`、`validatedAt`、`crossCheckedLocation`（`GET /api/location` 观测值） |

## 5. 验收场景

### 场景 1：首次选择沙箱内目录

- **Given** 首次启动，尚无选择记录
- **When** 使用者接受默认项目根（`<userData>/projects/<name>`）
- **Then** 写入探针通过；宿主以该绝对路径启动/配置服务端；`GET /api/location` 返回的项目根与之一致

### 场景 2：选择用户目录但尚未授权

- **Given** 使用者选定 `/storage/Users/currentUser/Documents/<proj>`
- **When** 尚未在系统设置中授予「允许访问」
- **Then** 写入探针失败（`EACCES` / `EPERM`），UI 显示授权指引（含「可能需要重启应用」），并显式回退到沙箱默认根；**不出现静默回退**

### 场景 3：授权后重启

- **Given** 使用者已在系统设置中授权并重启应用
- **When** 应用启动并重放同一路径的授权激活
- **Then** 探针通过，项目根生效；日志记录 `activatedAt` 与探针结果

### 场景 4：第二次启动（URI 不持久）

- **Given** 上次通过 Picker 选定目录
- **When** 第二次启动
- **Then** 应用**重新激活**该真实路径的授权；若激活失败，按场景 2 处置，MUST NOT 直接使用上次的临时 URI

### 场景 5：UI 内切换项目

- **Given** 已有一个可用项目根
- **When** 使用者在 UI 中切换到另一个已授权目录
- **Then** 新根经同一授权通道校验后生效；文件与 shell 工具随后使用新根；`GET /api/location` 观测值与新根一致

### 场景 6：围栏一致性

- **Given** 项目根为 `/data/storage/el2/base/files/projects/a`
- **When** shell 工具尝试写入该根之外的用户目录
- **Then** 被 shell 工具层围栏拒绝（与 `specs/010-tool-shell/` 一致），拒绝先于审批，且与项目目录授权状态无关

## 6. 非功能需求

- **失败可见**：授权、探针、项目根传递三类事件 MUST 有日志与 UI 提示；禁止「卡在选择工作区但不说明原因」。
- **凭据最短原则**：本模块只申请 `Documents` / `Download` 对应的 `normal` 权限与 `FILE_ACCESS_PERSIST`；`system_basic` 目录权限**由 `006-signing-identity` 统一声明**（2026-10-14 起：`READ_WRITE_DESKTOP_DIRECTORY` 随 ACL 批次申请），本模块 MUST NOT 自行声明。
- **无隐式扩大**：项目根只能由使用者动作变更；模型与工具不得扩大授权面。
- **可诊断**：授权相关错误 MUST 带原始错误码与路径；不得吞掉 `EACCES` / `EPERM`。
- **可重复**：授权激活与探针 MUST 可重复执行（幂等），首次与后续启动行为一致。

## 7. 假设与约束

**假设（逐条待验证）**

- ⬜ **待验证** 1：`fileShare.activatePermission` / `requestDirectoryPermission` 的确切签名、入参形态（真实路径 vs URI）与返回码语义（须查本机 DevEco SDK 后固化）。
- ⬜ **待验证** 2：Picker 返回的 URI 与其真实路径的换算方式（是否存在官方 `uri → path` 接口；若无，则只用 Picker 选择 + 立即换算，失败即拒绝）。
- ⬜ **待验证** 3：授权生效是否**必须重启应用**（dsh 记录为必须；本工程须复现并据此决定 UI 提示文案）。
- ⬜ **待验证** 4：目录选择器目标形态 —— ① ArkTS 目录 Picker ② 壳层自绘浏览器（走宿主侧目录列举）③ 二者混合（`docs/工程规划-V2.md` §11.2 **O6**，Phase 1 定）。
- ⬜ **待验证** 5：项目根在服务端的生效方式与时点（`config.directory` 注入 / 会话级根 / 是否需要重建宿主），以及 `GET /api/location` 的字段名与语义。
- ⬜ **待验证** 6：`Documents` / `Download` 授权是否递归覆盖其子目录（影响「项目可以建在子目录里」这一假设）。
- ⬜ **待验证** 7：`FILE_ACCESS_PERSIST` 在目标 SDK 上的实际行为（`grantMode: system_grant`，since API 11；卸载清空语义需复验）。
- 🔶 **沿用** 8：旧工程 `opencode-harmony` 未实现任何 Picker / 授权通道，「无实例可参照」的状态沿用；本工程必须从零验证。

**约束**

- 约束 1：**本模块不自行声明 `Desktop` 权限**（`system_basic`，需 ACL + 上架前复核）；该权限自 2026-10-14 起由 `006-signing-identity` 依 dsh 声明面声明并随 ACL 批次申请（FR-011-011 例外）。桌面直写的**可用性**以「ACL 获批 + 用户授权」为前提，本模块 MUST NOT 假定其必然可用（上架前复核见 `docs/ACL申请清单.md` §7.3 ⬜-6）。
- 约束 2：**应用域 `symlink` 不可用、`hardlink` 被拒、`chmod` 不落实**（dsh 真机）；目录管理实现 MUST 只使用 `mkdir` / `copy` / `rename` 语义。
- 约束 3：**卸载清空授权** —— 任何「跨安装记忆授权」的设计都是错的。
- 约束 4：**应用域是唯一可信观测点**：`hdc shell` 视角与应用程序视角可能不同（dsh 真机：`hdc shell` 看不到 `/data/service/hnp`，应用却能访问）；授权与可写性的取证 MUST 在应用域完成。

## 8. 依赖

**上游（opencode v2.0.26）**

- `packages/server/src/options.ts` 的 `ServerOptions.config{directory,project,file,content}`、`packages/server/src/routes.ts` 的 `GET /api/location` / `GET /api/project`（`docs/工程规划-V2.md` §2.1；⬜ 字段级核对）。
- `packages/util/src/global-roots.ts` —— 数据/配置根（与 `specs/012-data-dirs-sqlite/` 相关）。

**本工程其它模块**

- `specs/010-tool-shell/` —— 消费本模块的 `ProjectRoot` 作为围栏允许根。
- `specs/012-data-dirs-sqlite/` —— 提供沙箱目录布局（`userData`、`<userData>/tmp`）与宿主环境装配。
- `specs/007-runtime-entry/`（另建）—— 宿主形态决定「项目根变化」是否需要重建宿主。
- `docs/ACL申请清单.md` —— 权限声明面与「不申请清单」的事实来源。
- `docs/真机验证记录.md` —— P0-1 / P0-2 / P0-3 矩阵的落点；本模块真机结论写回该文件。
