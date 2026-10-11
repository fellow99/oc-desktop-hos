# ACL 申请清单（OC Desktop / `rg.fellow99.oc.OCDesktop`）

> **版本**：v1（首版落盘）｜ **日期**：2026-10-11 ｜ **适用工程**：`oc-desktop-hos`
> **用途**：**申请操作手册**。列出本工程必须申请的**受限权限（ACL）**、**开放权限（免 ACL）**、**明确不申请**的项与理由，以及 AGC 提交与上架合规前置。
> **上游基线**：opencode `v2.0.26`；运行期 Electron 37（Node 22.17.0 / Chromium 138 / ABI v138）。
> **证据口径**：✅ **实测** ｜🔶 **沿用**（同型工程或既有调研结论）｜⬜ **待验证**（本工程必须自行确认）｜❌ **不申请**。
> **配套**：能力边界见 `docs/鸿蒙环境能力清单.md`；能力规格见 `specs/`；合规前置的可执行版见 `docs/工程规划-V2.md` §8.5。

## 1. 摘要：要申请什么

| # | 项目 | 类型 | 优先级 | 阻塞谁 | 本工程状态 |
|---|---|---|---|---|---|
| **A1** | `ohos.permission.kernel.ALLOW_WRITABLE_CODE_MEMORY` | ACL（受限） | **最高 · 关键路径** | Electron / V8 的 **JIT**，即**整个应用能否启动** | ⬜ **本包名需新申请**（新包名 = 新 ACL） |
| **B 组** | 6 条开放权限（见 §4） | 免 ACL | 高 | 网络、目录访问、后台声明 | ⬜ 落地方案为「骨架复制后写入 module.json5」（见 §9） |
| ❌ | 其余全部（二进制证书、`ALLOW_EXTERNAL_NATIVE_CODE`、`READ_WRITE_DESKTOP_DIRECTORY`、`*PLUGIN*` 等） | — | — | — | ❌ **不申请**，理由见 §5 |

**一句话**：本项目真正要做的只有 **① 按本包名提交 `kernel.ALLOW_WRITABLE_CODE_MEMORY` 的 ACL 工单**（周期不可控，**Phase 0 即应开工单**），**② 把 6 条开放权限写进模块声明**。其余一律**不申请**。

## 2. 判定规则：什么才算「需要申请」

统一用下面这条规则，**不凭印象申请**：

> **受限开放权限（需 ACL）** ⟺ `provisionEnable == true` **且** `availableLevel ∈ {system_basic, system_core}`。
>
> `provisionEnable == false` 的，无论 level 是什么，都是**开放权限** —— 写进 `requestPermissions` 即可在安装时授予（`user_grant` 的还需运行期弹窗）。**把它们提交 ACL 是浪费配额**。

两个易错点：

1. `availableLevel: normal` 但 `provisionEnable: false` 的权限（如 `ohos.permission.kernel.IGNORE_LIBRARY_VALIDATION`、`kernel.EXEMPT_ANONYMOUS_EXECUTABLE_MEMORY`）**不需要 ACL**，尽管名字带 `kernel.` 前缀。
2. `grantMode: system_grant` **不等于**「不用申请」：受限权限绝大多数也是 `system_grant`（安装即授予，但**前提是 Profile 里有它**）。

> 判定依据（🔶 沿用）：目标 SDK 的权威权限目录 `sdk/default/openharmony/toolchains/lib/PermissionDefinitions.json`（第一手资料，dsh 已核对）。本工程落地前 MUST 用本机 DevEco SDK 的同名文件复核每一项（⬜）。

## 3. 必须申请（受限权限，唯一一项）

| 权限名 | availableLevel | since | 设备类型 | grantMode | 受限 | 用途 |
|---|---|---|---|---|---|---|
| `ohos.permission.kernel.ALLOW_WRITABLE_CODE_MEMORY` | `system_basic` | **14** | 平板 + 2in1 | `system_grant` | ✅ | 允许分配**可写且可执行**的内存 ⇒ 启用 Electron/V8 的 **JIT** |

