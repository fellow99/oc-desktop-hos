# 四阶段构建流水线（005-build-pipeline）—— 规格

> **Module:** 005-build-pipeline ｜ **Status:** Proposed ｜ **Last Updated:** 2026-10-11 ｜ **上游基线:** opencode v2.0.26（Branch_v2.0.26）

## 1. 模块概述

### 1.1 目的（Why this module exists）

把「一个空工程 → 可安装的签名 HAP」定义为一条可复现、可重入、失败即停的四阶段流水线：

| 阶段 | 脚本/命令 | 产出 |
|------|-----------|------|
| ① collect-runtime | `scripts/collect-runtime.mjs` | `electron/`（SO + Chromium 资源 + `better_sqlite3.node`）、`web_engine/` 桥接层、`runtime-overlays/` 回盖 |
| ② build-opencode | `scripts/build-opencode.mjs` → `scripts/collect-opencode.mjs` | 幂等补丁 + `dist-node/{opencode.mjs, assets/**}` → 裁剪 → `opencode-dist.tar.gz`(ustar) + SHA-256 marker → 投放 `resfile` |
| ③ collect-app | `scripts/collect-app.mjs` | `src-main/` 产物投放 `resfile/resources/app/` |
| ④ hvigor 构建 | `ohpm install` + `hvigorw assembleHap` + 签名 + `hdc` | 签名 HAP，可安装启动 |

并定义 **host 侧 Node 22.17 门禁**（`scripts/smoke-node22.mjs`）：在把产物推上真机之前，先在构建机上证明它能跑。

### 1.2 解决的问题（What pain points it addresses）

- **上游不可追踪**：手改 `../opencode` 无法复核 → 只做**幂等补丁**（`git apply --reverse --check` 判据、冲突即终止、可往返还原）。
- **Node 版本错位**：✅ v2 产物由 Vite 以 `target: "node26"` 构建（含 Node 26 的 `--experimental-ffi`），设备侧是 Electron 37 内置的 **Node 22.17.0** → 补丁 0001 降到 `node22`，并用 host 门禁兜底。
- **设备侧不可能执行自备 ELF**：→ 只用 `--bundle-only`（非 SEA）产物，不做 SEA 打包。
- **不确定的产物推真机代价高**：→ host 门禁失败即阻断流水线（禁止把不确定产物推到真机）。
- **小文件入 HAP 不可行**：→ 打包为单个 tar.gz（与 003 约定一致）。
- **构建机差异致命**：🔶 同源码同 SO 因构建机差异崩溃（`ets/modules.abc` 与 `resources.index` 大小不同）→ 工具链版本必须在第一天固定并记录。
- **`ohos` 条件变体需要构建期打开**：`resolve.conditions` 前置 `"ohos"`（补丁 0001），否则补丁 0002/0003 的变体永远不会被选中。

### 1.3 范围（Scope）

**包含**：

- 四阶段的顺序、输入/输出、判据、幂等要求与失败语义；
- 阶段①运行时投放清单与校验（SO md5 对齐 `runtime-manifest.json`、Chromium 资源、`libc++_shared.so`、`better_sqlite3.node`、overlay 回盖）；
- 阶段②补丁契约（`patches/v2.0.26/000{1,2,3}-*.patch` 等）、上游构建命令与参数、产物裁剪规则、tar.gz + marker 打包与投放；
- 阶段③`src-main/` 投放规则（不覆盖产物、清理陈旧文件）；
- 阶段④`ohpm install` + hvigor 构建命令、工具链固定纪律、签名材料注入的调用点（详见 006）；
- host 侧门禁 `smoke-node22.mjs` 的断言集与阻断语义；
- 产物指标采集（文件数、字节数、SHA-256、耗时）与可复现性要求。

**不包含**：

- 解压算法与 marker 语义（见 `003-artifact-bootstrap`，本模块只负责产出与格式约定）；
- bundleName / label / 签名材料 / ACL 的内容（见 `006-signing-identity`）；
- 宿主形态与 `argv`（见 `007-runtime-host`、`008-server-ui-load`）；
- 官网、分发与上架流程（Phase 3）。

## 2. 用户故事

- 作为研发，我希望一条命令链从零产出可安装的 HAP，不需要手工拷贝文件。
- 作为研发，我希望产物在推真机之前先在构建机上跑通（省掉真机往返）。
- 作为研发，我希望重跑流水线不会重复打补丁、不会破坏上游工作区。
- 作为评审者，我希望每次构建都能给出 SHA-256 与体积事实，且同源码两次构建稳定。
- 作为研发，我希望补丁失效（上游代码变动）时流水线立刻停下并指出是哪个补丁，而不是带着错误产物继续。

