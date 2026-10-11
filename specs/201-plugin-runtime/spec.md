# 插件机制与三档降级（201-plugin-runtime）—— 规格

> **Module / Status: Proposed / Last Updated: 2026-10-11 / 上游基线: opencode v2.0.26（Branch_v2.0.26）**
>
> **证据口径**：✅ **实测** ｜🔶 **沿用** ｜⬜ **待验证**（本工程必须自行实测）。
> **范围生效时点**：**L0（关闭）是 v1 默认**；**L1（仅本地插件）** 在 Phase 2 落地壳专用插件；**L2（允许安装）** 属 Phase 2 起的评估项。

## 1. 模块概述

### 1.1 目的

v2 的插件不是「壳自己约定的 ESM 包」，而是一套**内建机制**（声明 → 目录发现 → 两趟加载 → 治理 → 安装）。本工程**不新造插件框架**，只决定 v1 开哪一档，并把每一档的**落地动作、可见性要求与安全前提**固化为规格：

| 档 | 形态 | v1 采纳 |
|---|---|---|
| **L0 全关** | 不声明 `plugins`、不投放 `plugin/`、`plugins/` 目录 → 插件通道完全静默 | ✅ **v1 默认** |
| **L1 仅本地** | 只允许绝对路径 / 目录插件（壳专用插件随包投放），依赖在构建期预置 | ✅ **v1 允许**（Phase 2 落地） |
| **L2 允许安装** | 打开第二趟安装（联网访问 registry + 写缓存 + 进程内物化） | ⏸ Phase 2 起评估（须先过 O8） |

### 1.2 解决的问题

| # | 问题 | 性质 | 若不处理的后果 |
|---|---|---|---|
| 1 | 插件在**服务端进程内**执行任意第三方 JS，与服务端同权限（文件读写 + 命令执行） | 平台事实 + 本工程配置（L3） | 等于在应用内开一条「无审批的任意代码」通道；与 shell 围栏被绕过是同一类问题 |
| 2 | v1 **没有现成的一键开关**：已核对全部 `OPENCODE_*` 环境变量，**不存在** `OPENCODE_DISABLE_PLUGIN*` | 上游接口缺口（L4） | 「关闭」只能靠「不声明 + 不投放目录」；若要硬开关必须打补丁（候选 `0005-plugin-gate`） |
| 3 | 组织治理（`ManagedPolicy`）只在接入 Console 组织策略时才有内容 | 上游事实 | 不能把「治理」当作本工程的默认安全网 |
| 4 | 安装是「联网 + 落盘 + 进程内执行」三合一动作，且 hmdfs 语义有缺陷（无 hardlink、symlink 应用域不可用、`chmod` 静默） | 平台硬约束（L1） | 安装可能在**不报错**的情况下产出不完整的 `node_modules` |
| 5 | 插件只认**配置目录**下的 `plugin/`、`plugins/`；`resfile`（只读投放区）里的同名目录**不会生效** | 上游事实 | 「把插件放进包就完事」是错的；必须物化到运行时配置目录 |
| 6 | 热重载依赖 `Watcher`，而本工程用 `OPENCODE_FILEWATCHER_DISABLE=1` 关闭监听 | 本工程配置（L3） | 改插件不会热重载；必须让使用者知道「要重启」 |
| 7 | 远端 well-known 集成清单可贡献配置文档（理论上含 `plugins` 声明） | 上游事实 | 存在「不在本机也不在包里」的第三方声明入口，需要纳管 |

### 1.3 范围

**包含**：

- 三档（L0 / L1 / L2）的行为定义、默认档、切换方式与验收断言。
- 壳专用插件的**物化落点**与投放纪律（copy 而非 symlink；依赖构建期预置）。
- 与 v2 机制的**逐项对齐**：`plugins` 数组语义、配置目录集合、`plugin/` 与 `plugins/` 发现、模块契约、加载两趟、治理、失败可见性、热重载现状。
- 安全前提：进程内同权限执行、`ignoreScripts`、远端声明入口、候选补丁 `0005-plugin-gate`。
- L2 的 O8 前置条件清单。

**不包含**：

- 具体壳专用插件的功能实现（Phase 2 另立规格）。
- 插件市场的浏览 / 搜索 / 更新检查 / 启停（opencode 无对应物，`docs/工程规划-V2.md` §4.4）。
- 内容搜索兜底（候选补丁 `0004-search-ohos`）与 shell 后端（`specs/010-tool-shell/`）。
- 鸿蒙插件包（`*.hsp` / 插件权限体系）——本工程插件是 **Node 包**，不是鸿蒙插件包（`docs/ACL申请清单.md`）。
- 上游补丁机制本身（§6.2）。

