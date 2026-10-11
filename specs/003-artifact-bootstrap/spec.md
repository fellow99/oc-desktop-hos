# 产物就位（003-artifact-bootstrap）—— 规格

> **Module:** 003-artifact-bootstrap ｜ **Status:** Proposed ｜ **Last Updated:** 2026-10-11 ｜ **上游基线:** opencode v2.0.26（Branch_v2.0.26）

## 1. 模块概述

### 1.1 目的（Why this module exists）

把随 HAP 分发的 `opencode-dist.tar.gz`（ustar + gzip，内含 opencode v2 的 Node bundle 与内嵌 UI 归档 `assets/app-archive.bin`）在**运行时**流式解压到 `<userData>/opencode-dist/`，并用 SHA-256 marker 保证「幂等跳过」与「升级自动生效」。模块的输出是后续所有模块的前提：宿主（007）要 import 的 `opencode.mjs`、服务端（008）要设的 `OPENCODE_NODE_ASSETS_DIR`。

### 1.2 解决的问题（What pain points it addresses）

- **小文件入包不可行**：🔶 同型工程真机实测「数百至数万个小文件直入 HAP 会卡死 hvigor，或令 Electron 启动 CHECK 崩溃」→ 必须单文件大产物 + 运行时解压。
- **marker 只比存在性会失效**：🔶 dsh 的 marker 只判存在 → 就地升级不生效，必须 `hdc uninstall` 后重装（工程规划 §6.3 明确本工程改为 SHA-256 比对）。
- **文件系统语义缺失**：🔶 应用域 `symlink` `EACCES`、`hardlink` `EPERM`、`chmod` 静默失效 → 打包期与解压期都必须绕开链接语义，并自证写入结果。
- **半成品残留**：解压中途失败若把半个产物留在最终目录，宿主会以「文件缺失」形式随机失败且难以定位。
- **首启耗时长但不可见**：解压与首启耗时未知（⬜ 工程规划 O7）→ 必须有阶段与指标，否则体验问题无法定位。
- **安全**：tar 条目可携带路径穿越或链接条目（潜在越权写入）→ 必须 fail-closed 校验。

### 1.3 范围（Scope）

**包含**：

- 产物形态约定：tar.gz（ustar）、顶层唯一前缀、内容裁剪边界、marker 文件格式；
- 投放路径（`resfile` 内）与运行时解压目标（`<userData>/opencode-dist/`）；
- 流式解压实现（gzip + ustar 逐条目写盘、剥前缀、目录创建、大小校验）；
- 幂等与升级策略（SHA-256 比对、临时目录 + 原子替换、失败回退旧产物）；
- 失败可见（`__extractError`、阶段文本、日志指标）与临时目录清理；
- 路径安全校验（绝对路径、`..`、链接条目）。

**不包含**：

- 产物如何构建与裁剪（见 `005-build-pipeline`；本模块只消费其结果并校验约定）；
- 阶段时序与退出清理（见 `002-lifecycle`）；
- 宿主如何 import 产物、`argv` 与 env（见 `007-runtime-host`、`008-server-ui-load`）；
- 原生 `.node` 的投放位置与加载（见 `005` 与 `§3.6` 约束，`.node` 走 `electron/libs/arm64-v8a/`，不经本模块解压目录 dlopen）。

## 2. 用户故事

- 作为用户，我希望首次启动自动完成产物就位并看到进度提示，之后每次启动都很快。
- 作为研发，我希望升级 HAP 后产物自动更新，不需要手工卸载重装。
- 作为研发，我希望解压失败时能立刻区分是「tar 损坏」「SHA 不匹配」「写入失败」还是「校验失败」。
- 作为用户，我希望解压中途失败时应用不会永久不可用（旧产物仍可运行，且有明显提示）。
- 作为安全评审者，我希望恶意 tar 条目（路径穿越、链接）被明确拒绝并留证。

## 3. 功能需求

### 3.1 产物形态与投放

- FR-003-001 构建期 MUST 产出 `opencode-dist.tar.gz`（`--format=ustar` + gzip）与 `opencode-dist.version`（内容 = tar 包 SHA-256），二者 MUST 投放到 `web_engine/src/main/resources/resfile/resources/app/`。
- FR-003-002 tar 内 MUST 只有唯一顶层前缀 `dist-node/`；MUST NOT 使用符号链接或硬链接，全部为真实文件条目（🔶 应用域不支持链接）。
- FR-003-003 tar 内 MUST NOT 含 `node_modules/`、非 arm64 原生件、`opencode-pty` 助手 ELF（裁剪规则由 `005-build-pipeline` 执行，本模块只依赖结果）。

### 3.2 解压

