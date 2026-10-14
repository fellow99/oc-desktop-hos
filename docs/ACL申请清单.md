# ACL 申请清单（OC Desktop / `org.fellow99.oc.OCDesktop`）

> **版本**：v3 ｜ **日期**：2026-10-14 ｜ **适用工程**：`oc-desktop-hos`
> **用途**：**申请操作手册**。列出本工程必须申请的**受限权限（ACL）**、**开放权限（免 ACL）**、**明确不申请**的项与理由，以及 AGC 提交与上架合规前置。
> **基准**：本清单的**权限声明面与 `dsh-desktop-hos` 逐项对标**（2026-10-14）——`web_engine/src/main/module.json5` 的 23 项 `requestPermissions` + 2 项 `definePermissions`、`electron/src/main/module.json5` 的 `KEEP_BACKGROUND_RUNNING` + `backgroundModes: ["taskKeeping"]`、以及 8 条 `reason` 文案（三套 locale）。判定口径沿用 dsh 的 `docs/ACL申请清单-v2.md` §2。
> **上游基线**：opencode `v2.0.26`；运行期 Electron 37（Node 22.17.0 / Chromium 138 / ABI v138），外壳 `harmonypc-electron` v37.2.3-20260825.1。
> **数据来源**：本机 DevEco SDK 权威权限目录 `sdk/default/openharmony/toolchains/lib/PermissionDefinitions.json`（**735 条，第一手**）＋ dsh 工程实际声明 ＋ 本工程 `module.json5` 实际声明。
> **证据口径**：✅ **实测/已声明** ｜🔶 **沿用** ｜⬜ **待验证** ｜❌ **不申请**。
> **配套**：能力边界见 `docs/鸿蒙环境能力清单-v2.0.26.md`；能力规格见 `specs/`（本模块为 `specs/006-signing-identity/`）；合规前置见 `docs/工程规划-V2.md` §8.5。

---

## 1. 摘要：要申请什么

| # | 项目 | 类型 | 优先级 | 阻塞谁 | 本工程状态 |
|---|---|---|---|---|---|
| **A0** | `ohos.permission.kernel.ALLOW_WRITABLE_CODE_MEMORY` | ACL（受限） | **最高 · 关键路径** | Electron / V8 的 **JIT**，即**整个应用能否启动** | ✅ 已声明（`requestPermissions` + `definePermissions` 两处）；⬜ **本包名需单独申请**（新包名 = 新 ACL；dsh 记录该项为「已获得」） |
| **A1** | `ohos.permission.READ_PASTEBOARD` | ACL（受限） | 高 | 剪贴板文本/图片粘贴到对话输入框 | ✅ 已声明；⬜ 待随批次提交 |
| **A2** | `ohos.permission.READ_WRITE_DESKTOP_DIRECTORY` | ACL（受限） | 中 | 桌面目录工作区直写 | ✅ 已声明；⬜ 待随批次提交（⚠️ 上架前复核，见 §7.3 ⬜-6） |
| **B** | **21 项开放权限**（见 §4） | 免 ACL | 高 | 网络 / 目录访问 / 打印 / 传感器 / 后台保活 等 | ✅ 已声明（与 dsh 逐项一致） |
| ❌ | 4 项受限或上架障碍 + 10 项外壳默认已剪裁 + 四个 `*PLUGIN*` 等 | — | — | — | ❌ **不申请**，守卫断言其不存在（见 §5） |

**一句话**：本工程要做的是 **① 按本包名提交 3 项 ACL 的工单**（`kernel.ALLOW_WRITABLE_CODE_MEMORY` 是关键路径、周期不可控，应尽早在 AGC 开工单；`READ_PASTEBOARD` / `READ_WRITE_DESKTOP_DIRECTORY` 同批提交），**② 保持声明面与 dsh 一致**（已完成），其余一律**不申请**。

---

## 2. 判定规则：什么才算「需要申请」

> **受限开放权限（需 ACL）** ⟺ `provisionEnable == true` **且** `availableLevel ∈ {system_basic, system_core}`。
>
> `provisionEnable == false` 的，无论 level 是什么，都是**开放权限** —— 写进 `requestPermissions` 即可在安装时授予（`user_grant` 的还需运行期弹窗）。**把它们提交 ACL 是浪费配额**。