- **为什么不可缺**：`libelectron.so` 内的 V8 必须为编译产物申请 RWX 页；无该权限时 JIT 不可用 → Electron 引擎无法正常工作（应用级失败，不是「某功能降级」）。**该权限不可删除**。
- **声明落点（必须两处同时有）**：
  1. `web_engine/src/main/module.json5` → `requestPermissions`；
  2. `web_engine/src/main/module.json5` → `definePermissions`（该模块以 `definePermissions` 对外定义能力）。
  另：`electron/src/main/module.json5` 承载本应用的开放权限声明（见 §4）。
- **为什么必须为新包名重申请**：ACL 与 **bundleName + AGC 应用主体**绑定；本工程使用 `rg.fellow99.oc.OCDesktop`（不是 `com.huawei.ohos_electron`，也不是 dsh 的包名），因此 dsh 已获批的同类权限**不能转移**（⬜ 待工单确认口径）。
- **申请填写口径（建议）**：
  - `申请原因`（≤256 字）：本应用为 Electron 桌面应用在鸿蒙 PC 上的移植，运行时引擎（V8）需要在运行期生成机器码，必须申请可写可执行内存权限；不用于热更新，不加载外部不可信代码。
  - `使用场景`：应用启动与日常使用过程中由运行时引擎自行编译脚本；用户不感知该过程。
- **落点复核（⬜）**：`definePermissions` 与 `requestPermissions` 的写法、是否需要同时出现在 HAR 模块与 entry 模块、以及 dev/release Profile 的差异，须在骨架复制完成后按本机 SDK 校验（`docs/工程规划-V2.md` 附录 B 给出的路径）。
- **🔶 沿用事实**：同型工程 dsh 已把该权限同时写进其 `web_engine` 的 `requestPermissions` 与 `definePermissions`，并在真机上正常运行；本工程照此落点，但**申请主体与包名必须换成本工程的**。
- **⬜ 待实测的已知风险**：全新安装时受限权限可能被设备策略拒绝 → 需确认规避手段（dsh 的做法是日常用 `hdc app install -r` 覆盖安装绕过），并记录到 `docs/真机验证记录.md`。

## 4. 开放权限（免 ACL，写进 `requestPermissions` 即安装授予）

| 权限名 | availableLevel | since | grantMode | 用途 | 本工程取舍 |
|---|---|---|---|---|---|
| `ohos.permission.INTERNET` | `normal` | 9 | `system_grant` | 服务端 HTTP、provider 调用 | ✅ 必需 |
| `ohos.permission.GET_NETWORK_INFO` | `normal` | 8 | `system_grant` | 选取局域网 IPv4（loopback 隔离的对策） | ✅ 必需 |
| `ohos.permission.KEEP_BACKGROUND_RUNNING` | `normal` | 8 | `system_grant` | 配合 `module.json5` 的 `backgroundModes: ["taskKeeping"]` | ✅ 声明；但**不承诺保活效果**（见下） |
| `ohos.permission.READ_WRITE_DOCUMENTS_DIRECTORY` | `normal` | 11 | `user_grant` | 文档目录项目根 | ✅ 必需（首次系统弹窗） |
| `ohos.permission.READ_WRITE_DOWNLOAD_DIRECTORY` | `normal` | 11 | `user_grant` | 下载目录项目根 | ✅ 必需（首次系统弹窗） |
| `ohos.permission.FILE_ACCESS_PERSIST` | `normal` | 11 | `system_grant` | 持久授权通道（Picker 路线） | ✅ 声明（路线本身 ⬜ 待验证） |

- `KEEP_BACKGROUND_RUNNING` 的**诚实说明**：2in1 上「最小化」**不构成后台**（`aa dump -a` 仍为 `#FOREGROUND`，`onBackground` 不触发），因此该声明**不产生**「退出后仍常驻」的效果（见 `docs/鸿蒙环境能力清单.md` #13）。声明保留是为了在真正进入后台时的正确性，而**不是**为一个保活承诺。
- `FILE_ACCESS_PERSIST` 的实际行为（`grantMode: system_grant`、since API 11、卸载清空、每次启动须 `activatePermission`）⬜ 本工程复验；对应规格 `specs/011-workspace-auth/`。
- 开放权限的 `provisionEnable` 均为 `false` —— 这就是它们**不属于 ACL** 的判据（提交 ACL 会浪费配额）。

