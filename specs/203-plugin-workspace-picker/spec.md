# 选择工作区目录插件（203-plugin-workspace-picker）—— 规格

> **Module:** 203-plugin-workspace-picker ｜ **Status:** Implementing ｜ **Last Updated:** 2026-10-14 ｜ **上游基线:** opencode v2.0.26（Branch_v2.0.26）
>
> **证据口径**（沿用 `docs/工程规划-V2.md` §0.2）：✅ **实测**（真机或上游源码直接验证）｜🔶 **沿用**（同型工程或既有调研结论，本工程未复现）｜⬜ **待验证**（本工程必须自行实测）。
> **本工程状态**：模块设计已完成并进入实施；设备行为条目按 `docs/203-插件-选择工作区目录.md` §14 的验收标准在真机取证。

## 1. 模块概述

### 1.1 目的

让「打开项目 / 选择工作区目录」对话框提供**四个主目录**（沙箱 / 桌面 / 文档 / 下载）的切换、逐级浏览、
新建文件夹与选定，从而把**已授权的用户目录**中的文件夹注册为 opencode 项目根。

本模块由两半构成，边界清晰：

- **能力半**：壳专用 opencode 插件 `plugins/oc-plugin-workspace-roots/`。它运行在**服务端进程**（`inprocess` 形态下即
  Electron 主进程），经 `context.rpc.register` 注册 5 个方法，提供只有主进程才具备的能力：
  四主目录绝对路径解析（含沙箱根自动创建）、主目录内建目录、三项权限的预检与申请、本应用信息页深链。
  该 RPC 只承载**壳侧原生能力**（路径 / 建目录 / 权限结果），**不承载会话或项目数据**。
- **UI 半**：上游补丁 `patches/v2.0.26/0007-workspace-roots-picker.patch`，在应用内 `DirectoryPickerDialog` 上
  增加四主目录 Tab、根围栏导航、新建文件夹，并在四主目录模式下移除手动路径输入。
  补丁**自门控**：能力 RPC 不可达时完整回退上游行为。

目录**数据**仍走上游既有 Typert RPC（`fs/list`），不自实现文件系统。

完整设计来源：[`docs/203-插件-选择工作区目录.md`](../../docs/203-插件-选择工作区目录.md)。

### 1.2 解决的问题

- **已授权用户目录无法用于打开项目**：真机已登记「`打开项目` 只能选定预填路径，不能浏览」
  （`docs/鸿蒙环境能力清单-v2.0.26.md` §11.4-2）；对话框起点被重定向的 `HOME` 固定落在沙箱内。
- **替换必须走既有接缝**：上游插件机制**没有 UI 钩子**，`gui-extensions` 只认编译进包内的 builtins 且不能拦截既有对话框
  （`docs/203-插件-选择工作区目录.md` §2 `#13`）。因此「能力用插件、UI 用最小补丁」是唯一可行落点。
- **渲染层拿不到主进程能力**：ArkWeb/Chromium 同源加载的页面没有 Node，既看不到真实家目录，
  也无法触达 ArkTS 权限桥（`§2 #10`）。必须由服务端进程经 HTTP RPC 代答。
- **新建目录通道缺失**：上游协议只有 `fs/list` / `fs/find` / `experimental/fs/write`（写文件），**无 `mkdir`**（`§2 #6`）。
- **浏览边界必须显式锁定**：四主目录互为隔离浏览域，只向下、不上溯、无手动路径输入（§5 FR-3 / §4 根围栏）。

### 1.3 范围

**包含**：

- 壳专用插件：`plugins/oc-plugin-workspace-roots/`（`index.js` / `package.json` / `README.md`）及其 RPC 契约。
- 上游补丁：`patches/v2.0.26/0007-workspace-roots-picker.patch`（`packages/app/src/workspaces/selection/*` 与 `en.ts` / `zh.ts` 文案）。
- 宿主注入：`src-main/main.js` 在改写 `HOME` **之前**捕获真实家目录并落 `OCR_USER_ROOTS`（三用户主目录绝对路径）。
- 构建/运行期复用：`scripts/collect-app.mjs` 的 `oc-plugin-*` 通配投放；`materializePlugins()` 的 copy 物化（**无需改脚本**）。
- 本模块的 `spec.md` / `plan.md` / `tasks.md` / `test-cases.md` 与 `docs/203-插件-选择工作区目录.md`。
- 真机编译、部署与 `--inspect` 功能测试。