## 2. 用户故事

- 作为**使用者**，我希望默认状态下应用**不会**在后台自动联网安装并执行第三方代码；如果某版本开启了安装，我需要明确知道。
- 作为**使用者**，我希望本应用自带的能力（壳专用插件）可用，且不需要我手动安装。
- 作为**使用者**，我希望插件加载失败时能看到「哪个插件、什么错误」，而不是「功能就是不生效」。
- 作为**评审者**，我希望规格明确「插件在服务端进程内、拥有与服务端同等权限」这一事实，并明确 L2 的前置条件，而不是把它留成实现细节。
- 作为**上架责任人**，我希望规格写明「不申请任何鸿蒙插件权限」，避免误判为鸿蒙插件宿主。

## 3. 功能需求

> 编号：`FR-201-NNN`（`docs/工程规划-V2.md` §9.1）。

### 3.1 档位、默认值与可见性

| 编号 | 需求 | 强度 | 来源 / 状态 |
|---|---|---|---|
| FR-201-001 | v1 MUST 默认 **L0**：不声明 `plugins` 配置项、不投放 `<配置目录>/opencode/{plugin,plugins}/` 任何内容 | MUST | `docs/工程规划-V2.md` §3.9、§7.5；✅ 上游机制已核实，本工程落地 ⬜ |
| FR-201-002 | L0 下 `GET /api/plugin` 返回空清单 MUST 视为**预期行为**；UI 与验收脚本 MUST NOT 将其判定为故障 | MUST | 同上 §7.5；⬜ 接口字段与状态枚举核对 |
| FR-201-003 | 档位切换 MUST 是**显式配置**（构建期常量或宿主装配期配置），MUST NOT 由模型、工具调用或远端清单在运行时开启安装通道 | MUST | 设计决策（与 §3.8「部署期状态不是模型输入」同口径） |
| FR-201-004 | L1 的壳专用插件 MUST 由构建期脚本物化到 `<userData>/config/opencode/plugin/<name>/`（即 `<XDG_CONFIG_HOME>/opencode/plugin/`）；直接投放到 `resfile` MUST NOT 被当作生效手段 | MUST | 同上 §3.9；⬜ 本工程落地核对 |
| FR-201-005 | 插件物化 MUST 用 **copy**（禁 `symlink`、禁 `hardlink`）；插件依赖 MUST 在构建期预置（不得依赖运行时联网） | MUST | 同上 §3.9；平台语义 ✅ dsh 真机（应用域 symlink `EACCES`、hmdfs 无 hardlink） |
| FR-201-006 | 任何档位下，插件加载失败、被治理阻断（`blocked`）、或处于 `pending` MUST 在壳层可见（UI 状态或日志），MUST NOT 静默失败 | MUST | 同上 §7.5；⬜ 可见性落点本工程设计 |

### 3.2 与 v2 机制的对齐

| 编号 | 需求 | 强度 | 来源 / 状态 |
|---|---|---|---|
| FR-201-007 | 声明语义 MUST 与 v2 一致：`plugins` 数组中 `"<pkg>"` = 启用/安装；`{ package, options }` = 带选项启用；`"-<target>"` 前缀 = 移除；支持 `file://` 目标 | MUST | 同上 §3.9（`packages/schema/src/config/plugin.ts`、`core/src/config/plugin/source.ts#parse`）✅ 源码核实 |
| FR-201-008 | 相对目标 MUST 按**所属配置文件所在目录**解析 | MUST | 同上 §3.9 ✅ |
| FR-201-009 | 目录自动发现 MUST 只认两个名字：`plugin` 与 `plugins`（位于各**配置目录**之下），采纳其中的 `.ts` / `.js` 文件或目录；本工程 MUST NOT 自造目录名 | MUST | 同上 §3.9（`core/src/plugin/source-directory.ts`）✅ |
| FR-201-010 | 配置目录集合 MUST 被显式列出并纳入构建期校验：全局 `<XDG_CONFIG_HOME>/opencode`（本工程 = `<userData>/config/opencode`）、各项目根、兼容目录 `<home>/.claude` 与 `<home>/.agents`（受 `global` 开关控制） | MUST | 同上 §3.9（`core/src/config/discovery.ts`）✅；⬜ 兼容目录是否需要在 L0 下屏蔽 |
| FR-201-011 | 本地插件加载语义 MUST 明确：绝对路径目标走插件 source runtime（`sources.read(entrypoint)`）并对其做文件系统监听 | MUST | 同上 §3.9 ✅；本工程监听被关闭见 FR-201-013 |
| FR-201-012 | 插件模块契约 MUST 为默认导出 `{ id, effect }` 或 `{ id, setup }`；SDK 由产物前导注入；插件 MUST NOT 直接 import 上游内部路径 | MUST | 同上 §3.9（`packages/cli/vite.node.config.ts#nodePrelude`：`opencode:plugin-v2*` + `globalThis[Symbol.for("opencode.plugin.v2.*")]`）✅ |
| FR-201-013 | 热重载 MUST 视为**不可用**：`OPENCODE_FILEWATCHER_DISABLE=1` 使 `Watcher` 为空实现，插件变更不热重载；文档与 UI 提示 MUST 说明「改插件需重启服务端/应用」 | MUST | 同上 §3.9、§7.5 ✅；⬜ 本工程复验 |
| FR-201-014 | 治理语义 MUST 被记录：`ManagedPolicy` 对 `integration.use` 与 `plugin:<target>` 判 `deny` 时返回 `blocked` 并**静默禁用**该插件；策略来自 Console 组织连接，本地不可直接写 | MUST | 同上 §3.9 ✅ |
| FR-201-015 | 加载失败可见性 MUST 通过上游既有通道：`GET /api/plugin` 的 inventory（`status: "failed"` + `error` + `ref`）；`plugin.check` / `plugin.update` 走 `PluginUpdate` | SHOULD | 同上 §3.9（`packages/server/src/handlers/plugin.ts`）✅ |

