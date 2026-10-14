# 选择工作区目录插件（203-plugin-workspace-picker）—— 设计与实现方案

> **Module:** 203-plugin-workspace-picker ｜ **Status:** Implementing ｜ **Last Updated:** 2026-10-14 ｜ **上游基线:** opencode v2.0.26（Branch_v2.0.26）
> 对应规格：[spec.md](./spec.md)
> 完整设计来源：[`docs/203-插件-选择工作区目录.md`](../../docs/203-插件-选择工作区目录.md)

## 1. 技术上下文

### 1.1 运行时与构建环境

| 项 | 值 |
|---|---|
| host 侧 | Windows + Node ≥ 22（脚本）+ `bun`（上游构建）+ `pwsh` 7+（构建脚本）+ DevEco Studio（`hvigorw` / `ohpm` / JBR / SDK） |
| 目标设备 | HarmonyOS 2-in-1 PC 模式（真机，本轮序列号 `3QC0226526001227`） |
| 运行时 | Electron 37（`v37.2.3-20260825.1` = Node 22.17.0 / Chromium 138 / ABI v138） |
| 宿主形态 | `OCR_HOST_MODE=inprocess`（默认且真机已验证形态 ⇒ 服务端与 Electron 主进程同进程） |
| 渲染通道 | `OCR_RENDER_MODE=chromium`（默认且真机已验证形态；ArkWeb 为目标形态，不在本模块范围） |
| 上游 | `/d/opencode-workspace/opencode` @ `9b4ec5714d`（tag `v2.0.26`） |
| 部署链 | `collect-runtime` → `build-opencode`（含补丁 ① → bun install → vite build → collect-opencode → smoke） → `collect-app` → `build-debug` → `hdc app install` |

### 1.2 依赖

| 依赖 | 来源 | 用途 |
|---|---|---|
| `context.rpc.register`（`@opencode/plugin`） | 上游 `packages/plugin/src/promise/rpc.ts` | 注册壳侧能力 RPC（**零 codegen**） |
| `POST /api/rpc/:rpcID/:method` | 上游 `packages/protocol/src/groups/rpc.ts` | RPC 传输通道（已存在，不改） |
| `sdk.api.rpc.call` | 上游 `packages/client/src/promise/generated/client.ts` | 渲染层调用入口（已生成，不改） |
| `sdk.api.file.list` → `GET /api/fs/list` | 上游 `packages/core/src/filesystem.ts` | 目录枚举（已存在，不改） |
| `systemPreferences.callArkTSAsyncFunction` | 运行时 `web_engine`（`EtsBridgeAdapter`）/ `libelectron.so` | 主进程 → ArkTS 权限桥与深链 |
| `PermissionManagerAdapter.{CheckPermissions,RequestPermissionCode}` | 本工程 ArkTS，已 JSBind | 目录权限预检与申请 |
| `ElectronApp.OpenApplicationInfoEntry` | 本工程 ArkTS，已 JSBind | 「去系统设置」深链到本应用信息页 |
| `node:fs` / `node:path` / `node:module` | Node 内置 | 沙箱根创建、段名校验、建目录、`createRequire` |
| `scripts/collect-app.mjs` 通配投放 | 本工程 | 插件物化进 resfile（无改动） |
| `src-main/main.js` `materializePlugins()` | 本工程 | resfile → `<userData>/config/opencode/plugin/`（无改动） |

## 2. 关键决策