**不包含**：

- 上游源码入库改动（一律以补丁落地；`../opencode` 工作树不提交）。
- `packages/protocol` / `packages/server` 改动（复用既有 `POST /api/rpc/:rpcID/:method`，**零 codegen**）。
- ArkTS 改动（`ContextPathAdapter.getUser*Dir` 保持空实现；路径走 FR-203-004）。
- 权限**声明面**改动（只消费 `006-signing-identity` 已声明的三项目录权限）。
- 整盘浏览、文件选择、多选、重命名、删除、隐藏文件开关、手动路径输入。
- 收紧 `fs/list` 的根限制（§5 根围栏说明中已披露性质；属独立变更）。
- 父工程 `specs/` 登记（本模块规格仅落在 `oc-desktop-hos/specs/`）。
- Git 分支改动。

## 2. 用户故事

- 作为用户，我希望在「打开项目」对话框顶部切换到桌面 / 文档 / 下载，以便把这些已授权目录中的文件夹注册为项目。
- 作为用户，我希望选定主目录后能逐级进入子文件夹、在其中新建文件夹并选中。
- 作为用户，当某个用户目录尚未授权时，我希望在对话框内完成授权并继续，不必自己去找系统设置。
- 作为用户，我希望下次打开对话框时默认停留上次使用的主目录。
- 作为排障者，我希望从 hilog 与 `--inspect` 即可确认四主目录路径解析、插件激活与 RPC 在役。

## 3. 功能需求

> 编号：`FR-203-NNN`（`docs/工程规划-V2.md` §9.1）。

### 3.1 主目录与解析

| 编号 | 需求 | 强度 | 来源 / 状态 |
|---|---|---|---|
| FR-203-001 | 对话框 MUST 提供四个主目录：`sandbox` / `desktop` / `documents` / `download`；切换时 MUST 把浏览视图重置为该主目录根、清空选中并重新列举 | MUST | 设计决策；⬜ 真机 |
| FR-203-002 | 默认主目录 MUST 取上次使用值（FR-203-020）；首次使用 MUST 为 `sandbox` | MUST | 设计决策；⬜ 真机 |
| FR-203-003 | 沙箱主目录 MUST 为 `path.join(app.getPath('userData'), 'workspace')`，与既有工作区根为**同一取值**；解析时 MUST 检查存在性，缺失则 `mkdir recursive` 自动创建 | MUST | `src-main/main.js` `ensureWorkspace()`；⬜ 真机 |
| FR-203-004 | `desktop` / `documents` / `download` MUST 取自宿主在改写 `HOME` **之前**捕获的真实家目录下的 `Desktop` / `Documents` / `Download`，并以绝对路径经 `OCR_USER_ROOTS` 传给服务端进程 | MUST | 设计决策；真机 `homedir()` = `/storage/Users/currentUser`（`docs/鸿蒙环境能力清单-v2.0.26.md` §11 `#17`）；⬜ 真机 |
| FR-203-005 | 每个用户主目录 MUST 逐个做「存在且为目录」校验；不满足 MUST 标记 `available: false` 并给出原因，该 Tab 仍可见但内容区显示不可用说明与重试入口；MUST NOT 静默换根、MUST NOT 回退到其它主目录 | MUST | 设计决策；⬜ 真机 |
| FR-203-006 | 四个主目录的解析结果 MUST 以 `[oc-desktop]` 前缀落结构化日志（id / 绝对路径 / 可用性 / 时间戳） | MUST | `docs/工程规划-V2.md` §5.2（fail-visible 纪律） |

### 3.2 浏览与根围栏