### 3.3 L2 安装档与安全前提

| 编号 | 需求 | 强度 | 来源 / 状态 |
|---|---|---|---|
| FR-201-016 | L2 安装 MUST 走**进程内** `@npmcli/arborist`（`reify({save, saveType:"prod", ignoreScripts:true, binLinks:true, audit:false})`），MUST NOT spawn 包管理器 | MUST | 同上 §3.9、§7.2（`packages/util/src/npm.ts`）✅ 源码核实 |
| FR-201-017 | L2 MUST 保持 `ignoreScripts: true`（不执行 `postinstall` 等生命周期脚本） | MUST | 同上 §7.5 ✅；⬜ 本工程保持该设置的落地核对 |
| FR-201-018 | L2 安装的落点 MUST 明确：缓存 `<XDG_CACHE_HOME>/opencode/npm/<key>`（本工程 = `<userData>/cache/opencode/npm/`），并经 EffectFlock 串行化与 generation 目录切换 | MUST | 同上 §3.9 ✅ |
| FR-201-019 | L2 启用前 MUST 完成 **O8** 前置验证：① 物化在 `hmfs` 上的 hardlink / symlink / `chmod` 语义（无 hardlink、应用域无 symlink、`chmod` 静默）② registry 可达性与镜像配置 ③ 安装体积 ④ 失败可见性 | MUST | 同上 §11.2 O8；⬜ 真机 PoC |
| FR-201-020 | L2 启用时 SHOULD 同时提供：**硬开关**（候选补丁 `0005-plugin-gate`：在读 `ConfigPluginSource` 处短路，或提供「仅本地插件」档）与 registry 镜像配置（经 `@npmcli/config` 读取 `.npmrc` / `npm_config_*`） | SHOULD | 同上 §3.9、§6.2；⬜ 补丁落地 |
| FR-201-021 | 远端 well-known 集成清单可贡献配置文档（理论上含 `plugins` 声明）MUST 被纳入审计：L0 / L1 下 MUST 保证其无法开启安装通道 | MUST | 同上 §3.9、§7.5（`core/src/config.ts#loadWellknown`、`core/src/wellknown.ts`）✅；⬜ 实施时确认来源与是否需要禁用 |
| FR-201-022 | 规格、README 与 UI MUST 如实记录：**插件在服务端进程内执行，与服务端同等权限（文件读写 + 命令执行）**；MUST NOT 声称插件被沙箱隔离 | MUST | 同上 §7.5；与 `specs/010-tool-shell/` 同一安全面 |
| FR-201-023 | 本工程 MUST NOT 申请任何鸿蒙插件类受限权限（`kernel.SUPPORT_PLUGIN` / `INSTALL_PLUGIN_BUNDLE` / `UNINSTALL_PLUGIN_BUNDLE` / `PLUGIN_UPDATE`） | MUST | `docs/工程规划-V2.md` §8.3；`docs/ACL申请清单.md` |

### 3.4 构建期与验收