| # | 决策 | 备选 | 理由 |
|---|---|---|---|
| D1 | **能力用插件（`context.rpc.register`）、UI 用最小上游补丁** | 纯插件 / 纯补丁 | 上游插件无 UI 钩子（`docs/203…` §2 `#13`）；RPC 通道已存在且零 codegen（FR-203-027）。这是「尽量用插件机制，不行再打补丁」的直接落点 |
| D2 | 复用上游 `fs/list` 做目录枚举，**不改协议** | 新增 `fs/mkdir` / 新协议组 | 避免 `protocol/openapi.json` 与生成客户端重生成（codegen 风险）；`fs/list` 已可列举任意绝对路径（`§2 #4`） |
| D3 | 沙箱主目录 = `<userData>/workspace`（与既有工作区根同值） | `<userData>/projects` / `$DSH_HOME` 式独立根 | 不引入第二处真值来源（FR-203-003），且该目录启动时已被创建与 `chdir` |
| D4 | 用户主目录路径在宿主**改写 `HOME` 之前**捕获（`OCR_USER_ROOTS`） | 实现 `ContextPathAdapter.getUser*Dir` + JSBind + overlay 登记 | 后者需改 ArkTS 且必须同步登记 `collect-runtime` 的改写/overlay 规则（`ContextPathAdapter.ets` 不在 overlay 白名单内，会被阶段 2 覆盖）；前者零 ArkTS 改动。⬜ 若真机证明家目录推导有误，再按 D4 备选补齐并登记 |
| D5 | 根围栏在 **UI 层 + 插件层** 各做一次 | 只做 UI / 改造 `fs/list` 收紧根限制 | 本模块不扩大也不收紧既有 API 面；改造 `fs/list` 属独立变更（R6） |
| D6 | 授权事实判据 = **一次全新的列举是否成功** | 依赖 `CheckPermissions` 返回值 | 🔶 沿用同型工程真机结论：check 桥在系统开关已开时仍可能返回 `false`（F8 / FR-203-022） |
| D7 | 新建文件夹走插件 `mkdir` RPC（`node:fs`），名称与根包含性在**服务端**再校验 | 仅 UI 校验 | UI 校验可绕过；安全属性必须在能落盘的一侧成立（FR-203-014/015） |
| D8 | 四主目录模式**自门控**（RPC 不可达即完整回退上游） | 用平台/环境标志硬切换 | 无标志可用（`platform === "web"` 无法区分壳）；自门控天然保证非本壳部署零影响（FR-203-030） |
| D9 | 主目录记忆只记主目录 id（`localStorage`，私有前缀键） | 记完整路径 / 记服务端 | 失效路径容错成本低（FR-203-020）；幂等、无副作用 |
| D10 | 不改 `packages/protocol` / `packages/server` / ArkTS / 权限声明面 | 视需要改 | 约束 1–3；把变更面收敛到「1 插件 + 1 补丁 + 1 处宿主注入」 |

## 3. 数据模型

### 3.1 RPC 契约对象（线格式，JSON）

```
RootInfo   = { id: "sandbox"|"desktop"|"documents"|"download",
               path: string | null,          // 绝对真实路径；不可用为 null
               available: boolean,
               reason?: string }              // 不可用原因（人类可读、不含凭据）
RootSet    = { home: string,                 // 真实家目录（诊断用）
               roots: RootInfo[] }           // 固定顺序：sandbox, desktop, documents, download
MkdirInput = { id: RootId, parent: string,   // parent 必须是绝对路径
               name: string }                // 单个目录段
MkdirOut   = { path: string }                // 创建后的绝对路径
PermInput  = { id: RootId }                  // 仅三个用户主目录；sandbox 免授权
PermCheck  = { granted: boolean, source: "bridge"|"unavailable" }
PermReq    = { code: number, bridgeUnavailable: boolean }   // code 0 = 已授权
AppInfoOut = { ok: boolean }
```

### 3.2 客户端策略（纯函数，`roots.ts`）

| 函数 | 语义 |
|---|---|
| `isWithin(root, path)` | 真实路径包含性判定（先规范化，去尾部分隔符；`root === path` 视为包含）。不解析 symlink（应用域 symlink 不可用）。大小写敏感（`hmdfs` 大小写不敏感但此处不依赖该语义，仅用于围栏） |
| `rootOf(path, roots)` | 返回包含该路径的 `RootInfo`（最长前缀匹配）；无匹配返回 `undefined` |
| `clampToRoot(root, path)` | 把任意路径裁剪到 `root` 内（不在则返回 `root`） |
| `defaultFolderName(existing, base)` | 在 `existing`（同级名称集合）中按 `base`、`base 2`、`base 3`… 选出第一个不冲突的名称 |
| `crumbSegments(root, path)` | 从 `root` 到 `path` 的分段列表（**不含** root 之上的层级） |

### 3.3 持久化