两个易错点：

1. `availableLevel: normal` 但 `provisionEnable: false` 的权限（如 `INHERIT_PARENT_PERMISSION`、`kernel.IGNORE_LIBRARY_VALIDATION`、`kernel.EXEMPT_ANONYMOUS_EXECUTABLE_MEMORY`）**不需要 ACL**，尽管名字带 `kernel.` 前缀。
2. `grantMode: system_grant` **不等于**「不用申请」：受限权限绝大多数也是 `system_grant`（安装即授予，但**前提是 Profile 里有它**）。

> 判定依据：本机 SDK 的权威权限目录 `sdk/default/openharmony/toolchains/lib/PermissionDefinitions.json`（第一手）。✅ **2026-10-14 已用本机 SDK 对全部 24 项声明逐条复核**，结论落在 §3（3 项需 ACL）与 §4（21 项开放）。

---

## 3. 必须申请（受限权限，共 3 项）

| # | 权限名 | availableLevel | since | grantMode | provisionEnable | 用途 |
|---|---|---|---|---|---|---|
| 1 | `ohos.permission.kernel.ALLOW_WRITABLE_CODE_MEMORY` | `system_basic` | **14** | `system_grant` | `true` | 分配**可写且可执行**内存 ⇒ 启用 Electron/V8 的 **JIT** |
| 2 | `ohos.permission.READ_PASTEBOARD` | `system_basic` | 11 | `user_grant` | `true` | 用户主动粘贴时读取剪贴板文本 / HTML / 图片 |
| 3 | `ohos.permission.READ_WRITE_DESKTOP_DIRECTORY` | `system_basic` | 11 | `user_grant` | `true` | 工作目录位于桌面时的直写（AI agent 文件工具读写） |

> 三项**一次提交**（单批上限 30 项），审核结果整批返回；上一批未审完不能提交下一批。
>
> **提交口径**：AGC → 开发与服务 → 项目 → 应用 → `项目设置` → `ACL权限` → 勾「我已知晓」→ 勾选目标权限 → 填「申请原因」（≤256 字）与「使用场景」→ 提交。
>
> **`usedScene` 口径**：本工程 8 个带 `reason` 的项统一为 `abilities: ["EntryAbility"]`（entry 模块中真实存在的 Ability）+ `when: "inuse"`，与 dsh 完全一致。⬜ 待真机复验：桌面/文档/下载目录在 `inuse` 下的授予与拒绝行为。
>
> **`reason` 文案口径**：`module.json5` 的 `reason` 是**系统授权弹窗**文案，取自 `$string:access_pasteboard` / `$string:desktop_dir` / …，其值已按 dsh 改写为**真实用例文案**（不再是上游占位串 `... requires user_grant permission`）。这三份 `web_engine/src/main/resources/<locale>/element/string.json` **已加入 `OVERLAY_FILES` 白名单**（否则会被 `collect-runtime` 用上游资源覆盖）。本节 §3.1–§3.3 的「申请原因」是**AGC 表单**文本，与弹窗文案是两件事。

### 3.1 `kernel.ALLOW_WRITABLE_CODE_MEMORY`（关键路径）

- **为什么不可缺**：`libelectron.so` 内的 V8 必须为编译产物申请 RWX 页；无该权限时 JIT 不可用 → Electron 引擎无法正常工作（应用级失败，不是「某功能降级」）。**该权限不可删除**。
- **声明落点（必须两处同时有）**：`web_engine/src/main/module.json5` → `requestPermissions` **与** `definePermissions`（守卫断言各恰好 1 次、合计 2 处）。
- **申请填写口径（建议）**：
  - `申请原因`（≤256 字）：本应用为 Electron 桌面应用在鸿蒙 PC 上的移植，运行时引擎（V8）需要在运行期生成机器码，必须申请可写可执行内存权限；不用于热更新，不加载外部不可信代码。
  - `使用场景`：应用启动与日常使用过程中由运行时引擎自行编译脚本；用户不感知该过程。