## 5. 明确**不申请**的项与理由

| 项 | 类型 | 不申请的理由 |
|---|---|---|
| **AGC 二进制证书（`certType: 4`）** | 证书（非权限） | 本工程**不随包分发并执行自有 ELF**：服务端跑在 Electron 自带 Node 内，搜索与终端均降级；且二进制证书为受限开放、需企业资质与在线工单，**个人主体不可得**。⇒ 该路线整体不做 |
| `ohos.permission.ALLOW_EXTERNAL_NATIVE_CODE` | ACL（`system_basic` / since 23 / 仅 2in1） | 同上：该权限服务于「加载外部 native 程序 / 二进制」，本工程无此需求（⚠️ 注意：**不存在** `ohos.permission.kernel.ALLOW_EXTERNAL_NATIVE_CODE` 这个名字） |
| `ohos.permission.kernel.LOAD_INDEPENDENT_LIBRARY` | ACL（`system_basic` / since 20） | 同上。⚠️ **例外**：若后续阶段引入**自编译**的 wx/PTY 类原生模块或独立二进制，需回来复评（本工程随包 `.node` 由 Electron 运行时加载，不属此项） |
| `ohos.permission.READ_WRITE_DESKTOP_DIRECTORY` | ACL（`system_basic` / since 11） | **`system_basic` 是当前唯一的上架障碍** ⇒ 不申请、不声明；代价是失去桌面目录直写（`docs/工程规划-V2.md` §8.3） |
| `ohos.permission.ACCESS_USER_FULL_DISK` / `READ_WRITE_USER_FILE` | ACL（`system_basic` / 2in1） | 本工程 v1 只需要「用户显式选定的项目目录 + 文档/下载目录」；不做全盘直写，也不作为上架承诺 |
| `ohos.permission.kernel.SUPPORT_PLUGIN` | ACL | 仅当插件是**鸿蒙插件包**时需要；本工程插件是 **Node 包**（见 `specs/201-plugin-runtime/`） |
| `ohos.permission.INSTALL_PLUGIN_BUNDLE` / `UNINSTALL_PLUGIN_BUNDLE` / `PLUGIN_UPDATE` | ACL | 同上 |
| `ohos.permission.CUSTOM_SANDBOX` | ACL（`system_basic`） | 系统级、仅内部可得且高风险变更；**不得**用它替代进程沙箱（它改的是应用自身沙箱类型） |
| `ohos.permission.RUN_ANY_CODE` | ACL（`system_basic`） | 无正当第三方用途；申请会降低整批可信度 |
| `ohos.permission.SANDBOX_ACCESS_MANAGER` / `..._EXT` | `system_core` | 仅系统应用 |
| `ohos.permission.GET_DEVICE_INDEPENDENT_BINARY_CERT` / `SET_DEVICE_INDEPENDENT_BINARY_CERT_STATUS` | `system_core` / 仅 2in1 | 不可得 |

> **补充说明（易误判）**：`better_sqlite3.node` 放在 HAP 的 `libs/arm64-v8a/` 属于**随包原生库**（同型工程的上架版本即含该文件），与「执行自有 ELF」是两件事，**不需要二进制证书**，也**不需要** `ALLOW_EXTERNAL_NATIVE_CODE`。
> **可选声明（非 ACL）**：`ohos.permission.ALLOW_COREDUMP`（`normal` / `provisionEnable: false` / since 23 / 2in1）如需崩溃转储可声明；本项目默认**不声明**（⬜ 如需诊断再评估）。

## 6. 不存在可申请的权限：执行 `/system/bin/sh`