| 键 | 位置 | 值域 | 非法值处理 |
|---|---|---|---|
| `oc-desktop.directoryPicker.root` | 渲染层 `localStorage` | 四个 root id 之一 | 非法 ⇒ 回退 `sandbox`；记忆值本次不可用 ⇒ 回退 `sandbox` 且 UI 明示 |

### 3.4 宿主环境变量

| 变量 | 生产者 | 消费者 | 格式 |
|---|---|---|---|
| `OCR_USER_ROOTS` | `src-main/main.js` `configureEnvironment()` | 插件 `roots()` / `mkdir()` | `JSON.stringify({ desktop, documents, download })`，缺省项为 `null`；解析失败或全部为 `null` 时插件返回 `available: false` + `reason` |
| `OCR_WORKSPACE_DIR`（既有） | 既有逻辑 | `ensureWorkspace()` | 沙箱工作区的可覆盖根（既有；`roots()` 的 `sandbox` 与之同值语义） |

## 4. 接口契约

### 4.1 本模块提供

**A. 插件 RPC（`rpcID = "oc-harmony-workspace-roots"`）**

| 方法 | 输入 | 输出 | 错误 |
|---|---|---|---|
| `roots` | `{}` | `RootSet` | `bridge-unavailable`（沙箱根无法解析） |
| `mkdir` | `MkdirInput` | `MkdirOut` | `invalid-name` / `out-of-root` / `exists` / `create-failed` / `root-unavailable` |
| `permissionCheck` | `PermInput` | `PermCheck` | 不抛错；桥不可用时返回 `{granted:false, source:"unavailable"}` |
| `permissionRequest` | `PermInput` | `PermReq` | 不抛错；桥不可用时返回 `{code:-1, bridgeUnavailable:true}` |
| `openAppInfo` | `{}` | `AppInfoOut` | 桥不可用时 `{ok:false}` |

调用方式（渲染层）：`sdk.api.rpc.call({ rpcID: "oc-harmony-workspace-roots", method: "<method>", input: <input> })`
⇒ `POST /api/rpc/oc-harmony-workspace-roots/<method>`，体 `{ input }`，响应 `{ output }`（`FR-203-027`）。

**B. 对话框行为（补丁后）**

- 新增 props：`roots?: RootInfo[]`（由对话框内部经 RPC 取得，不改变既有 props 语义）。
- 四主目录模式：顶部 `role="tablist"` 的四个 Tab、`data-root-id` 标记、根围栏导航、`新建文件夹` 按钮、隐藏 path 输入与建议浮层。
- 非四主目录模式：与上游**完全一致**（同一渲染分支外的原代码路径，不重排既有节点）。

**C. 宿主注入**

- `process.env.OCR_USER_ROOTS`：三用户主目录绝对路径或 `null`；并在启动 trace 中记录（`FR-203-006`）。

### 4.2 本模块消费

| 消费 | 契约要点 | 是否改动 |
|---|---|---|
| `sdk.api.file.list({ location, path })` | 绝对 `path` 可直接列举；返回条目含名称/类型/hidden 标记 | 不改 |
| `sdk.api.rpc.call(...)` | 见 4.1；未注册时返回错误（用于自门控判定） | 不改 |
| `useDirectoryPicker()` / `DirectoryPickerDialog` props | `{ server, location?, title?, multiple?, onSelect(result) }`；`onSelect(null)` = 取消 | 补丁**只增** `roots` 可选路径 |
| `systemPreferences.callArkTSAsyncFunction(name, returnType, args)` | 回调风格 ArkTS 绑定必须用 async 形式；返回 `{ value }` 信封 | 不改 |
| `collect-app.mjs` 投放契约 | 插件目录必须含 `package.json` 且 `name` 与目录名一致；`index.js` 必须通过 `node --check` 与静态断言 | 不改 |

## 5. 实现策略（含错误处理与降级）

### 5.1 插件（`plugins/oc-plugin-workspace-roots/index.js`）

1. `export default { id: "oc-harmony-workspace-roots", async setup(context) { … } }`；入口先断言 `context.rpc.register` 存在，
   缺失即抛错（fail-visible，与既有插件同口径）。
