# 签名与应用身份（006-signing-identity）—— 规格

> **Module:** 006-signing-identity ｜ **Status:** Proposed ｜ **Last Updated:** 2026-10-11 ｜ **上游基线:** opencode v2.0.26（Branch_v2.0.26）

## 1. 模块概述

### 1.1 目的（Why this module exists）

定义并守护本应用的**身份**与**可分发资格**：

- 应用显示名 **OC Desktop**、bundleName **`org.fellow99.oc.OCDesktop`**，并保证改名时「三处同步」不漏；
- 签名材料（`signing.debug.local.json` / `signing.release.local.json`）由 `hvigorfile.ts` 在 `afterNodeEvaluate` **仅内存注入**，不入库、不写回；
- ACL 归属：本包名需单独申请 3 项受限权限（`kernel.ALLOW_WRITABLE_CODE_MEMORY` / `READ_PASTEBOARD` / `READ_WRITE_DESKTOP_DIRECTORY`，清单对齐 `dsh-desktop-hos/docs/ACL申请清单-v1.md`），其中 `ohos.permission.kernel.ALLOW_WRITABLE_CODE_MEMORY` 是 Electron/V8 启用 JIT 的前提（决定 `007-runtime-host` 三候选的可行性边界）；
- `versionCode` 规则与上架身份类合规项（图标、禁用词、调试开关）的构建期守卫。

### 1.2 解决的问题（What pain points it addresses）

- **改名不同步**：🔶 同型工程踩坑——只改 `AppScope/app.json5` 时任务视图/系统界面仍显示旧名，必须同时改 `electron/src/main/resources/{base,en_US,zh_CN}/element/string.json` 的 `EntryAbility_label`（三套都要），以及 `web_engine` 内硬编码旧 bundle 的适配点。
- **共享签名不可用**：不能用 `ohos_electron` 的共享签名（bundleName 不同），必须为本包名重新生成证书；🔶 如果沿用旧包名，还要面对别人签名体系下的 ACL 归属问题。
- **ACL 归属随包名走**：自定义包名意味着受限权限需**按新包名重新申请**（尤其 JIT 权限），否则应用起不来或 JIT 被拒（工程规划 §3.7、§8.1）。
- **versionCode 规则**：上架要求严格递增，且改名等价于新建应用、需重新备案（🔶 上架整改口径）。
- **材料泄漏风险**：签名私钥若入库或写回文件，等于把分发能力交给仓库。
- **合规硬项**：图标纯色不透明（禁 Alpha）、首启无「内测/测试/预览版」、生产包移除调试开关——都需要守卫而不是靠人记。

### 1.3 范围（Scope）

**包含**：

- 应用身份：bundleName 单一来源、显示名三处同步、命名禁用词与商标声明；
- 版本：`versionCode` 规则、`versionName` 与上游基线的关联、release 档守卫；
- 签名：材料文件约定、`hvigorfile.ts` 注入点、仅内存注入纪律、发布/调试证书与 Profile 的差别；
- ACL 归属：受限权限判定规则、JIT 权限的申请与声明落点、明确「不申请」清单与提交纪律；
- 身份类上架合规守卫（图标、首启文案、调试开关）。

**不包含**：

- 构建流水线的阶段组织与门禁（见 `005-build-pipeline`；本模块提供注入点与守卫入口）；
- JIT 权限在设备上的实际授予行为（由 `007-runtime-host` 的 P0-1 探针验证）；
- 权限在运行时的使用方式（`INTERNET` 等由各模块消费）；
- 官网、更新策略、备案材料准备（Phase 3）。

## 2. 用户故事

- 作为用户，我希望应用在系统里叫「OC Desktop」，任务视图、桌面图标与应用内名称一致。
- 作为研发，我希望改名时不会漏掉某一份 `string.json`，改动由检查而不是记忆保证。
- 作为安全负责人，我希望签名私钥永不入库、永不写回工作区。
- 作为上架负责人，我希望 `versionCode` 递增与图标合规在构建期就被拦住，而不是提审被拒后返工。
- 作为研发，我希望知道「JIT 权限没批」会产生什么后果（哪些宿主形态直接不可用）。