| 编号 | 需求 | 强度 | 来源 / 状态 |
|---|---|---|---|
| FR-203-007 | 目录列举 MUST 复用上游 `fs/list`（`sdk.api.file.list`），MUST NOT 自实现文件系统遍历；只列目录、名称排序 | MUST | ✅ 上游源码 `packages/app/src/workspaces/selection/domain.ts:387`、`packages/core/src/filesystem.ts:176-178` |
| FR-203-008 | 浏览 MUST NOT 上行到当前主目录根之上：导航目标在进入前 MUST 经根包含性判定，不满足时 MUST 忽略该次导航（不改变视图、不抛错） | MUST | 设计决策（安全属性）；host 侧可判定 |
| FR-203-009 | 四主目录模式下 UI MUST NOT 存在手动路径输入（path 输入框与其建议浮层）；采纳值 MUST NOT 由用户自由文本给出 | MUST | 设计决策；UI 检查 |
| FR-203-010 | 只渲染宿主判定为非隐藏的条目；MUST NOT 提供「显示隐藏文件」开关 | MUST | 设计决策；UI 检查 |
| FR-203-011 | 列举返回截断/超限时 MUST 就地可见；列举被拒且该主目录不可用时 MUST 就地显示原因与「重试」，MUST NOT 只抛原始错误码 | MUST | 设计决策；⬜ 真机 |

### 3.3 新建文件夹

| 编号 | 需求 | 强度 | 来源 / 状态 |
|---|---|---|---|
| FR-203-012 | 四主目录模式下 MUST 提供「新建文件夹」，输入**单个目录段名称** | MUST | 设计决策；⬜ 真机（上游协议无 mkdir，`§2 #6`） |
| FR-203-013 | 默认名 MUST 为 `未命名文件夹`（英文界面 `Untitled folder`）；同级冲突时 MUST 追加序号（`2`、`3`…） | MUST | 设计决策 |
| FR-203-014 | 名称 MUST 在服务端再校验：空串 / 含路径分隔符 / `.` 或 `..` / 控制字符 MUST 被拒绝并返回可归因错误 | MUST | 设计决策；host 侧可判定 |
| FR-203-015 | 创建目标 MUST 落在当前主目录内（服务端按真实路径做包含性校验）；越界 MUST 被拒绝且 MUST NOT 创建任何目录 | MUST | 设计决策（安全属性）；host 侧可判定 |
| FR-203-016 | 同名已存在 MUST 返回「已存在」类错误；MUST NOT 覆盖、MUST NOT 静默成功 | MUST | 设计决策；host 侧可判定 |
| FR-203-017 | 创建成功后 MUST 重新列举并选中新建目录 | MUST | 设计决策 |

### 3.4 选择、采纳与授权

| 编号 | 需求 | 强度 | 来源 / 状态 |
|---|---|---|---|
| FR-203-018 | 「打开/选择文件夹」MUST 采纳当前选中目录；采纳值 MUST 为**绝对真实路径**并经既有 `onSelect(path)` 回传，复用上游工作区采纳链路（不改采纳语义）；采纳前 MUST 再次做根包含性判定 | MUST | ✅ 上游 `packages/app/src/workspaces/selection/dialog.tsx` `resolve()`；设计决策 |
| FR-203-019 | 「取消」或关闭对话框 MUST 触发 `onSelect(null)` | MUST | ✅ 上游 `picker.tsx` `cancel()` |
| FR-203-020 | 主目录选择 MUST 持久化到渲染层 `localStorage`（插件私有前缀键）；**只记主目录、不记子路径**；存储值非法时 MUST 回退 `sandbox`；记忆值本次不可用时 MUST 回退 `sandbox` 并在 UI 明示 | MUST | 设计决策；⬜ 真机 |
| FR-203-021 | 用户主目录列举被拒（`EACCES` / `EPERM`）时 MUST 先预检权限；未授权 MUST 在对话框内发起系统授权请求并进入 loading 态 | MUST | ✅ ArkTS 绑定 `PermissionManagerAdapter.{CheckPermissions,RequestPermissionCode}` 已存在（`web_engine/src/main/ets/jsbindings/PermissionManagerAdapterBind.ets:36-43`）；⬜ 真机 |
| FR-203-022 | 授权回调为已授权后 MUST **重试一次全新的列举**，并 MUST **以列举是否成功作为唯一事实判据**；MUST NOT 仅凭 `CheckPermissions` 返回值判定成功 | MUST | 🔶 沿用同型工程真机结论（F8）：check 桥在系统开关已开时仍可能返回 `false` |
| FR-203-023 | 授权失败/拒绝时 MUST 展示原因 + 「去系统设置」入口（经 `ElectronApp.OpenApplicationInfoEntry` 深链到本应用信息页）；返回后用户可手动重试 | MUST | ✅ 绑定已存在（`web_engine/src/main/ets/jsbindings/ElectronAppAdapterBind.ets:60`）；⬜ 真机 |
| FR-203-024 | 权限桥不可用（`electron` 不可达 / 无 active context / 回调类型非预期）时 MUST 明确归因提示，MUST NOT 静默失败、MUST NOT 假装成功 | MUST | 设计决策；host 侧可判定 |
| FR-203-025 | 本模块 MUST NOT 新增权限声明；权限相关操作 MUST NOT 改变权限声明面或插件树状态 | MUST | `specs/006-signing-identity` FR-006-011 / FR-006-025 |