- **🔶 沿用事实**：同型工程 dsh 已把该权限同时写进其 `web_engine` 的 `requestPermissions` 与 `definePermissions`，并在真机上正常运行；本工程照此落点，但**申请主体与包名必须换成本工程的**（ACL 与 bundleName + AGC 应用主体绑定，dsh 已获批的同类权限**不能转移**，⬜ 待工单确认口径）。
- **⬜ 待实测的已知风险**：全新安装时受限权限可能被设备策略拒绝 → 需确认规避手段（dsh 的做法是日常用 `hdc app install -r` 覆盖安装），并记录到 `docs/真机验证记录.md`。

### 3.2 `READ_PASTEBOARD`

- **为什么需要**：用户把剪贴板中的文本 / HTML / 图片粘贴到对话输入框时，由 `web_engine/src/main/ets/adapter/PasteBoardApadter.ets` 读取；该权限为 `system_basic` + `user_grant`（**需 ACL**），运行期再由 `PermissionManagerAdapter`（`needPermissions.pasteboard`）弹窗申请。
- **声明落点**：`web_engine/src/main/module.json5` → `requestPermissions`（带 `reason: $string:access_pasteboard` + `usedScene`）。
- **申请填写口径（建议）**：
  - `申请原因`（≤256 字）：因为需要支持用户把剪贴板中的文本、HTML 或图片粘贴到对话输入框（用户主动触发粘贴操作时读取），所以需要 `READ_PASTEBOARD` 权限。仅在用户粘贴时读取剪贴板内容，不在后台读取、不上传剪贴板数据。
  - `使用场景`：用户在应用内输入框主动执行粘贴时读取剪贴板；不执行粘贴则不读取。

### 3.3 `READ_WRITE_DESKTOP_DIRECTORY`

- **为什么需要**：用户在应用内选择的工作目录可能位于桌面，AI agent 的文件工具需要直接读写该目录（`PermissionManagerAdapter` 的 `needPermissions.directory_desktop` 会在运行期申请该权限）。该权限为 `system_basic` + `user_grant`（**需 ACL**）。
- **声明落点**：`web_engine/src/main/module.json5` → `requestPermissions`（带 `reason: $string:desktop_dir` + `usedScene`）。
- **申请填写口径（建议）**：
  - `申请原因`（≤256 字）：因为用户在应用内选择的工作目录可能位于桌面，AI agent 的文件工具（读取/新建/编辑/保存文件）需要直接读写该目录，所以需要 `READ_WRITE_DESKTOP_DIRECTORY` 权限。仅访问用户主动选择或授权的桌面目录，不批量扫描磁盘。
  - `使用场景`：用户把工作目录选在桌面并在其中读写项目文件时。
- **⚠️ 口径变更历史**：v1（2026-10-11）曾以「`system_basic` 是上架障碍」为由**不申请**；v2 起按上游清单改为**声明并申请**，v3 起与 dsh 声明面完全一致。代价是上架前必须复核是否保留（见 §7.3 ⬜-6 与 §11.1 回退口径）。

---

## 4. 开放权限（免 ACL，共 21 项）

> `provisionEnable` 为 `false`，或 `availableLevel: normal` —— 均**不属于 ACL**，写进 `requestPermissions` 即在安装时授予（`user_grant` 的还需运行期弹窗）。**提交 ACL 是浪费配额**。
> 「声明位置」：`web_engine` = `web_engine/src/main/module.json5`（连带 `runtime-overlays/` 回盖源）；`entry` = `electron/src/main/module.json5`。带「（reason）」的表示同时带 `reason` + `usedScene`。