## 3. 功能需求

### 3.1 身份与命名

- FR-006-001 bundleName 的**唯一来源** MUST 为 `AppScope/app.json5`；本工程其它位置（ArkTS、脚本、文档中的可执行命令）MUST NOT 硬编码与之一致的第二份真值来源（需要出现处一律引用同一常量或由脚本替换/校验）。
- FR-006-002 应用显示名 `OC Desktop` MUST 同步三处：① `AppScope/app.json5` 的 `label`；② `electron/src/main/resources/base/element/string.json` 的 `EntryAbility_label`；③ `electron/src/main/resources/{en_US,zh_CN}/element/string.json` 的同名键；并对 `web_engine` 内任何硬编码旧 bundle 的适配点做同步校验。
- FR-006-003 命名 MUST NOT 包含禁用词（如 `Harmony`、`DeepSeek`），且 README 与应用内「关于」MUST 给出 opencode 商标与非隶属声明。
- FR-006-004 应用主体 / 应用名 / 包名 MUST 三一致（与 APP 备案一致）；改名等价于新建应用，MUST 触发备案、ACL 与 Profile 的复核。

### 3.2 签名与 Profile

- FR-006-005 系统 MUST NOT 使用 `ohos_electron` 的共享签名；必须为本 bundleName 生成自有证书。
- FR-006-006 签名材料 MUST 从 `signing.debug.local.json` / `signing.release.local.json` 读取，由 `hvigorfile.ts` 在 `afterNodeEvaluate` 注入，且**仅内存注入**：MUST NOT 写回任何文件；仓库 MUST 只保留 `.sample` 模板。
- FR-006-007 上架构建 MUST 使用**发布证书 + 发布 Profile**（比对 Profile 的 `type`）；debug 自签不满足上架要求。
- FR-006-008 签名材料缺失或字段不合法时构建 MUST fail-visible 中止，MUST NOT 产出未签名或错签产物。
- FR-006-009 签名材料与私钥内容 MUST NOT 出现在构建日志或诊断输出中（脱敏）。

### 3.3 ACL 归属