## 3. 功能需求

### 3.1 流水线总则

- FR-005-001 流水线 MUST 由四个阶段构成且顺序固定：① collect-runtime → ② build-opencode（含 collect-opencode）→ ③ collect-app → ④ hvigor 构建与签名安装。
- FR-005-002 每个阶段 MUST 幂等可重入：重复执行不产生错误、不破坏上一阶段产物。
- FR-005-003 每个阶段 MUST fail-fast：任一步非零退出即中止整条流水线，MUST NOT 继续后续阶段（不允许把不确定产物推到真机）。
- FR-005-004 阶段之间 MUST 只通过文件系统交接（约定路径 + 校验），MUST NOT 依赖前一次运行的内存状态或临时环境。
- FR-005-005 每个阶段 MUST 输出结构化日志（统一前缀），并在结束时打印「输入 → 输出 → 判据」摘要。
- FR-005-006 流水线 MUST NOT 修改 `../harmonypc-electron`、`../harmonypc-electron-versions`（只读消费）。

### 3.2 阶段①：collect-runtime

- FR-005-007 阶段① MUST 从 `../harmonypc-electron-versions/v37.2.3-20260825.1-release.zip` 解压并投放：`electron/libs/arm64-v8a/{libelectron.so,libadapter.so,libffmpeg.so}`、Chromium 资源（`icudtl.dat`、`snapshot_blob.bin`、`v8_context_snapshot.bin`、`resources.pak`、`chrome_*_percent.pak`、`locales/*.pak`、`resfile` 启动器）与 `web_engine/` 桥接层。
- FR-005-008 阶段① MUST 从 DevEco SDK 的 `native/llvm/lib/aarch64-linux-ohos/` 补入 `libc++_shared.so`。
- FR-005-009 阶段① MUST 投放 `better_sqlite3.node`（v12.4.5，aarch64-ohos / **ABI v138**）到 `electron/libs/arm64-v8a/`；MUST NOT 投放到 `resfile` 解压目录（🔶 原生 `.node` 不能从 `resfile` dlopen）。
- FR-005-010 阶段① MUST 在拷贝完成后应用 `runtime-overlays/` 白名单回盖（保护本工程定制不被覆盖），并校验回盖命中的文件清单。
- FR-005-011 阶段① MUST 做完整性校验并以失败结束：三个 SO 的 md5 与 `runtime-manifest.json` 一致、关键 Chromium 资源存在、`web_engine` 入口存在（`barrelFile`）、失败即中止。
- FR-005-012 阶段① MUST NOT 在产物中保留 `--inspect` 等调试默认项（运行时的默认启动参数属运行时侧，本阶段只做投放与校验；生产开关由 001/006 的门控负责）。

### 3.3 阶段②：build-opencode（补丁 + 上游构建）

- FR-005-013 阶段② MUST 逐条判断补丁是否已应用（`git apply --reverse --check` 成功即视为已应用 → 跳过），MUST NOT 重复应用。
- FR-005-014 补丁 MUST 从 `patches/v2.0.26/` 按文件名字典序应用；本版补丁集为 `0001-node-target-ohos.patch`、`0002-sqlite-ohos.patch`、`0003-runtime-stubs-ohos.patch`（`0004-search-ohos.patch` / `0005-plugin-gate.patch` 属 Phase 2，编号预留给不影响本阶段顺序的位置）。
- FR-005-015 补丁冲突时 MUST 立即终止流水线；MUST NOT 使用 `--3way` 强行合并，MUST NOT 覆盖 `../opencode` 中的用户改动。
- FR-005-016 补丁 MUST 可往返：正向应用后反向应用，源码 SHA-256 必须还原；往返校验失败即中止。
- FR-005-017 补丁 MUST NOT 引入镜像噪声（`bun.lock` 等由 `bun install` 重新生成的文件不进补丁），且新补丁 MUST NOT 落在既有补丁前后各 3 行的连续上下文区间。
- FR-005-018 阶段② MUST NOT 新增上游构建脚本；构建命令固定为：
  `bun install --os=* --cpu=*` 与 `bun run --cwd packages/cli script/build-node.ts --target=linux-arm64 --bundle-only`（在 `../opencode` 内执行）。