| 编号 | 需求 | 强度 | 来源 / 状态 |
|---|---|---|---|
| FR-201-024 | 构建期 MUST 校验档位与投放面一致：L0 ⇒ 包内无 `plugin` / `plugins` 目录投放且配置无 `plugins` 声明；L1 ⇒ 壳专用插件已物化且 `package.json` 完备 | MUST | 设计决策；⬜ 守卫落点在本工程构建脚本 |
| FR-201-025 | 物化 MUST 幂等（重复执行不产生错误、不丢用户插件），且与 `docs/工程规划-V2.md` §6.1 的四阶段流水线一致 | MUST | 同上 §6.1；⬜ 本工程落地 |
| FR-201-026 | 验收脚本 MUST 断言：L0 下 `GET /api/plugin` 为空清单且 `plugin/` 目录不存在（或为空）；L1 下壳专用插件出现在 inventory 且 `status` 非 `failed` | MUST | 设计决策；⬜ 真机断言 |

## 4. 关键实体

| 实体 | 说明 | 关键属性 |
|---|---|---|
| `PluginTier` | 档位 | `L0` / `L1` / `L2` + `source`（构建期常量 / 宿主配置） |
| `PluginDeclaration` | `plugins` 数组中的一条声明 | `target`、`kind`（`enable` / `withOptions` / `remove`）、`options`、`fileUrl` |
| `PluginDiscoveryDir` | 插件发现目录 | `configDir`（全局 / 项目 / 兼容目录）、`names ∈ {plugin, plugins}`、`entries[]` |
| `PluginInventoryEntry` | 上游 inventory 的一条记录 | `id`、`status`（`active` / `pending` / `failed` / `blocked`）、`error`、`ref` |
| `PluginMaterialization` | 壳专用插件的物化记录 | `name`、`srcDir`（本工程 `plugins/`）、`dstDir`（`<userData>/config/opencode/plugin/<name>/`）、`method`（`copy`） |
| `PluginGate` | 候选补丁 `0005-plugin-gate` 的开关语义 | `mode`（`off` / `local-only` / `install`）、`intercept`（`ConfigPluginSource` 读取处短路） |
| `O8Probe` | L2 前置探针结果 | `fsSemantics`（hardlink / symlink / chmod 回读）、`registryReachable`、`installBytes`、`failureVisibility` |

## 5. 验收场景

### 场景 1：L0 默认（v1）

- **Given** 未声明 `plugins`，且 `<userData>/config/opencode/` 下无 `plugin/`、`plugins/` 目录
- **When** 服务端启动并审查插件通道
- **Then** `GET /api/plugin` 返回空清单（**预期行为**）；无任何插件被加载；无网络安装动作；壳层不把该结果当故障

### 场景 2：L1 本地插件加载成功

- **Given** 档位为 L1，壳专用插件已物化到 `<userData>/config/opencode/plugin/<name>/`
- **When** 服务端启动并扫描配置目录
- **Then** 该插件进入 inventory 且 `status` 非 `failed`；插件 `id` 与物化目录名一致

### 场景 3：L1 插件加载失败可见

- **Given** 插件 `package.json` 损坏或入口文件缺失
- **When** 服务端加载该插件
- **Then** inventory 中出现 `status: "failed"` + `error` + `ref`；壳层（UI 或日志）显示该失败；MUST NOT 静默

### 场景 4：物化不使用链接

- **Given** 本工程 `plugins/<name>/` 源码目录
- **When** 构建期执行物化
- **Then** 目标目录为**真实文件拷贝**；MUST NOT 出现 `symlink` / `hardlink`；重复执行结果一致

### 场景 5：热重载不生效

- **Given** 以 `OPENCODE_FILEWATCHER_DISABLE=1` 启动
- **When** 运行中修改插件文件
- **Then** 行为不变；壳层提示「需重启服务端/应用」；MUST NOT 声称已热重载

### 场景 6：L2 未启用时的安装类声明

- **Given** 档位为 L0 / L1，但某处（本机配置或远端 well-known 清单）声明了 npm 包插件
- **When** 服务端处理该声明
- **Then** 该插件处于 `pending` / 未安装状态且壳层可见提示；**不发生联网安装**；MUST NOT 静默失败

### 场景 7：治理阻断可见

- **Given** 组织策略对某插件判 `deny`
- **When** 服务端加载该插件
- **Then** 该插件被标记 `blocked` 并出现在 inventory（上游语义为静默禁用），壳层 SHALL 给出可见提示以免使用者误判为「插件没写对」

## 6. 非功能需求