- FR-003-004 系统 MUST 在运行时**流式解压**（gzip 解压 + ustar 解析 + 逐文件写盘）；内存占用 MUST NOT 随包体积增长；MUST NOT 依赖设备侧 `tar` 命令。
- FR-003-005 系统 MUST 把条目落到 `<userData>/opencode-dist/` 并剥掉顶层前缀 `dist-node/`，最终布局为 `<userData>/opencode-dist/opencode.mjs` 与 `<userData>/opencode-dist/assets/**`。
- FR-003-006 系统 MUST 先比对 SHA-256：与 marker 一致 → 跳过解压（幂等）；不一致或 marker 缺失 → 执行解压并重写 marker。
- FR-003-007 系统 MUST NOT 把半成品留在最终目录：解压写入临时目录 `<userData>/opencode-dist.tmp-<sha8>/`，成功校验后再替换为 `<userData>/opencode-dist/`；⬜ 待验证：hmdfs 上目录 rename 的原子性与限制（验证方式：真机做临时目录→目标目录替换并注入中途失败）。
- FR-003-008 系统 MUST 做条目安全校验并 fail-closed：拒绝绝对路径、含 `..` 段的路径、以及非普通文件/目录的条目（符号链接、硬链接、设备等），拒绝时 MUST 报出条目名。

### 3.3 失败可见与恢复

- FR-003-009 解压或校验失败时系统 MUST 写 `globalThis.__extractError`（脱敏摘要 ≤ 2500 字符）、输出 `[oc-desktop]` 日志、并驱动 loading 页的失败态（由 002 展示）。
- FR-003-010 失败时若存在完整旧产物，系统 MUST 保留其可用状态并给出可见提示（不静默）；首次启动且无旧产物时 MUST 阻断启动并显示原因。
- FR-003-011 系统 MUST 在下次启动前清理失败留下的临时目录（避免占空间与误判）。
- FR-003-012 系统 MUST 对写入结果自证：回读校验关键文件（至少 `opencode.mjs` 的存在、大小与 SHA-256），🔶 因为 hmdfs 上 `chmod` 静默失效且写盘异常不必然报错。
- FR-003-013 系统 MUST NOT 对解压产物调用 `chmod` 或依赖文件 mode（🔶 无效且 JS 不依赖执行位）。

### 3.4 marker 与升级

- FR-003-014 marker MUST 为 `<userData>/opencode-dist.version`，内容为 `resfile` 内 tar 包的 SHA-256（小写十六进制 + 换行）。
- FR-003-015 升级策略 MUST 为「HAP 内 tar 的 SHA-256 ≠ marker → 重新解压并替换」；MUST NOT 要求用户手工卸载（纠正 🔶 dsh 只比存在性的做法）。
- FR-003-016 系统 MUST 在日志中记录：包 SHA-256（前 8 位）、marker 值（前 8 位）、是否跳过、解压文件数与字节数、耗时。
- FR-003-017 系统 SHOULD 提供「强制重解压」的调试开关，用于真机故障恢复与验证。

### 3.5 对外提供的路径契约

- FR-003-018 系统 MUST 以产物根为唯一来源提供：宿主入口 `<userData>/opencode-dist/opencode.mjs`、资产目录 `<userData>/opencode-dist/assets`（供 008 设置 `OPENCODE_NODE_ASSETS_DIR`）。
- FR-003-019 解压 MUST NOT 改写包内文件内容（除剥前缀外零变换），保证 host 侧冒烟与设备侧运行的是同一字节。

## 4. 关键实体

| 实体 | 说明 | 关键属性 |
|------|------|----------|
| 产物包（ArtifactBundle） | 随 HAP 分发的 tar.gz | `tarPath`（`resfile` 内）、`sha256`、`sizeBytes` |
| 版本标记（VersionMarker） | 幂等与升级判据 | `path`(`<userData>/opencode-dist.version`)、`sha256`、`writtenAt` |
| 解压结果（ExtractResult） | 一次解压的产出 | `root`、`fileCount`、`bytes`、`durationMs`、`skipped` |
| tar 条目（TarEntry） | ustar 条目模型 | `name`（含前缀）、`relPath`（剥前缀后）、`type`(`file`/`dir`/`rejected`)、`size`、`mode` |
| 解压错误（ExtractError） | 失败摘要 | `phase`(`verify`/`extract`/`replace`/`recheck`)、`entry`、`message` |

## 5. 验收场景

### 场景 1：首次解压成功

- Given `<userData>/opencode-dist/` 不存在、marker 不存在、`resfile` 内 tar 完整
- When 应用启动进入 `artifact` 阶段
- Then 临时目录解压完成 → 替换为 `<userData>/opencode-dist/` → 写 marker → `opencode.mjs` 回读校验通过；阶段 `ok` 并记录文件数、字节数、耗时

### 场景 2：二次启动跳过