| 权限名 | availableLevel | since | grantMode | 声明位置 | 用途 / 备注 |
|---|---|---|---|---|---|
| `ohos.permission.INTERNET` | `normal` | 9 | `system_grant` | `web_engine` | 服务端 HTTP、provider 调用 |
| `ohos.permission.GET_NETWORK_INFO` | `normal` | 8 | `system_grant` | `web_engine` | 选取局域网 IPv4（loopback 隔离的对策） |
| `ohos.permission.ACCESS_CERT_MANAGER` | `normal` | 9 | `system_grant` | `web_engine` | 证书管理（外壳能力） |
| `ohos.permission.RUNNING_LOCK` | `normal` | 7 | `system_grant` | `web_engine` | 运行锁（阻止休眠） |
| `ohos.permission.PRINT` | `normal` | 10 | `system_grant` | `web_engine` | 打印（外壳打印适配器） |
| `ohos.permission.PREPARE_APP_TERMINATE` | `normal` | 10 | `system_grant` | `web_engine` | 应用退出前准备 |
| `ohos.permission.ACCESS_BIOMETRIC` | `normal` | 6 | `system_grant` | `web_engine` | 生物识别（外壳能力） |
| `ohos.permission.FILE_ACCESS_PERSIST` | `normal` | 11 | `system_grant` | `web_engine` | 文件选择器所选目录的授权持久化 |
| `ohos.permission.PRIVACY_WINDOW` | `normal` | 9 | `system_grant` | `web_engine` | 隐私窗口（防截屏/录屏） |
| `ohos.permission.WINDOW_TOPMOST` | `normal` | 13 | `system_grant` | `web_engine` | 窗口置顶 |
| `ohos.permission.INHERIT_PARENT_PERMISSION` | `normal` | 23 | `system_grant` | `web_engine`（reason） | 随包 Node 运行时继承父进程权限（插件市场安装） |
| `ohos.permission.kernel.IGNORE_LIBRARY_VALIDATION` | `normal` | 20 | `system_grant` | `web_engine`（reason） | 加载随包签名的 Node 运行时动态库 |
| `ohos.permission.kernel.EXEMPT_ANONYMOUS_EXECUTABLE_MEMORY` | `normal` | 23 | `system_grant` | `web_engine`（reason） | 匿名可执行内存（V8 JIT 相关） |
| `ohos.permission.GYROSCOPE` | `normal` | 7 | `system_grant` | `web_engine` | 陀螺仪（外壳能力） |
| `ohos.permission.ACCELEROMETER` | `normal` | 7 | `system_grant` | `web_engine` | 加速度计（外壳能力） |
| `ohos.permission.GET_FILE_ICON` | `normal` | 17 | `system_grant` | `web_engine` | 获取文件图标 |
| `ohos.permission.LOCK_WINDOW_CURSOR` | `normal` | 22 | `system_grant` | `web_engine`（`requestPermissions` **与** `definePermissions`） | 窗口内锁定光标（守卫断言两处） |
| `ohos.permission.READ_WRITE_DOWNLOAD_DIRECTORY` | `normal` | 11 | `user_grant` | `web_engine`（reason） | 下载目录项目根（首次系统弹窗） |
| `ohos.permission.READ_WRITE_DOCUMENTS_DIRECTORY` | `normal` | 11 | `user_grant` | `web_engine`（reason） | 文档目录项目根（首次系统弹窗） |
| `ohos.permission.CUSTOM_SCREEN_CAPTURE` | `normal` | 14 | `user_grant` | `web_engine`（reason） | 应用内截图 |
| `ohos.permission.KEEP_BACKGROUND_RUNNING` | `normal` | 8 | `system_grant` | `entry` | 配合 EntryAbility 的 `backgroundModes: ["taskKeeping"]`（长时任务） |

> **`KEEP_BACKGROUND_RUNNING` 的诚实说明**：2in1 上「最小化」**不构成后台**（`aa dump -a` 仍为 `#FOREGROUND`，`onBackground` 不触发），因此该声明**不产生**「退出后仍常驻」的效果（见 `docs/鸿蒙环境能力清单-v2.0.26.md` #13）。声明保留是为了在真正进入后台时的正确性，而**不是**为一个保活承诺。
> `FILE_ACCESS_PERSIST` 的实际行为（`grantMode: system_grant`、since API 11、卸载清空、每次启动须 `activatePermission`）见 `specs/011-workspace-auth/`。

---

## 5. 明确**不申请**的项与理由

### 5.1 受限 / 上架障碍权限（守卫 `FORBIDDEN_PERMISSIONS` 断言**不存在**）