- FR-006-010 受限权限判定 MUST 使用权威规则「`provisionEnable == true` 且 `availableLevel ∈ {system_basic, system_core}`」；MUST NOT 仅凭名称含 `kernel.` 就主张申请。
- FR-006-011 **需 ACL 的受限权限恰为 3 项**（依第一手 SDK `PermissionDefinitions.json` 的判定规则，FR-006-010）：`ohos.permission.kernel.ALLOW_WRITABLE_CODE_MEMORY`（system_basic / since 14）、`ohos.permission.READ_PASTEBOARD`（system_basic / since 11）、`ohos.permission.READ_WRITE_DESKTOP_DIRECTORY`（system_basic / since 11）；本包名 MUST 将三项提交 AGC 的同一批次，三项 MUST 在 `web_engine/src/main/module.json5` 的 `requestPermissions` 中声明，其中 `kernel.ALLOW_WRITABLE_CODE_MEMORY` MUST **同时**出现在 `definePermissions`（Electron/V8 启用 JIT 的前提，MUST NOT 删除）。
- FR-006-012 **权限声明面 MUST 与 `dsh-desktop-hos` 完全对标**（`web_engine` 23 项 `requestPermissions` + 2 项 `definePermissions`；entry 模块 `KEEP_BACKGROUND_RUNNING` + EntryAbility `backgroundModes: ["taskKeeping"]`），MUST NOT 声明 `FORBIDDEN_PERMISSIONS`（13 项：受限 / 上架障碍 / 无正当用途）与 `PRUNED_PERMISSIONS`（外壳默认但已剪掉的 10 项）；带 `reason` 的 8 项 MUST 同时带 `usedScene`（`EntryAbility` / `when: inuse`），其 `reason` 文案 MUST 落在列入 `OVERLAY_FILES` 的 `web_engine/src/main/resources/<locale>/element/string.json`。
- FR-006-013 系统 MUST NOT 申请：AGC 二进制证书（`certType: 4`，**非权限**）、`ALLOW_EXTERNAL_NATIVE_CODE`、`kernel.LOAD_INDEPENDENT_LIBRARY`、`ACCESS_USER_FULL_DISK` / `READ_WRITE_USER_FILE`、四个 `*PLUGIN*` 权限，以及 `CUSTOM_SANDBOX` / `RUN_ANY_CODE` / `SANDBOX_ACCESS_MANAGER` / `GET_DEVICE_INDEPENDENT_BINARY_CERT` / `SET_DEVICE_INDEPENDENT_BINARY_CERT_STATUS`。其中 **13 个权限名** MUST 由守卫 `FORBIDDEN_PERMISSIONS` 对 `web_engine` 与 `electron` **两份清单**断言不存在（阶段 10.6 / 10.6d）。（注：`READ_WRITE_DESKTOP_DIRECTORY` 自 2026-10-14 起与 dsh 对标改为**声明并申请**，不再属本禁止清单；上架前复核见 `docs/ACL申请清单.md` §7.3 ⬜-6 与 §11.1。）
- FR-006-014 ACL 提交纪律 MUST 被记录并遵守：单次最多 30 个权限、上一批未审完不得提交新批、ACL 变化后必须重建 Profile、试用调试 Profile 5 天有效期且每应用最多 5 个。
- FR-006-015 ⬜ 待验证：全新安装时 JIT 受限权限可能被设备策略拒绝 → 规避手段（日常使用 `hdc app install -r` 覆盖安装）MUST 经真机验证并记录到 `docs/ACL申请清单.md`。
- FR-006-016 权限申请材料（申请原因 ≤ 256 字、使用场景）MUST 在 `docs/ACL申请清单.md` 中维护为可提交文本。

- FR-006-025 本工程的权限声明面 MUST 与 `dsh-desktop-hos` 的**实际声明**逐项一致（`web_engine/src/main/module.json5` 的 23 项 `requestPermissions` **含顺序** + 2 项 `definePermissions`；`electron/src/main/module.json5` 的 `KEEP_BACKGROUND_RUNNING` + `backgroundModes: ["taskKeeping"]`；8 条 `reason` 项），差异 MUST 以「补齐本工程声明」的方式消除，并同步：① `docs/ACL申请清单.md`（申请口径 + 声明现状 + 变更记录）；② `scripts/collect-runtime.mjs` 阶段 10.6 / 10.6b / 10.6c / 10.6d / 10.6e 的权限断言（`FORBIDDEN_PERMISSIONS` / `PRUNED_PERMISSIONS` / `REQUIRED_PERMISSIONS` / `REASON_REQUIRED_PERMISSIONS` / `DUAL_DECLARED_PERMISSIONS`，其中 **10.6e 断言声明顺序**、**10.6c 分段断言「两处各 1 次」**）；③ `runtime-overlays/` 回盖源（`web_engine` 与 `electron` 的 `module.json5` + 三套 locale `string.json`，与目标同 md5，阶段 10.7 守卫）。
- FR-006-026 带 `reason` 的权限的 `usedScene.abilities` MUST 指向本工程真实存在的 Ability（当前为 `EntryAbility`），MUST NOT 引用不存在的 Ability 名；`when` MUST 为 `inuse`。**四项 MUST 由守卫逐条断言**（阶段 10.6b：条目内必须同时含 `"reason"` / `usedScene` / `"EntryAbility"` / `"inuse"`）。

### 3.4 versionCode 与版本纪律