- Given marker 与当前 tar 的 SHA-256 一致、产物完整
- When 应用再次启动
- Then 不执行解压（`skipped = true`），阶段耗时显著低于首次；marker 不被重写

### 场景 3：HAP 升级自动生效

- Given 设备上 marker 为旧版 SHA-256，新 HAP 内 tar 不同
- When 应用启动
- Then 判为版本不同 → 重新解压并替换产物 → marker 更新为新 SHA-256；无需 `hdc uninstall`

### 场景 4：tar 损坏且存在旧产物

- Given 旧产物与旧 marker 自洽，新 tar 截断/损坏
- When 应用启动
- Then 阶段 `failed` 并显示原因（条目名或校验失败）；临时目录被清理；旧产物保留可用；界面提示明显（不静默）

### 场景 5：首次启动且 tar 损坏

- Given 无任何产物、tar 损坏
- When 应用启动
- Then 阻断在 `artifact` 阶段并显示原因；MUST NOT 继续到 `host`

### 场景 6：恶意条目被拒绝

- Given tar 内含 `../escape.txt`、绝对路径条目或符号链接条目
- When 解压器读到该条目
- Then 立即判失败并报出条目名；MUST NOT 在目标目录之外写入任何字节

### 场景 7：回读校验失败

- Given 解压后 `opencode.mjs` 大小或 SHA-256 与包内记录不一致（模拟写盘截断）
- When 执行回读校验
- Then 判 `recheck` 阶段失败，不替换最终目录，写 `__extractError`

## 6. 非功能需求

- **性能**：流式、恒定内存；二次启动的开销上限为「读一遍 tar 计算 SHA-256」；解压耗时、文件数、字节数与首启总耗时 MUST 可度量（⬜ 实测值待采集）。
- **可靠性**：失败不留半成品；替换失败不破坏旧产物；重复启动结果一致。
- **可维护性**：格式假设（ustar、前缀 `dist-node/`、marker 名）集中在少数常量，并与 `005-build-pipeline` 的构建期校验共享同一约定。
- **安全性**：路径与条目类型校验 fail-closed；不执行包内任何可执行体；不 chmod；解压目标永不越出 `<userData>`。
- **幂等性**：反复执行 `ensureArtifact()` 不重复解压、不重复写 marker，返回值稳定。

## 7. 假设与约束

- 假设 🔶：数万小文件入 HAP 不可行（hvigor 卡死或 Electron 启动 CHECK 崩溃）→ tar.gz + 运行时解压是唯一可行形态。
- 假设 🔶：应用域 `symlink` `EACCES`、`hardlink` `EPERM`、`chmod` 静默失效 → 打包与解压都必须只用普通文件 + 目录。
- 假设：✅ 上游 `--bundle-only` 产出 `dist-node/{opencode.mjs, assets/**}`，且非 SEA 运行时从 `OPENCODE_NODE_ASSETS_DIR` 读 `app-archive.bin`。
- 约束：产物根固定为 `<userData>/opencode-dist/`；MUST NOT 从 `resfile` 直接加载产物（🔶 原生 `.node` 不能从 resfile 解压目录 dlopen，见工程规划 §3.6；JS 侧仍走解压目录）。
- ⬜ 待验证：Windows 侧 `tar --format=ustar` 打包工具（bsdtar / Git Bash tar）对 ustar 头、长路径与 UTF-8 名的兼容性（验证方式：host 侧用本模块同一解析器读回全部条目名与大小并与源目录对比）。
- ⬜ 待验证：hmdfs 上目录 rename / 替换的原子性与跨目录限制（验证方式：真机注入中途失败并观察目标目录状态）。
- ⬜ 待验证：`<userData>` 剩余空间与配额行为（验证方式：真机对比 tar 原始大小与解压后占用，并做空间不足注入）。
- ⬜ 待验证：解压耗时与首启体验（工程规划 O7；验证方式：真机记录 StageTrace 耗时与首屏时间）。

## 8. 依赖

**上游（被本模块消费）**：

- `packages/cli/script/build-node.ts --bundle-only` 的产物布局（`dist-node/{opencode.mjs, assets/**}`，含 `assets/app-archive.bin`）；
- 产物前导（prelude）对 `OPENCODE_NODE_ASSETS_DIR` 的语义（非 SEA 时指向 assets 目录）。

**本工程（被本模块消费）**：

- `005-build-pipeline`：产出 tar.gz 与 marker 并投放 `resfile`（含裁剪与 ustar 格式约束）；
- `002-lifecycle`：驱动 `artifact` 阶段并展示失败（`__extractError`）。

**下游（消费本模块）**：

- `007-runtime-host`：宿主要 import 的 `opencode.mjs` 路径；
- `008-server-ui-load`：`OPENCODE_NODE_ASSETS_DIR` 与内嵌 UI 归档的来源；
- `002-lifecycle`：阶段判据与首启耗时记录。
