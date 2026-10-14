# 011-workspace-auth 技术方案（plan）

> 模块：011-workspace-auth ｜ 对应规格：[spec.md](./spec.md) ｜ Last Updated: 2026-10-11
> 上游基线：opencode `v2.0.26`（`Branch_v2.0.26` / `9b4ec5714d`）｜ 证据口径：✅ 实测 ／ 🔶 沿用 ／ ⬜ 待验证

## 1. 技术上下文

| 项 | 值 | 来源 |
|---|---|---|
| 应用沙箱可写根 | `userData` = `/data/storage/el2/base/files`（**hmfs**）；缓存目录 `/data/storage/el2/base/cache` | dsh 真机 ✅（`fstype=hmfs`，本工程 ⬜ 复验） |
| 用户家目录 | `/storage/Users/currentUser`（**hmdfs**；大小写不敏感、无硬链接、`symlink` 应用域不可用） | dsh 真机 ✅（本工程 ⬜ 复验） |
| 用户目录属主/模式 | `Documents` / `Download` / `Desktop` = `mode 2771`、属主 `file_manager`；应用 uid 落 "other" → `R_OK`/`W_OK` `EACCES`、`writeFile`/`mkdir` `EPERM` | dsh 真机 ✅（本工程 ⬜ 复验） |
| 授权生效条件 | 需在「设置 → 应用 → 本应用 → 允许访问」授予，并**重启应用** | dsh 真机 ✅（本工程 ⬜ 复验） |
| 授权持久性 | Picker URI **仅临时授权**；**每次启动须 `activatePermission`**；卸载清空；`FILE_ACCESS_PERSIST` 为 `system_grant` / since API 11 | dsh 已核对官方文档与 SDK ✅（本工程 ⬜ 复验） |
| 权限级别 | `READ_WRITE_DOCUMENTS_DIRECTORY` / `READ_WRITE_DOWNLOAD_DIRECTORY` = `normal` / `user_grant` / since 11；`READ_WRITE_DESKTOP_DIRECTORY` = `system_basic`（上架障碍；2026-10-14 起由 `006-signing-identity` 声明并随 ACL 批次申请，上架前复核） | dsh 已核对 SDK `PermissionDefinitions.json` ✅ |
| ArkTS ↔ Node 桥 | `systemPreferences.callArkTSFunction` / `callArkTSAsyncFunction`：仅 `string`/`number`/`boolean`/`string[]`/`number[]`，**参数 ≤3 个**，两个入口都返回 Promise | dsh 真机 ✅（本工程 ⬜ 复验） |
| 服务端项目语义 | 项目由**目录**决定：`ServerOptions.config.directory`；只读查询 `GET /api/location` / `GET /api/project` | `docs/工程规划-V2.md` §2.1、§5.6 |

**依赖**

| 依赖 | 来源 | 用途 |
|---|---|---|
| `fileShare.activatePermission` / `requestDirectoryPermission` | ArkTS `@kit.CoreFileKit`（⬜ 具体模块名与签名以本机 SDK 为准） | 目录授权与激活 |
| 目录 Picker（`@kit.CoreFileKit` / `picker` 族） | 同上（⬜） | 选择真实路径 |
| `systemPreferences.callArkTSAsyncFunction` | harmonypc-electron 运行时 | 宿主（Node）→ ArkTS 的**单入单出**调用 |
| `packages/server` 的 `ServerOptions.config` / `GET /api/location` | `../opencode` | 项目根生效与交叉校验 |

## 2. 关键决策

| # | 决策 | 备选与理由 | 状态 |
|---|---|---|---|
| D1 | 项目根只接受**真实绝对路径**；Picker URI 仅用于选择动作与授权激活 | 备选「把 URI 当项目根」被否：URI 非持久、且 Node 侧无法直接当作文件系统路径使用 | 已决策 |
| D2 | 每次启动**重放**授权激活；不缓存任何「已授权」布尔值 | 备选「记住已授权」被否：与平台语义冲突（每次启动须重新激活），会造成静默失败 | 已决策 |
| D3 | 交付给服务端之前做**写入探针 + 回读校验** | 备选「直接交给服务端，失败再报错」被否：把平台权限问题的发现时机推到模型工具调用里，诊断成本高 | 已决策 |
| D4 | 未授权时**显式回退**到沙箱默认项目根，并在 UI 明示 | 备选「阻塞启动直到授权」被否：首启体验不可接受（应用本身在沙箱内可完全可用） | 已决策 |
| D5 | ArkTS 侧能力只以**JSON 单入单出**的薄包装暴露给宿主 | 直接调用既有 adapter binding 不可行：通用桥 ≤3 参、仅原始类型（dsh 真机 D.2 第 7/14 条） | 已决策 |
| D6 | 本模块权限面固定为 `Documents` / `Download`（`normal`）+ `FILE_ACCESS_PERSIST`；`Desktop` 不申请、不直写 | `Desktop` 为 `system_basic`，有上架障碍风险（§8.3）；**例外（2026-10-14 口径变更）**：该权限改由 `006-signing-identity` 声明并随 ACL 批次申请，本模块仍不声明、不直写 | 已决策（口径更新） |
| D7 | 目录选择器形态（ArkTS Picker vs 壳层自绘）留待 Phase 1 真机对照（O6） | 两种形态在授权语义上不同（Picker 天然产出可授权路径；自绘浏览器只能遍历应用可见范围） | ⬜ 待定 |