- FR-005-019 阶段② MUST 通过补丁 0001 让 `build.target` 可配置（本工程设为 `node22`）并在 `resolve.conditions` 前置 `"ohos"`；构建 MUST 断言这两项生效（构建日志或产物校验）。
- FR-005-020 阶段② MUST 让三条补丁在产物中生效可证：`#sqlite` 走 better-sqlite3 变体、`#pty` 与 `#persistent-pty-binary` 走 stub；⬜ 待验证：设备侧确认（PTY 调用返回「不可用」而 bundle 不崩、会话持久化写库成功）。

### 3.4 阶段②b：collect-opencode（裁剪 + 打包 + marker + 投放）

- FR-005-021 裁剪 MUST 删除：非 arm64 原生件（如 `fff-bin` 的其它平台产物、`node-pty` 的其它平台产物）、`opencode-pty` 助手 ELF、以及产物内若存在的 `node_modules/` 目录。
- FR-005-022 被裁项 MUST 有「不会被加载」的保证：由补丁 0001/0003 的 `ohos` 变体与 `OPENCODE_DISABLE_FFF` 等开关承担；MUST NOT 只靠「删除文件」而不改调用路径。
- FR-005-023 打包 MUST 使用 `tar --format=ustar` + gzip，输出 `opencode-dist.tar.gz`；tar 内 MUST 只有唯一顶层前缀 `dist-node/`，MUST NOT 含符号链接/硬链接条目。
- FR-005-024 阶段②b MUST 计算 tar 的 SHA-256 并写入 `opencode-dist.version`（内容 = 小写十六进制 + 换行），与 tar 一起投放到 `web_engine/src/main/resources/resfile/resources/app/`。
- FR-005-025 阶段②b MUST 在投放前校验 tar 内容：文件数、总字节数、`opencode.mjs` 与 `assets/app-archive.bin` 存在、无链接条目、全部条目名以 `dist-node/` 开头（与 003 的 host 侧往返校验共用断言）。
- FR-005-026 阶段②b MUST 打印并记录产物指标：tar 字节数、文件数、`opencode.mjs` 的 SHA-256、`app-archive.bin` 字节数；⬜ 实测值待采集（工程规划 O7）。

### 3.5 阶段③：collect-app

- FR-005-027 阶段③ MUST 把 `src-main/`（`main.js`、`sidecar.js`、`tar-extract.js`、`package.json`）投放到 `web_engine/src/main/resources/resfile/resources/app/`。
- FR-005-028 阶段③ MUST NOT 覆盖或删除 003/005 产出的 `opencode-dist.tar.gz` 与 `opencode-dist.version`。
- FR-005-029 阶段③ MUST 清理 `src-main/` 中已删除文件的陈旧投放副本（否则会出现「改了源码但设备跑旧代码」的幽灵现象），并打印清理清单。
- FR-005-030 阶段③ SHOULD 支持对 `src-main/**` 的语法自检（`node --check` 级别的快速失败），在推真机前拦住低级错误。

### 3.6 阶段④：hvigor 构建、签名与安装

- FR-005-031 阶段④ MUST 先执行 `ohpm install`（DevEco 的 `tools/ohpm/bin/ohpm.bat`），且当 `oh_modules` 被删除后 MUST 重新执行。
- FR-005-032 阶段④ MUST 在固定工具链下构建：设置 `NODE_HOME`（DevEco 自带 Node）与 `DEVECO_SDK_HOME`，清除 `NODE_OPTIONS`，使用 DevEco 自带 JBR（🔶 用其它 JDK 会报 `Invalid CEN header`）。
- FR-005-033 阶段④ MUST 通过 `cmd /c` 调用 `.bat`/`.cmd`（`bun`、`hvigorw`）；MSYS/Git-Bash 环境下 MUST 设置 `MSYS_NO_PATHCONV=1`。
- FR-005-034 阶段④ MUST 使用 `hvigorw assembleHap --mode module -p product=default -p buildMode=debug --no-daemon` 产出 debug HAP，release 档由 `-p buildMode=release` 与发布签名材料产出（签名细节见 006）。
- FR-005-035 阶段④ MUST 提供安装启动命令序列：`hdc app install -r electron/build/default/outputs/default/electron-default-signed.hap` → `hdc shell aa start -a EntryAbility -b org.fellow99.oc.OCDesktop`；部署前清理旧产物时使用不带 `-r` 的 `hdc uninstall`。
- FR-005-036 阶段④ MUST 记录构建产物哈希（HAP 与其包含的 tar）与工具链版本，形成「可运行参照产物」基线（工程规划 P0-6）。

### 3.7 host 侧门禁：smoke-node22