- FR-006-017 `versionCode` MUST 严格递增，且每次提审递增；其**单一来源**为 `AppScope/app.json5`。
- FR-006-018 release 档构建 MUST 有守卫：校验 `AppScope/app.json5` 的 `versionCode` 大于「上一发布基线」，否则中止；基线 MUST 记录在 `docs/上架合规清单.md`，守卫入口为 `hvigorfile.ts` 与 `scripts/build-release.ps1`。
- FR-006-019 `versionName` SHOULD 表达上游基线（与 opencode `v2.0.26` 的关联可读），并与 `versionCode` 职责分离；⬜ 待验证：与产品/上架信息一致的最终命名口径。
- FR-006-020 包名或应用名变更 MUST 同步更新 README、应用内「关于」与 `docs/` 相关清单，并触发 ACL / Profile / 备案复核记录。

### 3.5 身份类上架合规守卫

- FR-006-021 应用图标 MUST 为纯色不透明（1024×1024，禁止 Alpha 通道），且构建期 MUST 有守卫（PNG 颜色类型检测即可判定是否携带 Alpha）。
- FR-006-022 首启路径 MUST NOT 出现「内测 / 测试 / 预览版」字样，构建期 SHOULD 有字符串扫描守卫。
- FR-006-023 生产构建 MUST 移除调试开关（运行时默认的 `--inspect`、remote-debugging 端口），并 MUST 由 release 档设置与守卫共同保证。
- FR-006-024 上架前置清单（图标纯色、首启文案、隐私链接可达、AI 生成内容标识、测试 Key 等）MUST 落地为可执行检查项并记录在 `docs/上架合规清单.md`。

## 4. 关键实体

| 实体 | 说明 | 关键属性 |
|------|------|----------|
| 应用身份（AppIdentity） | 包名与显示名 | `bundleName`、`label`、`labelSources[]`（三处路径）、`synced`（是否全部一致） |
| 版本（AppVersion） | 版本号 | `versionCode`、`versionName`、`publishedBaseline` |
| 签名材料（SigningMaterial） | 本地不入库的证书材料 | `debugFile`、`releaseFile`、`alias`、`injectedAt`、`writeBack`（恒为 `false`） |
| ACL 条目（AclEntry） | 受限权限申请项 | `name`、`availableLevel`、`provisionEnable`、`since`、`reason`、`basis`（判定依据） |
| Profile（SigningProfile） | 签名 Profile | `type`(`debug`/`release`)、`bundleName`、`generatedAt`、`rebuiltAfterAcl` |

## 5. 验收场景

### 场景 1：改名三处同步

- Given 将显示名改为 `OC Desktop` 并只改了一处
- When 执行身份检查
- Then 报告不一致的三处路径与当前值；修正后检查通过；真机桌面/任务视图与应用内名称一致

### 场景 2：签名注入不落盘

- Given `signing.debug.local.json` 存在且合法
- When 执行 debug 构建
- Then 构建成功；`git status --porcelain` 在签名材料与工程文件上无新增改动（零写回）

### 场景 3：材料缺失 fail-visible

- Given `signing.release.local.json` 不存在
- When 执行 release 构建
- Then 构建中止并指出缺失文件与必需字段；MUST NOT 产出未签名产物

### 场景 4：versionCode 守卫

- Given `docs/上架合规清单.md` 记录上一发布 `versionCode = N`，而 `AppScope/app.json5` 仍为 `N`
- When 执行 release 构建
- Then 守卫中止构建并提示必须递增

### 场景 5：图标 Alpha 守卫

- Given 图标 PNG 颜色类型为 6（带 Alpha）
- When 执行构建守卫
- Then 中止并提示「图标必须纯色不透明」

### 场景 6：ACL 与 JIT

- Given 本包名已获得 `ALLOW_WRITABLE_CODE_MEMORY` 的 ACL 授权并重建了 Profile
- When 真机安装并启动应用
- Then 应用可启动；由 `007-runtime-host` 的 JIT 示性探针确认 JIT 可用（结论写 `docs/真机验证记录.md`）
- 反例：权限未获批时，JIT 示性探针失败（现象与结论必须登记，不得静默）

