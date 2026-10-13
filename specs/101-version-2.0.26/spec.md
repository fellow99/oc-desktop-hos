# 101 — 版本更新：2.0.26 功能规格

> **Module:** release ｜ **Status:** Implementing ｜ **Last Updated:** 2026-10-13
> **需求编号:** 101-version-2.0.26 ｜ **需求名称:** 版本更新：2.0.26
> **git 分支:** 不改动（不新建、不切换、不重命名；沿用 `main`，与 `./opencode` 的 `Branch_v2.0.26` 无关）
> **涉及工程:** `oc-desktop-hos`（父工程 `D:\opencode-workspace\`）
> **上游基线:** opencode **v2.0.26**（tag `v2.0.26` / 提交 `9b4ec5714d` / `Branch_v2.0.26`）；pi **v2.0.26**（需求原文基线，落地状态见 §3.1）
> **运行期:** Electron 37（`v37.2.3-20260825.1` = Node **22.17.0** / Chromium 138 / ABI **v138**）
> **物料来源:** **父工程** `../assets/`（本机 `D:\opencode-workspace\assets\`）

## 1. 目的

把 `oc-desktop-hos` 从「工程骨架 + 首轮构建链」推进到**一轮可交付的版本**：把上游基线固化为
opencode `v2.0.26` 并发布 `versionName = 2.0.26`，清理历史中间产物，固化补丁集，
重新编译、真机部署，并用**真机实测**取代 `docs/鸿蒙环境能力清单.md` 中尚为 `⬜ 待验证` 的结论，
产出可引用的 `docs/鸿蒙环境能力清单-v2.0.26.md`。

本需求同时把「上游在 HarmonyOS 上不可得的能力」用 **JS 插件**替代（子规格 `102-harmony-js-tools`），
并把界面品牌从上游 `OpenCode` 收束到本工程 `OC Desktop`（子规格 `103-branding`）。

## 2. 范围

**In scope**

- 工程**中间文件 / 临时文件**的清理（清单见 §4.1 与 `plan.md` D2）。
- **版本号** `2.0.26`（`versionName` / `versionCode`）与文档、README 的同步。
- **补丁集**固化：`patches/v2.0.26/` 逐条复核（含工作区中尚未入库的候选补丁），往返可应用。
- **重新编译构建**：`collect-runtime` → `build-opencode`（含 host 侧 Node 22.17 冒烟门禁）→ `build-debug.ps1`。
- **真机部署与测试**：设置 DeepSeek API Key、创建沙箱工作区、完成一次真实对话。
- **鸿蒙环境能力真机复验**：按 `docs/鸿蒙环境能力清单.md` §5 的 `⬜-1 … ⬜-12` 逐条取证，输出
  `docs/鸿蒙环境能力清单-v2.0.26.md`。
- 子规格 `102-harmony-js-tools`（JS 插件替代）与 `103-branding`（品牌化）的**提出与落地**。

**Out of scope**

- **不改上游一个字节（直接编辑）**：`../opencode`、`../harmonypc-electron` 只通过 `patches/` 施加改动；
  构建脚本的幂等打补丁是唯一入口，禁止手工编辑上游工作树。
- **不改 git 分支**：不新建分支、不切换分支、不重命名分支（明确要求）。
- **不做上架材料**：不申请 ACL、不生成发布证书、不提交应用市场。
- **不做后台常驻 / PTY / 自绘标题栏**：平台级不可用或本工程已决定不实现（见 `docs/工程规划-V2.md` §7）。
- **不实现搜索的 `fff` FFI 变体**：设备侧 FFI 与 ELF 执行均不可用；搜索改走纯 JS（规格 102）。

## 3. 上游事实（本规格前提）

### 3.1 需求声明的基线（原文）与落地状态

需求原文写的是**两条**基线：`opencode 当前版本（tag=v2.0.26）`、`pi 当前版本（tag=v2.0.26）`。
两者都是 **v2.0.26**。逐条核实落地状态：

| 基线 | 需求声明 | 本工程实际构建输入 | 说明 |
|---|---|---|---|
| **opencode** | tag `v2.0.26` | ✅ **就是它** —— `../opencode` HEAD = `9b4ec5714d`（`release: v2.0.26`），`Branch_v2.0.26`，`git describe --tags` = `v2.0.26` | `build-opencode.mjs` 阶段 0 会前置校验 `EXPECTED_BASELINE=9b4ec5714d`，基线漂移即硬失败 |
| **pi** | tag `v2.0.26` | ⚠️ **本工程不使用 pi 的产物** | 见下方说明 |

**关于 pi 基线（如实登记，不作为阻塞）**：

1. `oc-desktop-hos` 的运行期服务端是 **opencode v2**（`opencode.mjs` + 内嵌 v2 Web UI），
   **不包含也不加载** pi 的任何产物；`pi` 不是本工程的构建输入（构建链只依赖
   `../opencode`、`../harmonypc-electron-versions`、`../assets`）。
2. `pi` 在本工作区（`D:\opencode-workspace\`）**没有 submodule**；`.gitmodules` 只有
   `opencode` / `oc-desktop-hos` / `oc-desktop-website` / `harmonypc-electron`。
3. 供参考：兄弟工作区 `D:\pi-workspace\pi` 的当前 checkout 是 `Branch_v1.1.0` / tag `v1.1.0`，
   其远端最新 tag 为 `v1.2.0`（实测 `git ls-remote --tags origin`）。
   ⬜ **待确认**：需求里的 `pi tag=v2.0.26` 指哪个仓库/远端（本机不可得）。
4. 因此本规格把 pi 基线按「**需求声明**」记录，并把 `pi-desktop-hos` 作为**参考实现**
   （其 `specs/101/102/103` 与本需求的三部分一一对应），而不是把 pi 当作构建输入。

> 若需求的本意是「同时基于 pi 的某次发布」，请给出该仓库地址/tag 来源 —— 那会改变构建输入集，
> 需要重新评估（本工程当前设计里没有 pi 的位置）。

### 3.2 上游事实

| # | 事实 | 出处 |
|---|---|---|
| U1 | 上游基线已固化：`../opencode` HEAD = `9b4ec5714d`（`release: v2.0.26`），分支 `Branch_v2.0.26`，`git describe --tags` = `v2.0.26`，`packages/*/package.json` 版本 `2.0.26` | `git -C ../opencode log/describe`、`packages/app/package.json:3` |
| U2 | 构建入口为 `node scripts/build-opencode.mjs`，其阶段 0 前置校验 `EXPECTED_BASELINE=9b4ec5714d` 与 `"version": "2.0.26"`；基线漂移即**硬失败** | `scripts/build-opencode.mjs:49-85` |
| U3 | 产物入口 `packages/cli/dist-node/opencode.mjs` + `assets/app-archive.bin`（内嵌 v2 Web UI，bro 压缩）；根路径 404 的判据是该归档缺失 | `scripts/build-opencode.mjs:196-201`、`packages/cli/script/app-assets.ts` |
| U4 | Web UI 由 `packages/app` 构建（`bun run build`）后 `collectFiles(dist)` → brotli → `AppArchive.encode`；**品牌化只在此产物上做**，不改上游源码 | `packages/cli/script/app-assets.ts:8-27` |
| U5 | 设备侧 `node:sqlite` **无 binding**（`No such binding: sqlite`），必须走 better-sqlite3 的 ohos 变体 | `patches/v2.0.26/0002-sqlite-ohos.patch`、`0004-tui-zed-sqlite-ohos.patch` |
| U6 | 应用级图标必须 **1024×1024 且不带 alpha**（含 Alpha 会被应用市场驳回）；当前 5 个 `AppScope/.../media/*.png` 为纯色占位图（colorType=2 RGB） | `scripts/collect-runtime.mjs:177-185`、`AppScope/` 实测 |
| U7 | 父工程物料：`assets/logo.png`（200²）、`assets/logo.svg`（矢量）、`assets/logo-1024-with-bg.png`（1024²，不带透明）；另有 `logo.icns` / `logo.ico` | 实测（PNG IHDR） |
| U8 | 运行时外壳（`electron/`、`web_engine/`）由 `collect-runtime.mjs` 从发行版归档投放，`runtime-overlays/` 白名单回盖，阶段 10 有 10 组结构化守卫（缺一即硬失败） | `scripts/collect-runtime.mjs:107-113`、`README.md` |
| U9 | 本工程 `AppScope/app.json5` 版本当前为 `versionName 0.1.0` / `versionCode 1` | `AppScope/app.json5` |
| U10 | 工作区存在**尚未入库**的真机驱动修复：`tar-extract.js` 的 `await` 缺陷、`better_sqlite3.node` 的 dlopen 锚点投放、`collect-runtime` 的 App 主进程语法门禁、候选补丁 `0004-tui-zed-sqlite-ohos` | `git status` / `git diff`（本规格不覆盖，属既有 WIP，必须保留） |

## 4. 需求条目

> MUST / MUST NOT / SHOULD / MAY。`plan.md` 逐条回引。

### 4.1 清理与版本

- **FR-ver-001**（MUST）：必须清理**中间文件与临时文件**，且清理集合必须是**可枚举的构建产物与临时目录**，
  不得删除源码、配置、文档、`patches/`、`specs/`、`skills/`、`plugins/` 与依赖目录（`node_modules/`、`oh_modules/`）。
- **FR-ver-002**（MUST NOT）：清理**不得**删除 `.gitignore` 之外的**已跟踪文件**；清理后 `git status` 不得出现
  「已跟踪文件被删除」。
- **FR-ver-003**（MUST）：`AppScope/app.json5` 的 `versionName` 必须为 `2.0.26`，`versionCode` 必须为 `20026`
  （规则 `major*10000 + minor*100 + patch`）。
- **FR-ver-004**（MUST）：版本号必须同步到 `README.md` 与 `docs/` 的相关文档；文档内不得残留 `0.1.0` 作为
  「当前版本」的表述（历史变更记录中的引用除外，须可解释）。
### 4.2 补丁集

- **FR-ver-005**（MUST）：`patches/v2.0.26/` 中每条补丁必须同时满足
  `git apply --check` 与 `git apply --reverse --check` 之一（未应用/已应用），不得处于「两者皆失败」状态。
- **FR-ver-006**（MUST）：补丁集必须包含设备侧必需的四条：`0001-node-target-ohos`（Node 22 目标 + `ohos` 条件）、
  `0002-sqlite-ohos`（`#sqlite` ohos 变体）、`0003-runtime-stubs-ohos`（`#pty` / `#persistent-pty-binary` 打桩）、
  `0004-tui-zed-sqlite-ohos`（TUI `#zed-sqlite` ohos 变体）。
- **FR-ver-007**（MUST）：`patches/v2.0.26/README.md` 的补丁清单必须与实际文件一致（编号、落点、作用）。
- **FR-ver-008**（MUST NOT）：不得使用 `--3way` 强行合并；冲突即终止并重生成补丁。

### 4.3 构建与产物

- **FR-ver-009**（MUST）：构建必须走既有四阶段流水线，任一阶段失败即中止，不得静默降级。
- **FR-ver-010**（MUST）：`collect-runtime` 的阶段 10 守卫必须全绿（含图标合规、权限断言、dlopen 锚点）。
- **FR-ver-011**（MUST）：`build-opencode` 的 host 侧 Node **22.17.0** 冒烟门禁必须全绿。
- **FR-ver-012**（MUST）：产出的必须是 **debug 签名** HAP（release 签名无法 `hdc app install -r` 侧载）。

### 4.4 真机部署与基本功能

- **FR-ver-013**（MUST）：必须完成「卸载 → 安装 → 启动」并观测到应用进入**就绪**（非白屏、非失败页）。
- **FR-ver-014**（MUST）：必须能设置 DeepSeek API Key（`<REDACTED_API_KEY>`）并持久化。
- **FR-ver-015**（MUST）：必须能创建一个工作区（沙箱内测试目录）并使其被服务端接受为项目根。
- **FR-ver-016**（MUST）：必须完成一次**真实对话**（prompt「介绍一下你自己」），取得模型回复。

### 4.5 能力复验与报告

- **FR-ver-017**（MUST）：必须对 `docs/鸿蒙环境能力清单.md` §5 的 12 条待验证项逐条取证，并在报告中标
  ✅/⚠️/❌ 与证据（命令、hilog 片段、文件路径、日期、设备）。
- **FR-ver-018**（MUST NOT）：未实测的条目必须保留 `⬜ 待验证`；不得以「应该可以」代替证据。
- **FR-ver-019**（MUST）：报告必须落到 `docs/鸿蒙环境能力清单-v2.0.26.md`，且**不得**覆盖 `v0.1` 版
  `docs/鸿蒙环境能力清单.md`（后者作为历史基线保留）。
- **FR-ver-020**（MUST）：观测点必须是**应用域**（宿主进程内 / CDP / hilog / 应用域文件探针）；
  `hdc shell` 的结论只能作为辅助证据（SELinux 域差异会骗人）。

### 4.6 不回归与可追溯

- **FR-ver-021**（MUST）：版本更新不得回归既有能力：应用启动、鉴权引导、UI 加载、better-sqlite3 持久化。
- **FR-ver-022**（MUST）：本轮所有改动必须可追溯到规格：`specs/101-version-2.0.26/`、`102-harmony-js-tools/`、
  `103-branding/` 与 `logs/<YYYYMMDD>-<N>/` 的记录。
- **FR-ver-023**（MUST）：提交信息必须符合 `git-commit` 技能的 Conventional Commits 前缀
  （`feat|fix|docs|chore|refactor|test|build|ci|perf|style|revert`），不得使用其它前缀。

## 5. 验收标准

| 编号 | 验收条件 | 判定方式 |
|---|---|---|
| AC-01 | 清理后 `git status` 无「已跟踪文件被删除」；源码/配置/文档/`patches/`/`specs/`/`skills/`/`plugins/` 与依赖目录均保留 | `git status --porcelain` 审阅 + 目录存在性核对 |
| AC-02 | `AppScope/app.json5` = `2.0.26` / `20026`，且装到真机的包版本与之一致 | 读 `app.json5` + `bm dump` 的 `versionName`/`versionCode` |
| AC-03 | 文档无残留「当前版本 0.1.0」的表述 | `grep -rn "0\.1\.0"` 且逐条可解释 |
| AC-04 | 4 条补丁各自通过往返判定（`apply --check` 或 `apply --reverse --check`） | 脚本逐条执行并记录 |
| AC-05 | `collect-runtime` 阶段 10 守卫全绿，输出守卫条数与结论 | 命令输出 |
| AC-06 | host 侧 Node 22.17 冒烟 8 项全绿（版本/CLI/服务端/健康检查/内嵌 UI/事件面/数据库/产物清单） | `node scripts/smoke-node22.mjs` |
| AC-07 | 产出 debug 签名 HAP，`hap-sign-tool verify-app` 通过 | 命令输出 |
| AC-08 | 真机安装启动后进入就绪；`hilog` 出现统一 `[oc-desktop]` 前缀的阶段日志直至「界面已加载」 | `hdc shell hilog` 摘录 |
| AC-09 | `/api/info` 返回 200，且 `version` 字段是**上游从基线算出的开发版字符串**（实测 `0.0.0-Branch_v2.0.26-<YYYYMMDDHHmm>`），**不是** `2.0.26`；应用侧版本号以 HAP 的 `versionName`/`versionCode` 为准 | 应用域 `fetch` 或 host 侧 `curl` + 读 `pack.info` |
| AC-10 | DeepSeek API Key 设置成功并出现在凭据存储中 | 应用域 UI 操作 + 凭据文件/接口取证 |
| AC-11 | 工作区创建成功，服务端以该目录为项目根 | `GET /api/location` 或等价接口 + 目录存在 |
| AC-12 | 一次真实对话取得模型回复（非报错、非空） | 会话消息记录摘录 |
| AC-13 | `docs/鸿蒙环境能力清单-v2.0.26.md` 存在，12 条待验证项逐条有结论与证据；未实测项保留 `⬜` | 文档审阅 |
| AC-14 | `docs/鸿蒙环境能力清单.md`（v0.1）仍存在且未被覆盖 | 文件存在性 + `git status` |
| AC-15 | 代码评审完成，无未决 Critical / Important | `logs/20261013-1/REVIEW_REPORT.md` |
| AC-16 | 提交信息前缀全部属于 `git-commit` 技能允许集合 | `git log --format=%s` 审阅 |

## 6. 已知风险

| # | 风险 | 处置 |
|---|---|---|
| R1 | 上游 `packages/app` 重新构建会引入与 opencode-workspace 不同的 Node/bun 行为，导致 UI 归档与既有验证基线不一致 | 构建前后记录 `app-archive.bin` 体积与 SHA-256；冒烟门禁覆盖「内嵌 UI 可取回」 |
| R2 | 清理误删未跟踪但**必需**的本地文件（如 `signing.debug.local.json`、`better_sqlite3.node` 锚点） | 清理清单显式排除签名材料与 `.cache/`（重建可再生成）；清理后立即跑守卫 |
| R3 | 真机 `hilog` 不落 `console.error`，失败表现为「白屏 + 零日志」 | 保留 `ocr-trace.log` 落盘诊断 + `collect-runtime` 的 App 脚本语法门禁 |
| R4 | 设备 API/系统版本与 `docs/工程规划-V2.md` 记录的设备不同，能力结论可能漂移 | 报告中记录**本轮设备**的型号/序列号/系统版本/API，与历史记录区分 |
| R5 | `versionCode` 复用导致覆盖安装不生效 | `versionCode` 由 `1` 提升到 `20026`，并在部署前 `hdc uninstall` |
| R6 | 能力复验与 UI 操作耦合，一旦 UI 不可用则能力测试无法进行 | 先用 host 侧门禁与 `/api/*` 取证锁定服务端能力，再做 UI 侧取证 |
| R7 | 构建依赖父工程 `../harmonypc-electron-versions/` 与 `../opencode`，干净 checkout 无法构建 | 文档显式登记前置；缺失即硬失败（不静默降级） |

## 7. 不做

- 不做应用市场上架材料、ACL 申请、发布证书。
- 不做后台常驻 / 开机自启 / 托盘（属 Phase 2/3，见 `docs/工程规划-V2.md` §7）。
- 不做 PTY 终端面板（平台级不可用）。
- 不改 `bundleName`（`org.fellow99.oc.OCDesktop`）。
- 不切换、不新建、不重命名 git 分支。