- SDK 权限目录中**不存在**任何以「执行 shell / 启动进程」为语义的权限；`ohos.permission.EXECUTE_CMD` **不存在**（该名字仅见于第三方移植仓库，❓ 未证实，按不存在处理）。
- 原因：**进程执行不由权限体系管辖**，而由 **SELinux 域 + seccomp** 管辖，并叠加**强制代码签名**门禁。
- 结论：`specs/010-tool-shell/` 的命令执行能力**不依赖任何新权限** —— 它 spawn 的是系统自带的 `/system/bin/sh`（mksh R59）与 `toybox` applet，不经手任何自有 ELF。这也意味着「shell 工具能不能跑」**不能靠申请权限解决**，只能靠真机验证（⬜ P0-1）。
- 同理：`symlink` / `hardlink` / `chmod` 的语义限制**没有对应权限可申请**（按 SELinux 域生效），只能靠实现规避（copy 物化 / 只用 rename / 写入后回读校验）。

## 7. AGC 提交操作手册（步骤 · 配额 · Profile）

### 7.1 步骤

```
① 提交 ACL 批次（本工程只需 1 项：kernel.ALLOW_WRITABLE_CODE_MEMORY）
   AGC → 开发与服务 → 项目 → 应用 → 项目设置 → ACL权限
   → 勾选「我已知晓」→ 勾选目标权限 → 填写「申请原因」（≤256 字）与「使用场景」→ 提交申请

② 等待审核（官方仅说明「各权限的审核时长见受限开放权限列表」，**不承诺统一 SLA** ⬜）

③ 获批后【创建发布 Profile】—— 已获批权限会在创建 Profile 时自动写入
   ⚠️ 若 ACL 在 Profile 创建之后发生变化，**必须重建 Profile**

④ 想在正式 ACL 下来之前先验证可行性：使用【试用调试 Profile】
   （**5 天有效期**、每应用最多 **5 个**）

⑤ 上架必须使用【发布证书 + 发布 Profile】（比对 Profile 的 type）；debug 自签不满足
```

### 7.2 硬约束

| 项 | 约束 |
|---|---|
| 单批上限 | **30 个权限**/次（本工程只用 1 个） |
| 批次节奏 | 审核结果**整批返回**；**上一批未审完不能提交新一批** |
| 获批落点 | 权限在**创建发布 Profile 时写入**（不是在 ACL 页面即时生效） |
| Profile 重建 | ACL 变化后必须重建 Profile |
| 区域 | 海外账号仅支持**亚太与欧洲**；中国大陆账号正常支持 |
| 提交主体 | 必须是该应用的 AGC 项目 / 应用主体（与包名、备案主体三者一致，见 §8 G6） |

### 7.3 责任与时点（⬜ 待确认）

| # | 待确认项 | 影响 |
|---|---|---|
| ⬜-1 | `kernel.ALLOW_WRITABLE_CODE_MEMORY` 在**本包名 / 本主体**下的获批结果（这是全工程**关键路径**） | 决定应用能否启动 |
| ⬜-2 | 全新安装被设备策略拒绝的**规避手段**（覆盖安装？试用调试 Profile？） | 影响首装体验与测试流程 |
| ⬜-3 | 各权限的**实际审核时长**（无 SLA） | 影响排期 |
| ⬜-4 | 「ACL 经本地手段不可用于上架」与「经 AGC 申请的 ACL 可用于上架」的口径张力是否已消解（🔶 同型工程记录为「被禁的是本地改文件那条路，不是 ACL 本身」） | 影响上架路线成立性 |
| ⬜-5 | 是否需要额外声明 `kernel.EXEMPT_ANONYMOUS_EXECUTABLE_MEMORY`（`normal` / `provisionEnable: false`，与匿名可执行内存相关） | 若引擎在部分场景需要匿名可执行内存，缺它可能表现为不稳定（🔶 同型工程未声明亦运行） |

## 8. 上架合规前置（与权限并行的硬性项）