### 3.5 装配与加载

| 编号 | 需求 | 强度 | 来源 / 状态 |
|---|---|---|---|
| FR-203-026 | 能力插件 MUST 为壳专用 opencode 插件，目录名 = npm 包名 = `oc-plugin-workspace-roots`；MUST 以 `export default { id, setup }` 形态导出 | MUST | `plugins/README.md` §4；✅ `plugins/oc-plugin-harmony-shell/index.js:377-401` |
| FR-203-027 | 插件 MUST 经 `context.rpc.register` 注册 RPC，MUST NOT 依赖新增协议组或重新生成客户端 | MUST | ✅ `packages/protocol/src/groups/rpc.ts:14-20`、`packages/client/src/promise/generated/client.ts:1689-1695` |
| FR-203-028 | UI 改动 MUST 以 `patches/v2.0.26/0007-*.patch` 落地并保持幂等（`build-opencode.mjs` 可重复运行不冲突）；MUST NOT 修改上游源码入库 | MUST | ✅ `scripts/build-opencode.mjs:89-107` |
| FR-203-029 | 插件 MUST 满足 `plugins/` 准入条件（不依赖 PTY、不 spawn、不依赖原生模块），并 MUST 通过 `scripts/collect-app.mjs` 的静态断言与投放校验 | MUST | `plugins/README.md` §5；✅ `scripts/collect-app.mjs` |
| FR-203-030 | 四主目录模式 MUST 自门控：能力 RPC 不可达时 MUST 完整回退上游对话框行为（不出现半残状态），使补丁对非本壳的 `platform === "web"` 部署零影响 | MUST | 设计决策；host 侧用例 |
| FR-203-031 | 新增用户可见文案 MUST NOT 含上架禁用词（`Harmony` / `DeepSeek`）与以本应用为指称的 `OpenCode`；MUST 通过 `scripts/verify-branding.mjs` 全部断言 | MUST | `docs/工程规划-V2.md` §8.5 G8；✅ `scripts/verify-branding.mjs` |

## 4. 关键实体

| 实体 | 说明 | 关键属性 |
|---|---|---|
| `RootId` | 主目录标识 | `"sandbox"` / `"desktop"` / `"documents"` / `"download"` |
| `RootInfo` | 一个主目录的解析结果 | `id`、`path`（绝对路径，不可用时为 `null`）、`available`、`reason`（不可用原因） |
| `RootSet` | 一次 `roots` 调用的结果 | `home`（真实家目录，仅用于诊断）、`roots: RootInfo[]` |
| `MkdirRequest` | 建目录请求 | `id`、`parent`（绝对路径）、`name`（单个目录段） |
| `PermissionProbe` | 权限预检结果 | `id`、`granted`、`source`（`bridge` / `unavailable`） |
| `PermissionRequest` | 一次授权申请结果 | `id`、`code`（`0` = 已授权）、`bridgeUnavailable`（桥不可达标记） |
| `DirectoryPolicy` | 客户端根围栏策略 | `isWithin(root, path)`、`rootOf(path)`、`defaultFolderName(existing, base)` |

## 5. 验收场景

### 场景 1：四主目录切换（负例：不可用主目录）

- **Given** 应用已启动、插件已加载、四主目录能力 RPC 在役
- **When** 打开「打开项目」对话框并依次切换四个 Tab
- **Then** 每次列对应主目录根、浏览视图重置；对不可用主目录，内容区显示原因与「重试」，**不换根**