| 项 | 类型 | 不申请的理由 |
|---|---|---|
| `ohos.permission.CUSTOM_SANDBOX` | ACL（`system_basic`） | 系统级、仅内部可得且高风险变更；**不得**用它替代进程沙箱（它改的是应用自身沙箱类型） |
| `ohos.permission.RUN_ANY_CODE` | ACL（`system_basic`） | 无正当第三方用途；申请会降低整批可信度 |
| `ohos.permission.kernel.LOAD_INDEPENDENT_LIBRARY` | ACL（`system_basic` / since 20） | 服务于「加载二进制证书签名的共享库」；本工程不随包分发并执行自有 ELF（服务端跑在 Electron 自带 Node 内）。⚠️ 若后续引入自编译原生模块需回来复评 |
| `ohos.permission.ALLOW_EXTERNAL_NATIVE_CODE` | ACL（`system_basic` / since 23 / 仅 2in1） | 同上（⚠️ 注意：**不存在** `ohos.permission.kernel.ALLOW_EXTERNAL_NATIVE_CODE` 这个名字） |

### 5.2 上游外壳默认声明、但本工程与 dsh **都剪掉**的 10 项（守卫 `PRUNED_PERMISSIONS` 断言**不存在**）

| 权限名 | 不申请的理由 |
|---|---|
| `ohos.permission.CAMERA` / `ohos.permission.MICROPHONE` | 本工程无拍摄/录音场景；声明即构成隐私面放大 |
| `ohos.permission.LOCATION` / `APPROXIMATELY_LOCATION` / `LOCATION_IN_BACKGROUND` | 无定位场景；后台定位尤其敏感 |
| `ohos.permission.ACCESS_BLUETOOTH` | 蓝牙适配器已不在权限面内（`collect-runtime` 注释记录：适配器仍在编译链中，但**权限已关闭**） |
| `ohos.permission.DISTRIBUTED_DATASYNC` | 无跨设备数据同步场景 |
| `ohos.permission.SYSTEM_FLOAT_WINDOW` | 无系统悬浮窗需求 |
| `ohos.permission.SET_WINDOW_TRANSPARENT` | 无窗口透明需求 |
| `ohos.permission.WEB_NATIVE_MESSAGING` | 不使用 Web 原生消息通道 |

> 这 10 项在上游外壳（`harmonypc-electron` v37.2.3）的默认 `module.json5` 里存在；本工程与 dsh 都从声明面移除。守卫断言其不存在，防止将来重新拷贝外壳时权限面被悄悄放大。

### 5.3 其它不申请项

| 项 | 类型 | 不申请的理由 |
|---|---|---|
| **AGC 二进制证书（`certType: 4`）** | 证书（非权限） | 本工程**不随包分发并执行自有 ELF**：服务端跑在 Electron 自带 Node 内，搜索与终端均降级；且二进制证书为受限开放、需企业资质与在线工单（dsh 记录：个人主体不可得）。⇒ 该路线整体不做 |
| `ohos.permission.ACCESS_USER_FULL_DISK` / `READ_WRITE_USER_FILE` | ACL（`system_basic` / 2in1） | 本工程只需要「用户显式选定的项目目录 + 文档/下载/桌面目录」；不做全盘直写，也不作为上架承诺 |
| `ohos.permission.kernel.SUPPORT_PLUGIN` | ACL | 仅当插件是**鸿蒙插件包**时需要；本工程插件是 **Node 包**（见 `specs/201-plugin-runtime/`） |
| `ohos.permission.INSTALL_PLUGIN_BUNDLE` / `UNINSTALL_PLUGIN_BUNDLE` / `PLUGIN_UPDATE` | ACL | 同上 |
| `ohos.permission.SANDBOX_ACCESS_MANAGER` / `..._EXT` | `system_core` | 仅系统应用 |
| `ohos.permission.GET_DEVICE_INDEPENDENT_BINARY_CERT` / `SET_DEVICE_INDEPENDENT_BINARY_CERT_STATUS` | `system_core` / 仅 2in1 | 不可得 |
| `ohos.permission.ALLOW_COREDUMP` | 开放（`normal` / `provisionEnable: false` / since 23 / 2in1） | 可选声明（非 ACL）；本工程默认**不声明**（⬜ 如需崩溃转储再评估） |

> **补充说明（易误判）**：`better_sqlite3.node` 放在 HAP 的 `libs/arm64-v8a/` 属于**随包原生库**，与「执行自有 ELF」是两件事，**不需要二进制证书**，也**不需要** `ALLOW_EXTERNAL_NATIVE_CODE`。