| # | 项 | 判定 / 动作 |
|---|---|---|
| G1 | **渲染必须使用 ArkWeb** | 目标形态 R2（ArkTS `Web` 组件）即为回应此条；若某阶段暂用 R1（Chromium），必须准备复审口径：移除 `entity.system.browsable` + `ohos.want.action.viewData`，外链统一改 ArkWeb |
| G2 | 图标纯色不透明 | 1024×1024、**禁止 Alpha**（构建期守卫） |
| G3 | 首启不得出现「内测 / 测试 / 预览版」字样 | 移除相关引导与徽标 |
| G4 | 隐私合规 | 隐私弹窗链接必须可达，禁止空 URL / `about:blank` |
| G5 | **AI 生成内容标识** | 界面常驻标识（灰字）；可用 `uitest dumpLayout` 断言语义；准备《安全评估报告》/ 算法备案材料 |
| G6 | 主体 / 应用名 / 包名**三一致** | 与 APP 备案一致（改名 = 新建应用 → 重新备案、重新申请 ACL） |
| G7 | `versionCode` 严格递增 | 每次提审递增 |
| G8 | 命名禁用词 | 应用名不出现 `Harmony` / `DeepSeek` 等词；按 opencode 商标要求写明非官方声明（见 `docs/工程规划-V2.md` §1.3） |
| G9 | 测试可用性 | AGC 需提供**可用测试 Key** 与图文指引 |
| G10 | PoC 资产清理 | 上架前移除探针 Ability / 页面 / 调试开关；**关闭 `--inspect`**（运行时默认带该参数，生产构建必须移除）与 `remote-debugging-port` |

## 9. 与本工程代码的差距（待落地声明面）

| 文件 | 需要写入 | 状态 |
|---|---|---|
| `web_engine/src/main/module.json5` → `requestPermissions` | `kernel.ALLOW_WRITABLE_CODE_MEMORY` + `INTERNET` + `GET_NETWORK_INFO` + `READ_WRITE_DOCUMENTS_DIRECTORY` + `READ_WRITE_DOWNLOAD_DIRECTORY` + `FILE_ACCESS_PERSIST` | ⬜ 计划（骨架复制后落地） |
| `web_engine/src/main/module.json5` → `definePermissions` | `kernel.ALLOW_WRITABLE_CODE_MEMORY` | ⬜ 计划 |
| `electron/src/main/module.json5` → `requestPermissions` / `backgroundModes` | `KEEP_BACKGROUND_RUNNING` + `backgroundModes: ["taskKeeping"]` | ⬜ 计划 |
| `AppScope/app.json5` | `bundleName = rg.fellow99.oc.OCDesktop`、`label = OC Desktop`、`versionCode` 递增策略 | ⬜ 计划 |
| 三处 `EntryAbility_label` | `electron/src/main/resources/{base,en_US,zh_CN}/element/string.json` 同步改名 | ⬜ 计划（改名漏一处即出现旧名） |

> 现状说明：本工程骨架尚未复制（`docs/工程规划-V2.md` §3.1 的 Phase 0 P0-4），因此上表全部为**计划**项；**不得**把计划值写成已完成声明。

## 10. 引用

- `docs/工程规划-V2.md` §3.7（命名与签名）、§8（权限与签名全部小节）、§8.5（上架合规前置清单）、§10（P0-5 ACL 工单）、§12（待人工确认事项）。
- `docs/鸿蒙环境能力清单.md` —— 能力侧结论（JIT、ELF、目录权限、shell 无可申请权限）。
- `specs/011-workspace-auth/` —— 目录授权与权限声明面的规格。
- `specs/012-data-dirs-sqlite/` —— 「随包原生库不需要二进制证书」的落点说明。
- `specs/201-plugin-runtime/` —— 「不申请 `*PLUGIN*` 权限」的判定。
- 外部来源（转述，非本工程实测）：`dsh-desktop-hos/docs/ACL申请清单-v2.md`（判定规则、`PermissionDefinitions.json` 取值、AGC 流程与配额）；AGC 证书概述 / ACL 声明 / 受限开放权限清单 / `binary-sign-tool` / `file-persistPermission` 等官方文档（出处见该文件 §11）。
