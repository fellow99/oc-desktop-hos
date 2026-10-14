# oc-plugin-workspace-roots

OC Desktop（HarmonyOS）专用 opencode 插件：为「选择工作区目录 / 打开项目」对话框提供**四个主目录**
（沙箱 / 桌面 / 文档 / 下载）的壳侧能力 —— 路径解析、主目录内建目录、目录权限桥与应用信息页深链。

对应规格：`specs/203-plugin-workspace-picker/`；设计：`docs/203-插件-选择工作区目录.md`；
UI 侧（四主目录 Tab、根围栏、新建文件夹）由上游补丁 `patches/v2.0.26/0007-workspace-roots-picker.patch` 落地。

## 1. 为什么是插件

渲染层是 ArkWeb/Chromium **同源加载的网页**，没有 Node：

- 看不到真实家目录（宿主启动时已把 `HOME`/`USERPROFILE` 指向沙箱 `userData`）；
- 触达不到 ArkTS（目录权限申请、应用信息页深链只有**主进程**可达）。

插件运行在**服务端进程**，而本工程默认 `OCR_HOST_MODE=inprocess` ⇒ 与 Electron 主进程同进程，
上述两件事天然成立。上游 `@opencode/plugin` **没有 UI 钩子**（只有工具/命令/事件/RPC），
因此本插件只承担「能力」，UI 由最小上游补丁承担。

## 2. 数据面边界

- 目录**数据**（列目录）仍走上游既有 Typert RPC `fs/list`（`sdk.api.file.list`），本插件不自实现文件系统遍历。
- 本插件的 RPC 只承载**壳侧原生能力**（四个主目录绝对路径、主目录内建目录、目录权限结果、应用信息页深链），
  **不承载会话 / 项目数据**。
- 传输复用上游既有端点 `POST /api/rpc/:rpcID/:method`（载荷 `{ input }`，返回 `{ output }`），**无需任何 codegen**。

## 3. RPC 契约

`rpcID = "oc-harmony-workspace-roots"`。所有方法**不抛错**，统一返回结构化结果（`ok` / `code` / `message`）；
输入 schema 保持宽松，具体校验在 handler 内完成（避免上游输入解析把合法调用挡在门外）。

| 方法 | 输入 | 输出 | 语义 |
|---|---|---|---|
| `roots` | `{}` | `{ home, roots: RootInfo[] }` | 解析四个主目录；`RootInfo = { id, path, available, reason }`（不可用时 `path` 为 `""`，`reason` 给出原因） |
| `mkdir` | `{ id, parent, name }` | `{ ok, code, message, path }` | 在主目录 `id` 的 `parent` 下新建单段目录 `name`；`code` ∈ `invalid-name` / `invalid-parent` / `out-of-root` / `exists` / `create-failed` / `root-unavailable` / `root-unknown` |
| `permissionCheck` | `{ id }` | `{ granted, source, message }` | 目录权限预检；`source` ∈ `bridge` / `sandbox` / `unavailable` |
| `permissionRequest` | `{ id }` | `{ code, bridgeUnavailable, message }` | 主动申请目录权限；`code = 0` 表示系统报告已授权（**是否生效以一次全新的列举为准**） |
| `openAppInfo` | `{}` | `{ ok, message }` | 深链到本应用信息页的「文件和文件夹」权限 |

## 4. 四个主目录

| root id | 解析来源 | 真机形态 |
|---|---|---|
| `sandbox` | `path.join(app.getPath('userData'), 'workspace')`，不存在则 `mkdir recursive` 自动创建 | `/data/storage/el2/base/files/workspace` |
| `desktop` | 宿主注入的 `OCR_USER_ROOTS`（真实家目录 + `Desktop`） | `/storage/Users/currentUser/Desktop` |
| `documents` | 同上 + `Documents` | `/storage/Users/currentUser/Documents` |
| `download` | 同上 + `Download` | `/storage/Users/currentUser/Download` |

`OCR_USER_ROOTS` 由 `src-main/main.js` 的 `resolveUserRoots()` 在**改写 `HOME` 之前**解析并逐项做
「存在且是目录」校验（不满足者落 `null` ⇒ 该主目录 `available: false` + `reason`，**不静默换根**）。

## 5. 权限机制