2. 定义 `Rpc.PortableDefinition`（`{ id, methods, events: {} }`），`input`/`output` 用 JSON Schema 字面量
   （插件是纯 JS，不引入 effect 依赖）。
3. 原生能力桥：`const nodeRequire = createRequire(import.meta.url)`；
   `require('electron').systemPreferences.callArkTSAsyncFunction(name, returnType, args)`。
   `electron` 不可达 / `systemPreferences` 缺失 ⇒ 抛 `bridge-unavailable`（`permission*` 除外：按 4.1 返回结构化降级值）。
4. `roots()`：`sandbox` 用 `app.getPath('userData')` + `workspace`（`mkdirSync(recursive)`）；
   三个用户目录从 `OCR_USER_ROOTS` 读取并逐项 `statSync().isDirectory()` 校验；
   结果落 `console.log("[oc-desktop] …")`（`FR-203-006`）；返回固定顺序。
5. `mkdir()`：段名校验 → 解析 `id` 对应根（根不可用即报错）→ 真实路径包含性校验 → `existsSync` 判重 →
   `mkdirSync(path)`（**非 recursive**，父不存在即失败）→ 返回绝对路径。
6. `permissionCheck/Request/openAppInfo`：`id → permissionType` 映射（`desktop→directory_desktop` 等）；
   `sandbox` 直接返回已授权；桥回调 `0` = 已授权（`number` 返回类型）。
7. `setup` 返回 disposer（登记清理），保持与既有插件一致的资源纪律。

### 5.2 上游补丁（`patches/v2.0.26/0007-workspace-roots-picker.patch`）

1. 新增 `packages/app/src/workspaces/selection/roots.ts`：`RootId` / `RootInfo` / `RootSet` 类型、
   RPC 定义（`rpcID` + 方法名常量）、`rootsRpc(sdk)` 封装、探测函数 `probeRoots(sdk)`（失败返回 `undefined`）、
   §3.2 的纯函数。
2. 新增 `packages/app/src/workspaces/selection/roots.test.ts`：纯函数用例（围栏、根识别、裁剪、默认名去重、面包屑）。
3. 改 `dialog.tsx`：
   - 在既有组件内新增一个 `createResource` 探测四主目录能力（仅当 `policy.action === "directory"` 且非 `multiple` 时探测，避免影响文件选择/多选调用方）；
   - 探测成功 ⇒ 走「四主目录模式」渲染分支：`RootsTabs` + 根围栏的树 + 新建文件夹 + 隐藏 path 输入/建议浮层；
   - 探测失败 ⇒ 原分支（上游代码不变）。
4. 改 `en.ts` / `zh.ts`：新增文案键（`dialog.directory.roots.*` / `dialog.directory.newFolder*` / 不可用与权限提示）。
   其余 locale 用 `Partial<Record<Keys,string>>`，缺失键回退 `en`（无需逐语言补齐）。
5. `build-opencode.mjs` 阶段①按文件名排序应用；补丁先 `--reverse --check` 判已应用 ⇒ 天然幂等（`FR-203-028`）。

### 5.3 宿主注入（`src-main/main.js`）

- 在 `configureEnvironment()` 覆盖 `HOME` **之前**：
  1. `const realHome = process.env.HOME || process.env.USERPROFILE || ""`；
  2. 对 `{ desktop: "Desktop", documents: "Documents", download: "Download" }` 逐个 `path.join(realHome, name)`，
     `existsSync` 且为目录才取值，否则 `null`；
  3. `process.env.OCR_USER_ROOTS = JSON.stringify(...)`；
  4. 失败/全部为 `null` 时落 `trace`（fail-visible，不中止启动）。
- `ensureWorkspace()` 保持既有行为（`FR-203-003` 的同值语义）。
- `build-profile.json5` **不改**（约束 7）。

### 5.4 错误处理与降级矩阵