## 3. 数据模型

| 类型 | 字段 | 说明 |
|---|---|---|
| `WorkspaceSelection` | `realPath` / `source` / `uri?` / `selectedAt` | `source ∈ {picker, settings-guide, sandbox-default}`；`uri` 仅在选择时短暂使用 |
| `DirAuthActivation` | `realPath` / `activatedAt` / `result` / `restartRequired` | 每次启动重放一次；`result ∈ {ok, denied, unsupported, error}` |
| `WriteProbe` | `realPath` / `ok` / `probeFile` / `readBackMatches` / `errno?` | 建临时文件 → 回读 → 删除；`readBackMatches === false` 亦视为失败 |
| `ProjectRoot` | `path` / `validatedAt` / `crossCheckedLocation` | `crossCheckedLocation` = `GET /api/location` 观测到的项目根 |
| `WorkspaceState` | `selection` / `activation` / `probe` / `projectRoot` | 进程内单点状态，变化即打日志 |

**状态机**：`未选择 → 已选择（未授权） → 已授权（探针通过） → 已生效（服务端确认）`；任一环节失败落到「显式回退（沙箱默认根）+ 可见提示」，不进入「已生效」。

## 4. 接口契约

### 4.1 ArkTS → 宿主（单入单出 JSON）

```
// 宿主 → ArkTS（Promise；JSON 单入单出，符合通用桥的类型与参数上限）
callArkTSAsyncFunction("OCWorkspace.Select",   '{"purpose":"project-root"}')        -> '{"realPath":"...","uri":"...","result":"ok"}'
callArkTSAsyncFunction("OCWorkspace.Activate", '{"realPath":"/..."}')               -> '{"result":"ok|denied|unsupported","restartRequired":false}'
callArkTSAsyncFunction("OCWorkspace.Pick",     '{}')                                -> '{"realPath":"...","result":"ok|cancelled"}'
```

- 绑定名与方向 ⬜ **待验证**（须与 harmonypc-electron 的 `JsBindingUtils` / `systemPreferences` 现状核对；若方向相反，则由 ArkTS 侧主动调用宿主的注册函数）。
- 返回体 MUST 为**单个 JSON 字符串**；不得依赖多参数调用。

### 4.2 宿主内部契约

```
resolveWorkspace(env)            -> { realPath, source }
activateWorkspace(realPath)      -> { result, restartRequired }
probeWritable(realPath)          -> { ok, errno?, readBackMatches }
applyProjectRoot(host, realPath) -> { applied, crossCheckedLocation }
```

- `env` 的默认项目根 = `<userData>/projects/default`（首次启动创建，`mkdir -p` 语义）。
- `applyProjectRoot` 在服务端就绪**之前**注入 `config.directory`，就绪**之后**用 `GET /api/location` 交叉校验。

### 4.3 权限声明面（`web_engine` / `electron` 模块）

| 权限 | 级别 | 声明位置 | 用途 |
|---|---|---|---|
| `READ_WRITE_DOCUMENTS_DIRECTORY` | `normal` / `user_grant` | `requestPermissions` | 文档目录（首次系统弹窗） |
| `READ_WRITE_DOWNLOAD_DIRECTORY` | `normal` / `user_grant` | `requestPermissions` | 下载目录（首次系统弹窗） |
| `FILE_ACCESS_PERSIST` | `system_grant` / since 11 | `requestPermissions` | 持久授权通道（Picker 路线） |
| `READ_WRITE_DESKTOP_DIRECTORY` | `system_basic` | 由 `006-signing-identity` 声明（2026-10-14 起，随 ACL 批次申请） | 本模块不直接声明；上架障碍风险须在上架前复核（`docs/ACL申请清单.md` §7.3 ⬜-6） |

## 5. 实现策略