- 权限动作经 Electron 主进程的 ArkTS 桥：`systemPreferences.callArkTSAsyncFunction(...)` →
  `PermissionManagerAdapter.CheckPermissions` / `PermissionManagerAdapter.RequestPermissionCode`
  （**回调风格的绑定必须用 async 形式**，sync 形式返回空信封、不可用）；「去系统设置」走
  `ElectronApp.OpenApplicationInfoEntry`（真机落到本应用信息页的「文件和文件夹」）。
- 权限类型映射：`desktop → directory_desktop`、`documents → directory_document`、`download → directory_download`；
  **沙箱免授权**。

### ⚠️ 真机行为（沿用同型工程结论，本工程待复验）

同类 2-in-1 PC 模式 runtime 上实测（来源：`dsh-desktop-hos/plugins/harmony-plugin-workspace-picker/README.md`）：

- `RequestPermissionCode` 可能**返回 `0` 但不弹任何系统授权框、也不改变实际访问**（fs 仍 `EPERM`）；
- `CheckPermissions` **即使在系统开关已打开、fs 已可读写之后仍返回 `false`**；
- 唯一真正生效的授权面是「系统设置 → 文件和文件夹」里的开关。

因此规格 FR-203-022 明确规定：**授权是否生效以「一次全新的列举是否成功」为唯一事实判据**，
不得仅凭 check 桥的返回值判定；「去系统设置」入口是**必须存在**的兜底路径。

## 6. 根围栏（安全属性）

- `mkdir` 在服务端先 `fs.realpathSync` **消解 symlink** 再判定（失败回落原路径），因此「真实路径包含性」
  成立；`isWithin` 两侧先统一分隔符（POSIX `/` 与宿主 `\` 混用不会假阴性），并**拒绝含 `..` 的相对段**。
- 判定分隔符无关（POSIX `/` 与宿主 `\` 都视为边界），逐段比较以避免 `/a/bc` 被 `/a/b` 命中。
- **性质披露**：`fs/list` 本身不做根限制（与上游现状一致），因此根围栏是 **UI 层 + 插件层围栏**，不是内核沙箱。

## 7. 装配与准入

- 由 `scripts/collect-app.mjs` 按 `oc-plugin-*` 通配投放进 resfile（`resources/app/plugins/`），
  启动期由 `src-main/main.js` 的 `materializePlugins()` **copy**（禁 symlink）到
  `<userData>/config/opencode/plugin/`。
- 满足 `plugins/README.md` §5 准入：不依赖 PTY、不 `spawn`、不依赖原生模块；只用 `node:fs` / `node:path` /
  `node:module` 与 `electron`（经 `createRequire`）。
- `setup()` 在缺少 `context.rpc.register` 时**抛错**（fail-visible：插件在 inventory 里变 `failed`，
  而不是静默什么都不注册、让 UI 误判为「非本壳部署」而回退）。

## 8. Known Limitations

- **只服务四个固定主目录**：不提供整盘浏览、不提供手动路径输入；到达目标只能逐级进入或新建文件夹。
- **不支持重命名 / 删除 / 移动 / 搜索 / 多选**；无「显示隐藏文件」开关（隐藏项由 UI 过滤，不渲染）。
- **权限能力依赖主进程 ArkTS 桥**：`OCR_HOST_MODE=utility|worker` 或普通 Node 宿主下 `electron` 不可达，
  `permission*` / `openAppInfo` 返回结构化降级结果（`bridgeUnavailable` / `source: "unavailable"` + 说明），
  `roots` / `mkdir` 不受影响。故本插件不具备跨壳可移植性（这也是它放在 `plugins/` 而非通用插件目录的原因）。
- **`roots` 的可用性依赖宿主注入**：`OCR_USER_ROOTS` 缺失或家目录推导有误时，三个用户主目录会全部标记不可用；
  此时应改由 ArkTS 侧实现 `ContextPathAdapter.getUser*Dir`（当前为空实现）并登记 `collect-runtime` 的
  改写/overlay 规则（属独立变更，见 `docs/203-插件-选择工作区目录.md` §15）。
- **「请求授权」在部分 runtime 上属尽力而为**：见 §5 的真机行为说明。

## 9. 验证

```bash
# 静态门禁与投放（构建期）
node scripts/collect-app.mjs           # 投放 + sha256 + node --check + 静态断言（含 ESM 复核）
node scripts/collect-app.mjs --self-test
# 真机：--inspect（CDP）直接调 RPC
#   POST /api/rpc/oc-harmony-workspace-roots/roots
```

测试用例见 `specs/203-plugin-workspace-picker/test-cases.md`（TC-D1 / TC-D7 / TC-D8 覆盖本插件）。