| 失败点 | 作用面 | 行为 |
|---|---|---|
| `electron` / `systemPreferences` 不可达 | 插件 | `roots`/`mkdir` 正常但 `permission*` 返回结构化降级值；UI 显示「权限不可用」+ 去设置入口（`FR-203-024`） |
| `OCR_USER_ROOTS` 缺失/损坏 | 插件 | 对应主目录 `available:false` + `reason`（`FR-203-005`） |
| 沙箱根创建失败 | 插件 | `roots` 返回 `sandbox` 不可用 + `reason`，不抛错中止 |
| 列举被拒（`EACCES`/`EPERM`） | 应用 | §10 授权流程；失败后「去系统设置」+ 重试 |
| 建目录越界/名称非法/同名 | 插件 | 返回具名错误；UI 留在输入态并提示（`FR-203-014/015/016`） |
| RPC 未注册 / 探测失败 | 应用 | 完整回退上游对话框（`FR-203-030`） |
| 上游工作区创建失败 | 应用 | 走上游既有错误链路（含重试），不改语义 |

## 6. 测试与验证

### 6.1 host 侧

1. `node --check plugins/oc-plugin-workspace-roots/index.js`（`collect-app.mjs` 的同一检查）。
2. `node scripts/collect-app.mjs --check-only`：静态断言（禁 PTY / `spawn` / `.node`）与命名校验。
3. `node scripts/collect-app.mjs --self-test`：反向用例证明断言能失败。
4. 补丁往返：`git -C ../opencode apply --check patches/v2.0.26/0007-*.patch` 与
   `--reverse --check`（应用后）各一次。
5. 纯函数用例：`bun test packages/app/src/workspaces/selection/roots.test.ts`（在上游工作树内，随补丁一起应用）。
6. 既有回归：`node scripts/test-harmony-plugins.mjs`（既有两插件不受影响）。

### 6.2 真机命令

```powershell
# 构建（顺序固定：runtime → opencode（含补丁/UI 重建） → app（插件投放） → HAP）
node scripts\collect-runtime.mjs
node scripts\build-opencode.mjs          # 阶段①幂等打补丁 ①→ bun install → vite build → collect-opencode → smoke
node scripts\collect-app.mjs
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts\build-debug.ps1

# 部署（先卸载清 userData 旧产物与 marker）
& "D:\oh-workspace\DevEco Studio\sdk\default\openharmony\toolchains\hdc.exe" uninstall org.fellow99.oc.OCDesktop
& "…\hdc.exe" app install -r electron\build\default\outputs\default\electron-default-signed.hap
& "…\hdc.exe" shell aa start -a EntryAbility -b org.fellow99.oc.OCDesktop
```

`--inspect` 测试通道（debug 构建）：

```powershell
& "…\hdc.exe" fport tcp:19229 tcp:9229        # 服务端（inprocess）Node inspector
# 经 CDP Runtime.evaluate 调用：
#  1) 读 OCR_USER_ROOTS / 插件加载日志
#  2) 直接 POST /api/rpc/oc-harmony-workspace-roots/roots 并打印返回值
#  3) 对三个用户目录各调一次 permissionCheck / permissionRequest（记录回调码与归类）
```

> `--inspect` 由运行时默认开启，`collect-runtime.mjs` 阶段 6 的改写规则会**在生产包中移除**它
> （`REWRITE_RULES`）。因此本轮验证必须使用**未执行该改写**或显式保留调试开关的 debug 构建；
> 若被移除，则经 `OCR_*` 环境变量或临时关闭该规则重跑，并在日志中如实登记做法。

### 6.3 验收口径

| 验收标准 | 用例 | 判据 |
|---|---|---|
| FR-203-001/002 | TC-D1 / TC-D9 | 四 Tab 可切换且视图重置；默认值符合记忆语义 |
| FR-203-003 | TC-D2 | 删除 `<userData>/workspace` 后能自动重建并列举 |
| FR-203-004/005/006 | TC-D1 / TC-D3 | 四主目录路径正确；不可用主目录有原因；日志有记录 |
| FR-203-007/010/011 | TC-D4 / TC-D6 | 只列目录、hidden 不渲染、截断提示可见 |
| FR-203-008/009 | TC-D5 / TC-D6 | 无法上行；无手动路径输入与建议浮层 |
| FR-203-012–017 | TC-D8 | 新建成功/去重/自动选中；越界与同名被拒 |
| FR-203-018/019 | TC-D9 | 采纳值为绝对路径且工作区创建成功；取消触发 `null` |
| FR-203-020 | TC-D10 | 只记主目录；非法值回退沙箱 |
| FR-203-021–025 | TC-D7 | 授权流程与事实判据；无新增权限声明 |
| FR-203-026–031 | TC-B1/TC-B2 / TC-R1 / TC-R2 | 插件物化与断言；回退行为；品牌化断言全绿 |