1. **宿主侧装配（`src-main/workspace.js`）**：启动早期解析默认根 → 读取上次选择（仅存**路径字符串**，不存授权状态）→ 重放授权 → 探针 → 写日志 → 交给服务端启动流程。
2. **ArkTS 薄包装（`web_engine/src/main/ets/adapter/WorkspaceAdapter.ets`）**：只做三件事（选择 / 激活 / 权限查询），JSON 单入单出；平台异常一律转成 `{"result":"error","code":...}`，不得抛到桥外。
3. **服务端接线**：把项目根作为 `ServerOptions.config.directory`（或等价配置）注入；启动后 `GET /api/location` 校验并记录差异（差异即视为阶段失败，进入 fail-visible 分支）。
4. **UI 通道**：切换项目复用同一 `OCWorkspace.Select` + `Activate` 组合；未授权时给出「去设置授权 → 重启应用」的两步指引。
5. **默认根兜底**：`<userData>/projects/default` 在宿主启动时确保存在，使应用在完全没有用户目录授权时仍可用。
6. **与围栏同源**：项目根字符串**单点注入**到 shell 工具的允许根集合（`specs/010-tool-shell/`），禁止两处各自解析。

## 6. 测试与验证

| 层 | 手段 | 覆盖 |
|---|---|---|
| 单元（裸 Node / host 侧） | `node:test` | 默认根生成、选择记录读写（仅路径）、探针封装（对沙箱目录应为 `ok`）、`applyProjectRoot` 的差异判定、失败分支（`denied` / `unsupported` / 探针 `EACCES`） |
| 静态断言 | `grep` 守卫 | 代码中不出现把 URI 当项目根的分支；不出现 `symlink` / `hardlink` 依赖。权限声明面的**存在性**断言由 `006-signing-identity` 的 `scripts/collect-runtime.mjs` 阶段 10.6 承担（本模块**不再**断言 `READ_WRITE_DESKTOP_DIRECTORY` 不存在，见 FR-011-011 例外） |
| host 侧门禁 | `scripts/smoke-node22.mjs` | 宿主启动时项目根注入不破坏服务端启动；`GET /api/location` 可达 |
| 真机（Phase 1） | 应用域取证（`--inspect` / 日志 / UI） | ① 沙箱默认根探针通过 ② 未授权用户目录 → `EACCES`/`EPERM` + 指引可见 ③ 授权 + 重启后探针通过 ④ 第二次启动重放激活成功 ⑤ UI 内切换项目后 `GET /api/location` 一致 |
| 先决探针 | Phase 0 **P0-1**（宿主形态） | 决定「项目根变化是否需要重建宿主」；若宿主不可重建，则切换项目限定为「服务端仍在同一项目根、仅会话根变化」⬜ |

**纪律**：所有设备条目在未执行时保持 ⬜；真机结论与原始证据写入 `docs/真机验证记录.md`。

## 7. 文件清单

| 路径 | 角色 | 状态 |
|---|---|---|
| `src-main/workspace.js` | 工作区解析 / 授权重放 / 探针 / 项目根注入 | 计划（Phase 1） |
| `src-main/main.js` | 启动时序中的调用点（在启动服务端之前） | 计划 |
| `web_engine/src/main/ets/adapter/WorkspaceAdapter.ets` | ArkTS 薄包装（Select / Activate / Pick） | 计划（Phase 1） |
| `web_engine/src/main/ets/.../WorkspaceAdapterBind.ets` | `JsBindingUtils.bindFunction` 注册 | 计划（Phase 1） |
| `web_engine/src/main/module.json5` | 三条权限声明（Documents / Download / FILE_ACCESS_PERSIST） | 计划 |
| `specs/011-workspace-auth/{spec.md,plan.md}` | 本模块规格与方案 | 本次创建 |
| `docs/真机验证记录.md` | 真机结论落点 | 本次创建 |

## 8. 与规格的交叉引用

| 规格条目 | 本方案落点 |
|---|---|
| FR-011-001 ~ FR-011-005 | §4.2 宿主内部契约、§5.1/5.3/5.4、D1 |
| FR-011-006 ~ FR-011-013 | §4.1/4.2、§5.2、D2/D3/D4、§6 真机用例 |
| FR-011-014 ~ FR-011-017 | §5.6 与围栏同源、D1、§2 约束（symlink/hardlink） |
| 假设 1~8（⬜） | §1 技术上下文、§4.1 绑定名、§2 D7、§6 先决探针 |
| 约束 1~4 | §4.3 权限面（D6）、§5.5 默认根兜底、§6 应用域取证 |