- **默认安全**：v1 默认不开放「联网 + 落盘 + 进程内执行」的安装通道；任何开放都必须显式配置。
- **失败可见**：`pending` / `failed` / `blocked` 三类状态 MUST 有壳层可见面（沿用 `docs/工程规划-V2.md` §5.2 的 fail-visible 纪律）。
- **幂等**：物化、校验、档位切换均可重复执行。
- **可审计**：档位取值、物化清单、`GET /api/plugin` 的摘要 MUST 写入 `[oc-desktop]` 日志。
- **权限最小**：不申请任何鸿蒙插件权限；不新增权限声明（`docs/ACL申请清单.md`）。
- **诚实披露**：安全面（进程内同权限）不得被弱化表述。

## 7. 假设与约束

**假设（逐条待验证）**

- ⬜ **待验证** 1：`GET /api/plugin` 的响应字段与状态枚举（`active` / `pending` / `failed` / `blocked`）需与上游 handler 逐字段核对，本规格的字段名为转述。
- ⬜ **待验证** 2：L1 的「绝对路径 / `file://` 目标」是否**完全跳过安装趟**（supervisor 两趟逻辑中第一趟 `install:false` 的行为需在本工程确认）。
- ⬜ **待验证** 3：插件 SDK 注入（`opencode:plugin-v2*` 模块钩子 + `globalThis[Symbol.for(...)]`）在 Electron 37 / Node 22.17 下的实际可用性（产物前导是否完整保留）。
- ⬜ **待验证** 4：`<XDG_CONFIG_HOME>/opencode` 与 `OPENCODE_CONFIG_DIR` 的覆盖关系（决定物化目标目录的唯一取值）；见 `specs/012-data-dirs-sqlite/` FR-012-007。
- ⬜ **待验证** 5：兼容目录 `<home>/.claude`、`<home>/.agents` 在 L0 / L1 下是否需要屏蔽（`global` 开关的取值与影响）。
- ⬜ **待验证** 6：远端 well-known 集成清单的真实来源、是否可贡献 `plugins`，以及是否需要显式禁用。
- ⬜ **待验证** 7：**O8** —— 进程内 Arborist 在设备上的可用性（hmdfs/hmfs 物化语义、registry 可达性、体积、失败可见性）；须真机 PoC（声明一个最小 npm 包插件，观察 `pending` → 成功/`failed`）。
- ✅ **已核实**：v2 **不存在** `OPENCODE_DISABLE_PLUGIN*` 一类开关（已逐一核对全部 `OPENCODE_*` 环境变量），故「关闭」只能靠「不声明 + 不投放」或补丁 `0005-plugin-gate`。

**约束**

- 约束 1：**插件与服务端同权限**（文件读写 + 命令执行），与 `specs/010-tool-shell/` 的 shell 通道共同构成「进程内任意代码」安全面。
- 约束 2：**热重载不可用**（`OPENCODE_FILEWATCHER_DISABLE=1`）属已定配置，不因插件通道而改变。
- 约束 3：**不新增上游分叉**：L2 的闸门以「新增文件 + 少量开关式改动」的最小补丁实现。
- 约束 4：**本工程插件是 Node 包**，与鸿蒙插件包无任何关系；不申请任何 `*PLUGIN*` 权限。
- 约束 5：**L0 不等于「功能缺失」**：应用的核心能力（会话、文件、shell、搜索兜底）MUST NOT 依赖插件通道。

## 8. 依赖

**上游（opencode v2.0.26）**

- `packages/schema/src/config/plugin.ts`、`packages/core/src/config/plugin/{source,policy}.ts` —— 声明解析与治理。
- `packages/core/src/plugin/{module,supervisor,internal}.ts`、`packages/core/src/plugin/source-directory.ts` —— 加载、两趟激活、目录发现。
- `packages/core/src/config/discovery.ts` —— 配置目录集合。
- `packages/util/src/{npm,npm-config}.ts` —— 进程内 Arborist 与 registry 配置。
- `packages/cli/vite.node.config.ts#nodePrelude` —— 插件 SDK 注入。
- `packages/server/src/handlers/plugin.ts` —— `GET /api/plugin`、`/api/plugin/check`、`/api/plugin/update`。
- `packages/core/src/{config.ts#loadWellknown,wellknown.ts}` —— 远端声明入口。

**本工程其它模块**

- `specs/012-data-dirs-sqlite/` —— 提供 `<XDG_CONFIG_HOME>` / `<XDG_CACHE_HOME>`（物化与安装落点的前提）。
- `specs/010-tool-shell/` —— 共同构成进程内代码执行安全面。
- `specs/202-skill-runtime-capabilities/` —— 能力清单的规范源；壳专用插件与壳专用技能 MUST 保持披露一致。
- `docs/ACL申请清单.md` —— 「不申请 `*PLUGIN*` 权限」的判定依据。
- `docs/真机验证记录.md` —— O8 与档位验收结论的落点。