### 场景 2：沙箱根自动创建

- **Given** `<userData>/workspace` 已被删除
- **When** 打开对话框并切到「沙箱」
- **Then** 该目录被自动重建（`mkdir recursive`）并正常列出；日志记录路径与可用性

### 场景 3：用户目录浏览与路径

- **Given** `Documents` / `Download` 已授权
- **When** 切到「文档」并逐级进入
- **Then** 列出其下条目；当前路径前缀为 `/storage/Users/currentUser/Documents`

### 场景 4：根围栏（负例必存）

- **Given** 当前主目录为「文档」
- **When** 触发一次指向 `/storage/Users/currentUser` 或 `/` 的导航
- **Then** 该次导航被**忽略**，视图保持不变，不抛错；UI 中不存在可提交该路径的输入入口

### 场景 5：新建文件夹（含去重与负例）

- **Given** 当前主目录为「沙箱」，且目录内已存在 `未命名文件夹`
- **When** 连续两次「新建文件夹」并使用默认名
- **Then** 得到 `未命名文件夹 2`、`未命名文件夹 3`，创建后自动选中；沙箱外路径的 `mkdir` 请求被拒绝且未创建任何目录；同名已存在时返回「已存在」类错误

### 场景 6：未授权用户目录（负例必存）

- **Given** 「桌面」未授权（系统设置中未开「文件和文件夹」）
- **When** 切到「桌面」
- **Then** 视情况在对话框内发起授权；若归档为已授权则**重试列举**，成功才渲染；若失败/拒绝则显示原因 + 「去系统设置」，**MUST NOT** 只显示 `EACCES`

### 场景 7：采纳工作区

- **Given** 当前主目录为「下载」且已选中其下一个子目录
- **When** 点「选择文件夹」
- **Then** `onSelect(<绝对路径>)` 被调用，上游成功创建/切换工作区；若上游创建失败，出现可重试的错误框

### 场景 8：主目录记忆（含非法值负例）

- **Given** 上次使用「桌面」并在其下进入过子目录
- **When** 关闭对话框后重新打开
- **Then** 停在「桌面」**根**（不恢复子路径）；把 `localStorage` 值改成非法值时回退「沙箱」

### 场景 9：能力不可用回退（负例必存）

- **Given** 插件未激活或 RPC 未注册（例如非本壳部署 / 插件加载失败）
- **When** 打开对话框
- **Then** 完整回退上游对话框行为（含手动路径输入与既有浏览逻辑），**不出现半残状态**

### 场景 10：插件在役与 RPC 可调用

- **Given** 真机已部署本次构建并保留 `--inspect`
- **When** 经 CDP 调用 `POST /api/rpc/oc-harmony-workspace-roots/roots`
- **Then** 返回四个主目录条目，`sandbox` 为 `/data/storage/el2/base/files/workspace`，三个用户目录路径前缀为 `/storage/Users/currentUser`；启动日志有插件加载记录

## 6. 非功能需求

- **失败可见**：主目录解析、列举被拒、建目录失败、权限桥不可用四类事件 MUST 有日志或 UI 提示；禁止「卡在对话框但不说明原因」。
- **边界清晰**：四主目录互为隔离浏览域；UI 与服务端各自独立做包含性判定，不互为依据。
- **幂等**：`roots` / `permissionCheck` 可重复调用，结果稳定；`mkdir` 对已存在名称返回错误而不覆写（不产生副作用）。
- **可诊断**：错误 MUST 带原始错误码或可归因原因；不得吞掉 `EACCES` / `EPERM`。
- **零新增权限面**：不新增权限声明；不改变已有声明面。
- **不劣化既有链路**：非本壳部署与 `platform === "desktop"`（原生选择器）行为 MUST 不受影响。
- **凭据纪律**：规格、测试用例、日志与提交信息一律不出现真实凭据（`specs/README.md` §6）。

## 7. 假设与约束

**假设（逐条待验证）**