### 场景 7：debug 自签不可上架

- Given 使用 debug 自签 Profile 构建的 HAP
- When 执行上架前检查
- Then 被标记为非上架产物（Profile `type` 非 release），MUST NOT 进入上架流程

## 6. 非功能需求

- **可维护性**：身份与版本为单一来源（`AppScope/app.json5`），其它位置由检查/同步脚本保证一致；ACL 与合规文本集中在 `docs/` 两份清单。
- **安全性**：签名材料不入库、不写回、不出现在日志；`.sample` 中 MUST NOT 含真实私钥或密码。
- **可靠性**：签名材料缺失、版本未递增、图标不合规、生产包带调试开关——四类问题一律 fail-visible。
- **合规性**：上架身份类要求（命名禁用词、图标、首启文案、三一致、Profile 类型）可被检查项覆盖。
- **幂等性**：身份检查与合规守卫可重复执行，结果稳定、无副作用。

## 7. 假设与约束

- 假设 🔶：改名必须同步三处（`AppScope/app.json5` + 三套 `string.json` + `web_engine` 内适配点），否则系统界面显示旧名。
- 假设 🔶：受限权限判定规则为「`provisionEnable == true` 且 `availableLevel ∈ {system_basic, system_core}`」。
- 假设 🔶：应用市场审核对渲染组件（ArkWeb）、图标纯色、首启文案、AI 标识、命名禁用词有硬性要求（工程规划 §8.5 G1–G10）。
- 约束：MUST NOT 使用共享签名；MUST NOT 以 `CUSTOM_SANDBOX` 替代进程沙箱；本批次 ACL 只申请 `kernel.ALLOW_WRITABLE_CODE_MEMORY` / `READ_PASTEBOARD` / `READ_WRITE_DESKTOP_DIRECTORY` 三项（其余受限项一律不申请，见 FR-006-013）；`READ_WRITE_DESKTOP_DIRECTORY` 的上架风险 MUST 在上架前复核（`docs/ACL申请清单.md` §7.3 ⬜-6）。
- 约束：`better_sqlite3.node` 属**随包原生库**（放在 `libs/arm64-v8a/`），与「执行自有 ELF」不同，MUST NOT 因此申请二进制证书。
- ⬜ 待验证：`org.fellow99.oc.OCDesktop` 是否与已注册的应用主体一致（影响签名、ACL 归属与备案三一致；工程规划 §12.1）。
- ⬜ 待验证：ACL 审批的前置条件与节奏（是否要求应用已创建/已提交，试用调试 Profile 的实际可用性）。
- ⬜ 待验证：JIT 受限权限在目标 API 版本上的实际授予与拒绝行为（由 007 探针实测）。
- ⬜ 待验证：release Profile 的 `type` 字段判定方式与重建时机。

## 8. 依赖

**上游 / 外部（被本模块消费）**：

- AGC（ACL 权限提交、发布 Profile、备案信息）；
- DevEco Studio（证书与 Profile 生成、`signing.*.local.json` 的本机构造）；
- `../harmonypc-electron/ohos_hap/runtime-manifest.json` 的 `bundleNameRewrite.adapters`（作为「同名机制」的参考实现，🔶 文档核实）。

**本工程（被本模块消费）**：

- `005-build-pipeline`：阶段④调用 `hvigorfile.ts` 注入点与 release 守卫入口；
- `002-lifecycle`：`KEEP_BACKGROUND_RUNNING` / `backgroundModes` 声明必须与权限声明一致；
- `007-runtime-host`：JIT 权限可用性直接决定宿主候选的可行性（若 JIT 不可用，进程内/worker/utility 三者的可行性都要重评）。

**下游（消费本模块）**：

- `005-build-pipeline`（签名材料注入与守卫）、`002-lifecycle`（权限声明一致性）、`docs/ACL申请清单.md` 与 `docs/上架合规清单.md`（申请与合规执行）。