## 7. 文件清单

### 7.1 新增

| 路径 | 说明 |
|---|---|
| `oc-desktop-hos/docs/203-插件-选择工作区目录.md` | 设计文档（需求交付物） |
| `oc-desktop-hos/specs/203-plugin-workspace-picker/spec.md` | 规格（需求与验收） |
| `oc-desktop-hos/specs/203-plugin-workspace-picker/plan.md` | 本文件 |
| `oc-desktop-hos/specs/203-plugin-workspace-picker/tasks.md` | 任务清单 |
| `oc-desktop-hos/specs/203-plugin-workspace-picker/test-cases.md` | 测试用例 |
| `oc-desktop-hos/plugins/oc-plugin-workspace-roots/{index.js,package.json,README.md}` | 壳专用能力插件 |
| `oc-desktop-hos/patches/v2.0.26/0007-workspace-roots-picker.patch` | UI 补丁（含新增源码与用例） |
| `oc-desktop-hos/logs/<YYYYMMDD>-<N>/`（DEV_CHECKLIST / REVIEW_REPORT / TEST_CHECKLIST / TEST_REPORT） | 过程与证据 |

### 7.2 修改

| 路径 | 改动 |
|---|---|
| `oc-desktop-hos/src-main/main.js` | `configureEnvironment()` 覆盖 `HOME` 前捕获真实家目录并落 `OCR_USER_ROOTS`；失败落 trace |
| `oc-desktop-hos/specs/README.md` | §1 编号分配表新增 `203` 行 |
| `oc-desktop-hos/README.md` | 目录一览中的补丁区间（`0001–0007`）与插件列表同步（若表述为固定区间） |
| `oc-desktop-hos/patches/v2.0.26/README.md` | 新增 0007 条目说明 |
| `oc-desktop-hos/docs/鸿蒙环境能力清单-v2.0.26.md` / `docs/真机验证记录.md` | 真机结论回写（测试阶段） |
| `../opencode`（**不入库**） | 补丁落地的工作树状态；由流水线幂等应用 |
| `../opencode/packages/app/package.json` 等 | **不改**（无新增依赖；不改上游依赖面） |

### 7.3 明确不改

`packages/protocol`、`packages/server`、`packages/client`（生成物）、`web_engine/**`（ArkTS）、
`runtime-overlays/**`、`scripts/collect-app.mjs`、`scripts/collect-runtime.mjs`、`build-profile.json5`、
`AppScope/app.json5`、权限声明面。

## 8. 与规格的交叉引用

| 规格条目 | 本方案落点 |
|---|---|
| FR-203-001 / 002 | §2 D9、§5.2-3、§3.3 |
| FR-203-003 | §2 D3、§5.1-4 |
| FR-203-004 / 005 / 006 | §2 D4、§3.4、§5.3、§5.1-4 |
| FR-203-007 | §2 D2、§4.2 |
| FR-203-008 / 009 | §2 D5、§3.2、§5.2-3 |
| FR-203-010 / 011 | §5.2-3 |
| FR-203-012–017 | §2 D7、§5.1-5、§5.4 |
| FR-203-018 / 019 | §5.2-3、§5.4 |
| FR-203-020 | §2 D9、§3.3 |
| FR-203-021–025 | §2 D6、§5.1-6、§5.4、§6.2 |
| FR-203-026 / 027 | §2 D1、§4.1-A、§5.1、§5.2 |
| FR-203-028 | §5.2-5、§6.1-4 |
| FR-203-029 | §6.1-1/2/3 |
| FR-203-030 | §2 D8、§5.2-3、§5.4 |
| FR-203-031 | §5.2-4、§6.3 |