---

## 6. 不存在可申请的权限：执行 `/system/bin/sh`

- SDK 权限目录中**不存在**任何以「执行 shell / 启动进程」为语义的权限；`ohos.permission.EXECUTE_CMD` **不存在**（该名字仅见于第三方移植仓库，❓ 未证实，按不存在处理）。
- 原因：**进程执行不由权限体系管辖**，而由 **SELinux 域 + seccomp** 管辖，并叠加**强制代码签名**门禁。
- 结论：`specs/010-tool-shell/` 的命令执行能力**不依赖任何新权限** —— 它 spawn 的是系统自带的 `/system/bin/sh`（mksh R59）与 `toybox` applet，不经手任何自有 ELF。这也意味着「shell 工具能不能跑」**不能靠申请权限解决**，只能靠真机验证（⬜ P0-1）。
- 同理：`symlink` / `hardlink` / `chmod` 的语义限制**没有对应权限可申请**（按 SELinux 域生效），只能靠实现规避（copy 物化 / 只用 rename / 写入后回读校验）。

---

## 7. AGC 提交操作手册（步骤 · 配额 · Profile）

### 7.1 步骤

```
① 提交 ACL 批次（本工程本批 3 项：kernel.ALLOW_WRITABLE_CODE_MEMORY、READ_PASTEBOARD、READ_WRITE_DESKTOP_DIRECTORY）
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
| 单批上限 | **30 个权限**/次（本工程本批 3 个） |
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
| ⬜-5 | `kernel.EXEMPT_ANONYMOUS_EXECUTABLE_MEMORY`（`normal` / `provisionEnable: false`）在目标 SDK 上是否真的足以支撑匿名可执行内存场景 | v3 起已随 dsh 声明；若真机出现不稳定，需回到本项复核 |
| ⬜-6 | `READ_WRITE_DESKTOP_DIRECTORY`（`system_basic`）在**上架审核**中是否被判定为障碍（v1 首版据此不申请，v2 起改为声明并申请） | 决定上架时是否回退该声明（回退口径见 §11.1） |
| ⬜-7 | `READ_PASTEBOARD`（`system_basic` / `user_grant`）在本包名下的获批与弹窗行为 | 影响粘贴功能可用性（缺失时表现为无法读取剪贴板） |

---

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

---

## 9. 声明现状（代码事实）

> 判据：`web_engine/src/main/module.json5` / `electron/src/main/module.json5` 与其回盖源 `runtime-overlays/…`（**必须逐字节一致** → md5 守卫见 `scripts/collect-runtime.mjs` 阶段 10.7），权限集断言见阶段 10.6 / 10.6b / 10.6c / 10.6d。
> ✅ **2026-10-14 与 dsh 逐项比对通过**：`requestPermissions` 23 项**名单与顺序完全一致**、`definePermissions` 2 项一致、entry `KEEP_BACKGROUND_RUNNING` + `backgroundModes: ["taskKeeping"]` 一致、8 条 `reason` 项一致。

| 文件 | 声明内容 | 状态 |
|---|---|---|
| `web_engine/src/main/module.json5` → `requestPermissions` | 23 项（`INTERNET`、`GET_NETWORK_INFO`、`ACCESS_CERT_MANAGER`、`RUNNING_LOCK`、`PRINT`、`PREPARE_APP_TERMINATE`、`ACCESS_BIOMETRIC`、`FILE_ACCESS_PERSIST`、`PRIVACY_WINDOW`、`WINDOW_TOPMOST`、`kernel.ALLOW_WRITABLE_CODE_MEMORY`、`INHERIT_PARENT_PERMISSION`、`kernel.IGNORE_LIBRARY_VALIDATION`、`kernel.EXEMPT_ANONYMOUS_EXECUTABLE_MEMORY`、`GYROSCOPE`、`ACCELEROMETER`、`GET_FILE_ICON`、`LOCK_WINDOW_CURSOR`、`READ_PASTEBOARD`、`READ_WRITE_DOWNLOAD_DIRECTORY`、`READ_WRITE_DOCUMENTS_DIRECTORY`、`READ_WRITE_DESKTOP_DIRECTORY`、`CUSTOM_SCREEN_CAPTURE`） | ✅ 已声明，与 dsh 同序；其中 8 项带 `reason` + `usedScene`（`EntryAbility` / `when: inuse`） |
| `web_engine/src/main/module.json5` → `definePermissions` | `LOCK_WINDOW_CURSOR`、`kernel.ALLOW_WRITABLE_CODE_MEMORY` | ✅ 已声明（各与 `requestPermissions` 同名项构成 2 处，守卫断言） |
| `runtime-overlays/web_engine/src/main/module.json5` | 同上的 `requestPermissions` / `definePermissions`（回盖源） | ✅ md5 与目标一致 |
| `web_engine/src/main/resources/<locale>/element/string.json`（base / en_US / zh_CN） | 8 条权限 `reason` 文案（含 `inherit_parent_permission`、`ignore_library_validation`、`exempt_anonymous_executable_memory` 三个新 key） | ✅ 已加入 `OVERLAY_FILES`，内容与 dsh 一致（否则会被 `collect-runtime` 的上游资源覆盖） |
| `electron/src/main/module.json5` → `requestPermissions` / `backgroundModes` | `KEEP_BACKGROUND_RUNNING` + EntryAbility `backgroundModes: ["taskKeeping"]` | ✅ 已声明（守卫阶段 10.6d） |
| `AppScope/app.json5` | `bundleName = org.fellow99.oc.OCDesktop`、`label = OC Desktop`、`versionCode` 递增策略 | ✅ 已落地（见 `specs/006-signing-identity/`） |
| `electron/src/main/resources/<locale>/element/string.json` | 三处 `EntryAbility_label` 同步改名 | ✅ 已落地（改名漏一处即出现旧名） |

> **安装期硬约束（🔶 沿用 dsh，本工程不随包分发 ELF，当前不适用）**：若将来把自有 ELF 写进 `.permission` 节，其声明的权限**不得超过** HAP 已声明的权限，否则安装失败。
>
> ✅ **2026-10-14 构建产物取证**：`electron/build/default/outputs/default/electron-default-signed.hap` 内 `module.json` 的 `requestPermissions` 为 **24 项**，与「dsh `web_engine` 23 项 + dsh entry 1 项」**集合完全一致**（无缺失、无多出）；8 项 `usedScene` 与 `reason`/`reasonId` 均保留；`abilities` 的 `EntryAbility.backgroundModes = ["taskKeeping"]` 在包内。⚠️ 注意：`definePermissions` 是**模块级**（HAR）声明，**不会**出现在 App 级合并后的 `module.json` 里（HAP 内该字段为空属正常，dsh 同理）——其有效性由 `web_engine/src/main/module.json5` 与守卫阶段 10.6c 保证。

---

## 10. 引用

- **基准工程**：`dsh-desktop-hos/web_engine/src/main/module.json5`（23 项声明）、`dsh-desktop-hos/electron/src/main/module.json5`（`KEEP_BACKGROUND_RUNNING` + `backgroundModes`）、`dsh-desktop-hos/scripts/collect-runtime.mjs`（`OVERLAY_FILES`）、`dsh-desktop-hos/docs/ACL申请清单-v1.md` / `-v2.md`（判定规则、AGC 流程与配额）、`dsh-desktop-hos/web_engine/src/main/resources/*/element/string.json`（8 条 `reason` 文案）。
- **第一手 SDK**：`sdk/default/openharmony/toolchains/lib/PermissionDefinitions.json`（本机 DevEco SDK，735 条；本清单全部 level / since / grantMode / provisionEnable 的取值依据）。
- `docs/工程规划-V2.md` §3.7（命名与签名）、§8（权限与签名全部小节）、§8.5（上架合规前置清单）、§10、§12（待人工确认事项）。
- `docs/鸿蒙环境能力清单-v2.0.26.md` —— 能力侧结论（JIT、ELF、目录权限、shell 无可申请权限）。
- `specs/006-signing-identity/` —— 本模块规格（FR-006-010 ~ 013、025、026 为权限声明面与对标要求）。
- `specs/011-workspace-auth/` —— 目录授权与权限声明面的规格；`specs/012-data-dirs-sqlite/` —— 「随包原生库不需要二进制证书」；`specs/201-plugin-runtime/` —— 「不申请 `*PLUGIN*` 权限」。
- 官方文档（转述，非本工程实测）：AGC 证书概述 / ACL 声明 / 受限开放权限清单 / `binary-sign-tool` / `file-persistPermission`（出处见 dsh `ACL申请清单-v2.md` §11）。

---

## 11. 变更记录

| 版本 | 日期 | 变更 |
|---|---|---|
| v3 | 2026-10-14 | **声明面与 `dsh-desktop-hos` 完全对标**：`web_engine` `requestPermissions` 由 8 项补齐为 **23 项**（补 `ACCESS_CERT_MANAGER`、`RUNNING_LOCK`、`PRINT`、`PREPARE_APP_TERMINATE`、`ACCESS_BIOMETRIC`、`PRIVACY_WINDOW`、`WINDOW_TOPMOST`、`INHERIT_PARENT_PERMISSION`、`kernel.IGNORE_LIBRARY_VALIDATION`、`kernel.EXEMPT_ANONYMOUS_EXECUTABLE_MEMORY`、`GYROSCOPE`、`ACCELEROMETER`、`GET_FILE_ICON`、`LOCK_WINDOW_CURSOR`、`CUSTOM_SCREEN_CAPTURE`），`definePermissions` 补 `LOCK_WINDOW_CURSOR`；entry 模块补 `KEEP_BACKGROUND_RUNNING` + `backgroundModes: ["taskKeeping"]`；**新增** `web_engine` 三套 locale `string.json` 到 `OVERLAY_FILES` 并把 8 条 `reason` 文案改写为真实用例文案（与 dsh 一致）；`scripts/collect-runtime.mjs` 权限断言重构为 FORBIDDEN(4) / PRUNED(10) / REQUIRED(23) / REASON_REQUIRED(8) / DUAL_DECLARED(2) 五组；本清单按第一手 SDK 逐条重判（3 项需 ACL / 21 项开放） |
| v2 | 2026-10-14 | 按 `dsh-desktop-hos/docs/ACL申请清单-v1.md` 对齐：`requestPermissions` 补齐 `READ_PASTEBOARD`、`READ_WRITE_DESKTOP_DIRECTORY`；把 `READ_WRITE_DESKTOP_DIRECTORY` 从「明确不申请」移入「必须申请」；4 个 `user_grant`/`reason` 项的 `usedScene` 改为真实存在的 `EntryAbility` / `when: inuse`（原 `FormAbility` 在本工程并不存在） |
| v1 | 2026-10-11 | 首版落盘：判定规则、A1 JIT 受限权限、开放权限清单、明确不申请清单、AGC 提交手册 |

### 11.1 回退口径（若上架受阻）

若 `READ_WRITE_DESKTOP_DIRECTORY` 的 `system_basic` 在上架审核中被判定为障碍，按以下顺序回退（三步，缺一即回到不一致状态）：

1. `web_engine/src/main/module.json5` **与** `runtime-overlays/web_engine/src/main/module.json5` 同时删除该项（两者必须保持同 md5）；
2. `scripts/collect-runtime.mjs`：把 `'ohos.permission.READ_WRITE_DESKTOP_DIRECTORY'` 从 `REQUIRED_PERMISSIONS` 移入 `FORBIDDEN_PERMISSIONS`；
3. 同步本文件 §1/§3.3/§4/§7.2/§9、`specs/006-signing-identity/{spec,plan}.md`、`specs/011-workspace-auth/{spec,plan}.md`、`docs/工程规划-V2.md` §8.1/§8.3、`README.md`，并**重建发布 Profile**（ACL 变化后必须重建）。

回退后重新执行 `node scripts/collect-runtime.mjs --verify-only`（阶段 10.6 应再次断言该权限**不存在**）。

> ⚠️ 同理，若某个开放权限在上架审核中被质疑（如 `PRINT` / `CUSTOM_SCREEN_CAPTURE` / `ACCESS_BIOMETRIC`），须**同时**改三处：两份 `module.json5`、`scripts/collect-runtime.mjs` 的 `REQUIRED_PERMISSIONS`（移入 `PRUNED_PERMISSIONS`）、以及本文件；否则守卫会因「声明面与断言不符」直接失败。