- ⬜ 假设 1：`--inspect` 在 debug 构建下可用，且 `hdc fport` + CDP 可连到服务端进程（`inprocess` 形态）以调用 `rpc.call`。定论方式：真机命令；结论回写 `docs/真机验证记录.md`。
- ⬜ 假设 2：插件（ESM，运行在服务端进程）经 `createRequire(import.meta.url)('electron')` 可拿到 `systemPreferences`。定论方式：真机 `--inspect` 调 `permission*` RPC；失败则退化为「仅去系统设置」路径并如实登记。
- ⬜ 假设 3：三个用户目录的绝对路径基址确为 `/storage/Users/currentUser`，且 `Desktop` / `Documents` / `Download` 名称正确。定论方式：真机 `roots` RPC 返回值 + 目录列举；结论回写 `docs/鸿蒙环境能力清单-v2.0.26.md`。
- 🔶 假设 4（沿用）：`RequestPermissionCode` 在 PC 模式 runtime 上可能「返回成功但不弹窗、不改变实际访问」，且 `CheckPermissions` 可能恒返回 `false` ⇒ 授权事实判据必须是「列举成功」（FR-203-022）。沿用来源：`dsh-desktop-hos/plugins/harmony-plugin-workspace-picker/README.md`「真机实测」。
- ⬜ 假设 5：`fs/list` 在真机上对用户目录可用（非授权原因之外无其它阻断）。定论方式：真机列举；失败则如实登记到能力清单。
- ⬜ 假设 6：改动 `packages/app` 不会触发 `scripts/verify-branding.mjs` 的引用点漂移硬失败。定论方式：构建期断言；若触发则同步更新断言而非绕过。

**约束**

- 约束 1：**上游零改动入库** —— 所有上游改动以 `patches/v2.0.26/0007-*.patch` 落地（FR-203-028）。
- 约束 2：**零 codegen** —— 不改协议、不重新生成客户端（FR-203-027）。
- 约束 3：**不加权限声明**（FR-203-025）；桌面权限是否获批由 `006-signing-identity` 的 ACL 批次决定。
- 约束 4：**根围栏是 UI + 插件层围栏，不是内核沙箱** —— `fs/list` 本身不做根限制（与现状一致）；本模块不扩大、也不收紧该 API 面。
- 约束 5：**应用域是唯一可信观测点**（`docs/真机验证记录.md` 纪律 3）；「能否访问用户目录」的判定必须在应用域完成。
- 约束 6：**禁 symlink**；插件物化为 copy（`plugins/README.md` §3）。
- 约束 7：`build-profile.json5` 中的本地签名配置为开发者本地状态，MUST NOT 被本次改动改写。

## 8. 依赖

**上游（opencode v2.0.26）**

- `packages/app/src/workspaces/selection/{policy,picker,dialog,domain}.tsx|ts` —— 对话框与目录策略（补丁落点）。
- `packages/protocol/src/groups/rpc.ts` + `packages/server/src/handlers/rpc.ts` —— `POST /api/rpc/:rpcID/:method`（复用，不改）。
- `packages/plugin/src/promise/{plugin,rpc}.ts` —— `context.rpc.register` 契约。
- `packages/protocol/src/groups/fs.ts` + `packages/core/src/filesystem.ts` —— `fs/list`（复用，不改）。
- `packages/client/src/promise/generated/client.ts` —— `sdk.api.rpc.call` / `sdk.api.file.list`（复用，不改）。

**本工程其它模块**

- `specs/201-plugin-runtime/` —— 插件机制、物化路径与校验（本模块消费其装配约定）。
- `specs/011-workspace-auth/` —— 项目目录选择与授权口径（本模块落地其入口形态；本节不重复其验收口径）。
- `specs/006-signing-identity/` —— 三项目录权限的声明与 ACL 归属（FR-203-025 的依据）。
- `specs/005-build-pipeline/` / `specs/003-artifact-bootstrap/` —— 流水线与产物就位（本模块复用，无改动）。
- `src-main/main.js` —— `configureEnvironment()` / `ensureWorkspace()` / `materializePlugins()`（FR-203-003/004）。
- `docs/ACL申请清单.md` —— 权限声明面的事实来源。
- `docs/鸿蒙环境能力清单-v2.0.26.md` / `docs/真机验证记录.md` —— 真机结论落点。

**下游（消费本模块）**

- 用户可见的「打开项目 / 添加项目」入口（侧栏 / 首页 / 会话内选择目录）。