- FR-005-037 门禁 MUST 使用与设备同版本的 Node **22.17.0**（Electron 37 内置版本）运行 `dist-node/opencode.mjs`；⬜ 待验证：构建机上该 Node 的来源（DevEco 自带 Node 的版本是否符合；不符合则需独立安装并在脚本中断言 `node -v` 输出）。
- FR-005-038 门禁 MUST 依次断言：① `opencode.mjs --version` 正常输出；② `opencode.mjs --help` 正常输出；③ 以 `OPENCODE_NODE_ASSETS_DIR=<dist-node>/assets`、`OPENCODE_PASSWORD=<随机>`、`OPENCODE_DISABLE_MODELS_FETCH=1`、`OPENCODE_FILEWATCHER_DISABLE=1`、`OPENCODE_DISABLE_FFF=1` 启动 `serve --hostname 127.0.0.1 --port 4096`；④ `GET /api/info`（带凭据）返回 200；⑤ `GET /` 返回 SPA `index.html`（含 v2 UI 标记）；⑥ `GET /api/event` 能读到首个事件（`server.connected`）。
- FR-005-039 门禁失败 MUST 阻断流水线（非零退出），MUST NOT 允许继续打包或安装到真机。
- FR-005-040 门禁 MUST 在结束后清理其启动的进程（不留监听端口与孤儿进程），并打印每项断言的结果与原始错误首行。
- FR-005-041 门禁 MUST 复用 004 的凭据生成/头拼接逻辑，保证 host 与设备两侧的鉴权方式一致。

### 3.8 可复现性与工具链固定

- FR-005-042 流水线 MUST 在结束时输出统一摘要：各阶段状态、tar SHA-256、HAP 路径、（release 档）HAP SHA-256、工具链版本（DevEco / hvigor / ArkTS 编译器 / bun / Node）。
- FR-005-043 同源码、同工具链、同环境下两次完整构建 MUST 产出哈希一致的 `opencode.mjs` 与 tar；不一致即视为缺陷并记录（工程规划 P0-6）。
- FR-005-044 流水线 MUST 把「工具链版本 + 产物哈希」写入 `docs/真机验证记录.md`（或引用的构建日志文件），作为换机对照的基线。

## 4. 关键实体

| 实体 | 说明 | 关键属性 |
|------|------|----------|
| 流水线阶段（BuildStage） | 四阶段之一 | `id`、`inputs`（路径/来源）、`outputs`（路径）、`gate`（判据）、`idempotent` |
| 补丁（PatchSpec） | 单个上游补丁 | `file`(`patches/v2.0.26/000N-*.patch`)、`reverseCheck`（是否已应用）、`touchedFiles` |
| 补丁集状态（PatchSetState） | 本轮应用结果 | `tag`(`v2.0.26`)、`applied[]`、`skipped[]`、`roundTripOk`（往返校验） |
| 产物清单（ArtifactManifest） | 打包事实 | `tarPath`、`tarSha256`、`fileCount`、`bytes`、`opencodeMjsSha256`、`buildAt` |
| 裁剪项（TrimRule） | 被删除项及其保障 | `pattern`、`reason`、`enforcedBy`（补丁号 / 环境开关） |
| 门禁结果（SmokeResult） | 单条门禁断言 | `case`(`version`/`help`/`serve`/`info`/`spa`/`event`)、`result`(`pass`/`fail`)、`errorText`、`durationMs` |

## 5. 验收场景

### 场景 1：从零到签名 HAP

- Given 干净工程（无 `electron/libs` 资源、无 `dist-node`、无 tar）、`../opencode` 处于 `Branch_v2.0.26`
- When 依次执行四个阶段
- Then 产出 `opencode-dist.tar.gz`（含 `opencode.mjs` 与 `assets/app-archive.bin`）与签名 HAP；安装后应用可启动

### 场景 2：幂等重跑

- Given 上一次构建已完成且补丁已应用
- When 再次执行阶段②（含补丁步骤）
- Then 全部补丁经反向检查被跳过；上游工作区无改动；tar 的 SHA-256 与上次一致（同源码同环境）

### 场景 3：补丁冲突即终止

- Given 上游某文件被手工改动导致 `0002-sqlite-ohos.patch` 无法应用
- When 执行阶段②
- Then 立即以非零退出终止，指出冲突补丁名，且不修改上游其它文件、不进入阶段③

### 场景 4：补丁往返还原

- Given 三条补丁已正向应用
- When 依次反向应用
- Then 受影响文件与补丁前源码的 SHA-256 完全一致

### 场景 5：host 门禁失败阻断

- Given 产物在 Node 22.17 下启动失败（例如加载到不被支持的语法）
- When 执行 `node scripts/smoke-node22.mjs`
- Then 门禁失败并阻断流水线；MUST NOT 继续打包或安装真机

### 场景 6：裁剪生效

- Given 上游 `dist-node/assets` 含非 arm64 原生件与 `opencode-pty`
- When 执行阶段②b
- Then tar 内不含这些项；打包日志列出被裁项与「由哪个补丁/开关保证不会加载」

### 场景 7：运行时校验失败 fail-visible

- Given `libelectron.so` 与 `runtime-manifest.json` 的 md5 不一致
- When 执行阶段①
- Then 以非零退出并打印期望值与实际值，MUST NOT 继续后续阶段

## 6. 非功能需求

- **性能**：阶段①的归档解压与阶段②的 `bun install` SHOULD 有缓存/跳过策略（归档已解压且校验通过则跳过；`node_modules` 未变则跳过安装），避免每次全量重跑。
- **可靠性**：fail-fast、无隐式降级；阶段②不得留下「半应用」的补丁状态（要么全部成功，要么整体回退到进入前的状态）。
- **可维护性**：每个阶段一个脚本、共享一个 `scripts/lib/` 工具集；命令可复制到文档（附录 A 的关键命令速查必须可执行）。
- **安全性**：补丁幂等且可往返；签名材料不入库（见 006）；构建脚本 MUST NOT 从网络下载未经校验的可执行文件。
- **可复现性**：同源码同环境两次构建哈希一致；工具链版本与产物哈希必须记录。

## 7. 假设与约束

- 假设 ✅：`bun run --cwd packages/cli script/build-node.ts --target=linux-arm64 --bundle-only` 在 Windows 构建机上可用，且使用 `--bundle-only` 时不做 SEA、不做 host 冒烟 → 门禁须自建。
- 假设 ✅：v2 产物默认以 `target: "node26"` 构建，设备侧 Electron 37 内置 Node 22.17.0 → 必须降级 + 门禁（工程规划 R2）。
- 假设 ✅：`@opencode/core` 的 `imports` 提供 `#sqlite`/`#pty`/`#persistent-pty-binary`/`#fff` 等条件变体，且 Vite `resolve.conditions` 可前置自定义条件 `"ohos"`。
- 假设 🔶：数万小文件入 HAP 会卡死 hvigor 或触发 Electron 启动 CHECK 崩溃 → 必须单文件 tar.gz。
- 假设 🔶：工具链（DevEco / hvigor / ArkTS 编译器）差异会导致同源码同 SO 的产物崩溃 → 第一天对齐并固定。
- 约束：MUST NOT 新增上游构建脚本、MUST NOT fork 上游；补丁只做「新增文件 + 少量开关式改动」。
- 约束：构建必须使用 DevEco 自带 JBR 与 Node；`.bat`/`.cmd` 经 `cmd /c` 调用；Git-Bash 下 `MSYS_NO_PATHCONV=1`。
- ⬜ 待验证：bun 在 Windows 上以 `--os=* --cpu=*` 安装全平台可选依赖的可行性与耗时。
- ⬜ 待验证：`dist-node` 实际文件数与字节数、tar 与 HAP 体积、解压耗时（工程规划 O7）。
- ⬜ 待验证：Windows 侧 `tar --format=ustar` 对长路径与 UTF-8 名的兼容（与 003 共享结论）。
- ⬜ 待验证：构建机上 Node 22.17.0 的来源与可用性（DevEco 自带 Node 版本未知）。

## 8. 依赖

**上游（被本模块消费）**：

- `packages/cli/script/build-node.ts` 与 `--target=linux-arm64 --bundle-only` 语义（✅ 源码）；
- `packages/cli/vite.node.config.ts`（`build.target`、`resolve.conditions`、`inlineDynamicImports`，✅ 源码）；
- `packages/core/package.json` 的 `imports` 条件变体表（✅ 源码）。

**本工程（被本模块消费）**：

- `patches/v2.0.26/000{1,2,3}-*.patch`（本模块应用与校验，内容见工程规划 §6.2）；
- `runtime-overlays/`（阶段①回盖白名单）；
- `src-main/`（阶段③投放源）；
- `006-signing-identity`（阶段④的签名材料与版本注入约定）。

**下游（消费本模块）**：

- `003-artifact-bootstrap`：消费 tar.gz 与 `opencode-dist.version`；
- `007-runtime-host` / `008-server-ui-load`：消费者与设备侧入口；
- `docs/真机验证记录.md` / 附录 A 命令速查：记录构建基线与命令。
