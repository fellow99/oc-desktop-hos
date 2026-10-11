# 数据目录与持久化（012-data-dirs-sqlite）—— 规格

> **Module / Status: Proposed / Last Updated: 2026-10-11 / 上游基线: opencode v2.0.26（Branch_v2.0.26）**
>
> **证据口径**：✅ **实测** ｜🔶 **沿用**（同型工程或既有调研结论，本工程未复现）｜⬜ **待验证**（本工程必须自行实测）。
> **设计依据**：`docs/工程规划-V2.md` §3.6（原生依赖策略）、§5.3（沙箱与目录映射）、§6.3（产物与解压）、§7.1（会话持久化验收）。

## 1. 模块概述

### 1.1 目的

为 opencode v2 服务端在鸿蒙设备上装配一套**可写、稳定、符合 v2 期望**的数据目录体系，并让**持久化真正落盘**：

1. `HOME` / `USERPROFILE` → `userData`（`/data/storage/el2/base/files`，**hmfs**，可写）；
2. `XDG_DATA_HOME` / `XDG_CACHE_HOME` / `XDG_CONFIG_HOME` / `XDG_STATE_HOME` → `userData` 下的 `data` / `cache` / `config` / `state`；
3. `TMPDIR` → `<userData>/tmp`，**并 monkey-patch `os.tmpdir()`**（真机上环境变量对 Node 无效）；
4. 数据库从 `node:sqlite` 切换为 **better-sqlite3**（v2 的 `#sqlite` 条件变体在 `ohos` 下走新实现，补丁 `0002-sqlite-ohos`）；
5. 原生 `.node` MUST 放 `electron/libs/arm64-v8a/`（部署到 `/data/storage/el1/bundle/libs/arm64/`），绝对路径经环境变量传给服务端。

### 1.2 解决的问题

| # | 问题 | 性质 | 若不处理的后果 |
|---|---|---|---|
| 1 | v2 的数据/配置根由 `@opencode/util/global-roots` 决定（`XDG_*` + `os.tmpdir()`） | 上游接口事实 | 不装配就落到不可写位置（家目录、`/tmp`），启动即失败或静默丢数据 |
| 2 | `homedir()` = `/storage/Users/currentUser` **不可写**；`/tmp` 与 `os.tmpdir()` **不可写**，且 `TMPDIR` 环境变量**对 Node 无效** | 平台硬约束（L1） | 临时文件、锁文件、DB 全部写不进去 → 服务端起不来或会话无法持久化 |
| 3 | `node:sqlite` 在设备上**无 binding**（旧工程真机：`No such binding: sqlite`） | 平台硬约束（L1，华为定制 Node） | v2 的 `#sqlite` 变体在设备上直接抛错 → 必须换 better-sqlite3 并保证加载路径正确 |
| 4 | 原生 `.node` **不能**从 `resfile` 解压目录 `dlopen` | 平台硬约束（L2 投放方式） | 走错投放位置会得到「文件在但加载失败」的错觉；正确位置是 HAP 的 `libs/arm64-v8a/` |
| 5 | `hmdfs` 语义：**无 hardlink**（`EPERM`）、`symlink` 应用域 `EACCES`、`chmod` 静默不落实 | 平台硬约束（L1） | 依赖 link 的原子写、symlink 的物化、按 mode 判权限的逻辑全部失效且**不报错** |
| 6 | 数据落点与产物解压目录容易混淆 | 本工程配置（L3） | 若把数据写进解压目录，产物重新解压（marker 命中/升级）会破坏用户数据 |

### 1.3 范围

**包含**：

- 启动期环境装配：`HOME` / `USERPROFILE` / `XDG_*` / `TMPDIR` / `PATH` 与 `os.tmpdir()` patch。
- 装配后自检（期望值 vs 实际值）与 fail-visible 纪律。
- sqlite 变体与 better-sqlite3 的放置、加载路径与失败语义。
- `libc++_shared.so` 的补入要求。
- 落盘语义防御：无 hardlink / 无 symlink / chmod 回读校验 / 大小写不敏感 / 目录幂等创建。
- 数据根与产物根、缓存根的边界；重启后会话持久化的验收。

**不包含**：

- 项目目录选择与授权（见 `specs/011-workspace-auth/`）。
- shell 执行与围栏（见 `specs/010-tool-shell/`）。
- 产物解压机制本身（tar.gz + SHA-256 marker + 流式解压，属 004/005 模块）。
- v2 的迁移路径（`#v1-migration`，上游 node 变体即 `noop`，直接用）。
- 备份 / 导出 / 清理策略（Phase 2+）。

## 2. 用户故事

- 作为**使用者**，我希望重启应用后**会话仍在**，而不是每次都从零开始。
- 作为**使用者**，我希望应用启动失败时能看到「哪一步、哪个路径、什么错误」，而不是白屏。
- 作为**使用者**，我希望应用的数据只落在自己的沙箱里，不污染系统临时目录与我的用户目录。
- 作为**开发者**，我希望「临时目录」在设备上与在桌面上语义一致（`os.tmpdir()` 返回可写目录），这样上游代码不需要到处打补丁。
- 作为**评审者**，我希望数据落点、原生模块落点与失败语义都被固定成可验收条目，而不是散落在实现里。

## 3. 功能需求

> 编号：`FR-012-NNN`（`docs/工程规划-V2.md` §9.1）。

### 3.1 环境装配与自检

| 编号 | 需求 | 强度 | 来源 / 状态 |
|---|---|---|---|
| FR-012-001 | 宿主 MUST 在启动服务端**之前**设 `HOME` 与 `USERPROFILE` = `userData`（`/data/storage/el2/base/files`） | MUST | `docs/工程规划-V2.md` §5.3；🔶 旧工程实测 `homedir()` 不可写，本工程 ⬜ 复验 |
| FR-012-002 | 宿主 MUST 设 `XDG_DATA_HOME` / `XDG_CACHE_HOME` / `XDG_CONFIG_HOME` / `XDG_STATE_HOME` = `<userData>/{data,cache,config,state}`（v2 `global-roots` 的期望根） | MUST | 同上 §2.1、§5.3；⬜ v2 根解析细节核对 |
| FR-012-003 | 宿主 MUST 设 `TMPDIR` = `<userData>/tmp`，**并 MUST 在宿主内 monkey-patch `os.tmpdir()`** 返回该路径 | MUST | 🔶 旧工程真机（`TMPDIR` 对 Node 无效、`os.tmpdir()` 不可写）；`docs/工程规划-V2.md` §5.3；本工程 ⬜ 复验 |
| FR-012-004 | patch MUST 在服务端 bundle `import` **之前**生效；MUST 覆盖 `os.tmpdir`（含 `node:os` 与 `node:os/promises` 等入口的同一默认导出） | MUST | 设计决策；⬜ 生效范围本工程验证 `docs/工程规划-V2.md` §5.3） |
| FR-012-005 | 装配后 MUST 自检：`os.homedir()`、`os.tmpdir()`、四个 XDG 变量、`PATH` 的**实际值**与期望值逐项比对，并做一次临时文件写入 + 回读 + 删除探针；任一不符 MUST 进入 fail-visible 分支（阶段化 loading 页 + `[oc-desktop]` 日志） | MUST | `docs/工程规划-V2.md` §5.2；⬜ 本工程复验 |
| FR-012-006 | 数据根 MUST NOT 落在 `/tmp`、`/storage/Users/currentUser`、`resfile` 只读区或产物解压目录内 | MUST | 同上 §5.3、§6.3；⬜ 本工程复验 |
| FR-012-007 | 宿主 MAY 显式设 `OPENCODE_DB`（`<XDG_DATA_HOME>/opencode/opencode.db`）与 `OPENCODE_CONFIG_DIR`（`<XDG_CONFIG_HOME>/opencode`），以固定落点、减少对根解析的依赖 | MAY | 同上 §5.3、附录 B；⬜ 与上游 env 契约核对 |
| FR-012-008 | `PATH` MUST 装配为「前置可用工具目录（`/system/bin`、`/data/service/hnp/bin` 等）+ 系统默认」；MUST NOT 依赖 `/usr/local/bin` / `/usr/bin` / `/data/app/bin` 存在 | MUST | 同上 §5.3（dsh 真机：这三个目录不存在）；⬜ 本工程复验 |
| FR-012-009 | 装配结果（含每个根的绝对路径与自检结论）MUST 写入 `[oc-desktop]` 日志，供 `hdc shell "hilog -x \| grep oc-desktop"` 取证 | MUST | 同上 §6.4；⬜ 本工程复验 |

### 3.2 sqlite 变体与原生模块放置

| 编号 | 需求 | 强度 | 来源 / 状态 |
|---|---|---|---|
| FR-012-010 | 数据库实现 MUST 走 `ohos` 条件变体的 better-sqlite3（补丁 `0002-sqlite-ohos`：`packages/core/package.json` 的 `#sqlite` 增加 `"ohos"` 条目 + 新增 `sqlite.ohos.ts`），MUST NOT 改动上游 `node` 变体 | MUST | `docs/工程规划-V2.md` §3.6、§6.2；⬜ 本工程落地核对 |
| FR-012-011 | 变体接口 MUST 与上游 node 变体**同形**：`prepare` / `setReadBigInts` / `setReturnArrays` / `loadExtension` / `exec` / `close`（同名、同调用语义、同同步性） | MUST | 同上 §6.2（补丁 0002 契约）；⬜ 与上游实际接口逐项核对 |
| FR-012-012 | better-sqlite3 的原生构件 MUST 放 `electron/libs/arm64-v8a/better_sqlite3.node`（部署为 `/data/storage/el1/bundle/libs/arm64/…`）；MUST NOT 依赖从 `resfile` 解压目录 `dlopen` | MUST | 🔶 dsh 0.1.5 上架版本已验证（`.node` 必须放 `libs/arm64-v8a/`）；同上 §3.6；本工程 ⬜ 复验 |
| FR-012-013 | 该 `.node` 的**绝对路径** MUST 经环境变量传给服务端（本规格写作 `OPENCODE_BETTER_SQLITE3_PATH`，env 名 ⬜ 待与上游/补丁契约核对）；路径 MUST 在加载前经 `existsSync` + 尺寸校验，缺失即**响亮失败**，MUST NOT 静默回退 `node:sqlite` | MUST | 同上 §3.6（「通过 env 拿到该绝对路径 ⬜ 实现细节」）；⬜ 本工程复验 |
| FR-012-014 | `libc++_shared.so` MUST 从 DevEco SDK 的 `native/llvm/lib/aarch64-linux-ohos/` 补入并随包投放（与运行时的其它 SO 同目录语义） | MUST | 同上 §2.4、§3.6；⬜ 本工程复验 |
| FR-012-015 | DB 文件 MUST 落在 `<XDG_DATA_HOME>/opencode/opencode.db`（或 FR-012-007 的显式值），且 MUST 跨越应用重启保持；会话持久化（`docs/工程规划-V2.md` §7.1 第 4 条）即为本项的验收 | MUST | 同上 §5.3、§7.1；⬜ 本工程复验 |
| FR-012-016 | sqlite 的全部写路径 MUST 位于 `hmfs`（`userData`）内；MUST NOT 把 DB / journal / WAL 放在 `hmdfs`（用户目录）上 | MUST | dsh 真机（`/data/storage/el2/base/files` = `hmfs`；用户目录 = `hmdfs`，无 hardlink、`chmod` 静默）；⬜ 本工程复验 |
| FR-012-017 | 加载失败 MUST 区分「文件缺失」「ABI/架构不匹配」「符号缺失」三类原因并分别记录，便于定位是投放问题还是 ABI 问题 | SHOULD | 设计决策 |

### 3.3 文件系统语义防御（hmfs / hmdfs）

| 编号 | 需求 | 强度 | 来源 / 状态 |
|---|---|---|---|
| FR-012-018 | 原子写 MUST 只走 `rename`；MUST NOT 依赖 `link` / `linkSync`（hmdfs 无 `.link` 处理器 → `EPERM`；hmfs 亦不作为保证） | MUST | ✅ dsh 真机（hmdfs 无 hardlink）；`docs/工程规划-V2.md` §7.3；⬜ 本工程复验 |
| FR-012-019 | MUST NOT 依赖创建 `symlink`（应用域 `EACCES`）；需要「链接」语义时一律 **copy 物化** | MUST | ✅ dsh 真机 + 🔶 旧工程（symlink `EACCES`）；⬜ 本工程复验 |
| FR-012-020 | 任何 `chmod` MUST 写入后**回读校验**；回读值与请求值不一致时 MUST 报显式错误（`FS_IO_ERROR` 类），MUST NOT 视作成功 | MUST | ✅ dsh 真机（`hmdfs`：请求 `600/644/640` 回读恒 `660`，请求 `755` 回读 `770`；`hmfs` 如实生效）；⬜ 本工程复验 |
| FR-012-021 | 路径处理 MUST 视文件系统为**大小写不敏感**（`hmdfs` 默认行为）：不得存在仅靠大小写区分的两个数据路径；临时文件名 SHOULD 带随机成分 | MUST | ✅ dsh 真机（`hmdfs` 默认大小写不敏感）+ 同型工程实践；⬜ 本工程复验 |
| FR-012-022 | 目录创建 MUST 幂等（`mkdir -p` 语义）且 MUST 容忍「已存在」；并发启动/重复启动 MUST NOT 报错 | MUST | 设计决策 |
| FR-012-023 | 数据根内的文件数 MUST 保持在合理量级：产物与小文件走 tar.gz 一次性解压，**数据目录不得成为数万小文件的投放区** | SHOULD | `docs/工程规划-V2.md` §6.3（数万小文件入 HAP 不可行）；⬜ 本工程实测规模 |
| FR-012-024 | 缓存目录（`<XDG_CACHE_HOME>`）MAY 被清理；数据目录与状态目录（`<XDG_DATA_HOME>` / `<XDG_STATE_HOME>`）MUST NOT 被清理逻辑删除 | MAY/MUST | 设计决策（v2 `Flock` 依赖 state 目录） |

### 3.4 生命周期与边界

| 编号 | 需求 | 强度 | 来源 / 状态 |
|---|---|---|---|
| FR-012-025 | 数据根 MUST 与产物解压根分离：产物解压到 `<userData>/opencode-dist/`（由 marker 管理），数据在 `<userData>/{data,cache,config,state,tmp}`；两者 MUST NOT 互相包含 | MUST | `docs/工程规划-V2.md` §6.3、§5.3；⬜ 本工程复验 |
| FR-012-026 | 应用卸载/重装 MUST 被当作「数据全清」处理：不得在实现里假设跨安装残留 | MUST | 设计决策（与 §8.4 授权卸载清空同口径） |
| FR-012-027 | 首次启动的目录创建与 DB 初始化 MUST 可重复执行且不破坏已有数据（幂等） | MUST | 设计决策 |
| FR-012-028 | 装配与自检的失败 MUST NOT 被吞掉：任一项失败 MUST 在 loading 页显示具体阶段与路径，并写 `globalThis.__extractError` / `globalThis.__hostError` 类的诊断落点 | MUST | `docs/工程规划-V2.md` §5.2；⬜ 本工程复验 |

## 4. 关键实体

| 实体 | 说明 | 关键属性 |
|---|---|---|
| `DataRoots` | 数据根集合 | `userData`、`data`、`cache`、`config`、`state`、`tmp`（全部绝对路径） |
| `EnvAssembly` | 一次环境装配的结果 | `vars`（`HOME`/`USERPROFILE`/`XDG_*`/`TMPDIR`/`PATH`）、`appliedAt`、`tmpdirPatched` |
| `RootSelfCheck` | 自检结果 | `checks[]`（`name` / `expected` / `actual` / `ok`）、`probe`（写入回读探针）、`verdict` |
| `SqliteBinding` | sqlite 原生构件 | `absPath`（`libs/arm64-v8a/better_sqlite3.node`）、`exists`、`sizeBytes`、`loadErrorKind` |
| `FsSemanticsProbe` | 设备文件系统语义探针结果 | `hardlink`（`ok`/`EPERM`）、`symlink`（`ok`/`EACCES`）、`chmodReadBack`（请求值 → 回读值）、`caseSensitive` |
| `DbLocation` | 数据库落点 | `path`、`fs`（`hmfs`/`hmdfs`）、`siblingFiles`（`-wal` / `-shm`） |
| `ArtifactRoot` | 产物解压根（与数据根分离） | `path`（`<userData>/opencode-dist`）、`markerPath` |

## 5. 验收场景

### 场景 1：首次启动装配通过

- **Given** 全新安装（userData 为空）
- **When** 应用启动并完成环境装配
- **Then** 四个 XDG 目录与 `tmp` 被创建；`os.homedir()` = `userData`；`os.tmpdir()` = `<userData>/tmp`；写入回读探针通过；日志含全部绝对路径

### 场景 2：临时目录 patch 生效

- **Given** 装配已完成
- **When** 服务端内任意代码调用 `os.tmpdir()`
- **Then** 返回 `<userData>/tmp`，且该目录可写；MUST NOT 返回 `/tmp`

### 场景 3：会话持久化（重启后仍在）

- **Given** 已创建会话与消息
- **When** 应用退出后重新启动
- **Then** 会话列表与内容仍在（DB 位于 `<XDG_DATA_HOME>/opencode/opencode.db`）

### 场景 4：sqlite 构件缺失（响亮失败）

- **Given** `electron/libs/arm64-v8a/better_sqlite3.node` 未投放
- **When** 服务端加载 sqlite 变体
- **Then** 启动失败并明确报告「构件缺失 + 期望绝对路径」；MUST NOT 静默回退 `node:sqlite`

### 场景 5：hmdfs 上的 chmod 回读不一致

- **Given** 目标文件位于用户目录（`hmdfs`）
- **When** 代码请求 `chmod 640`
- **Then** 回读得到 `660` → 报告错误而非成功（`hmfs` 上同样请求应如实回读）

### 场景 6：原子写不依赖 hardlink

- **Given** 目标目录位于 `hmdfs`
- **When** 执行一次原子覆盖写
- **Then** 走「写临时文件 + `rename`」路径成功；MUST NOT 出现 `link` 调用

### 场景 7：数据与产物不互相破坏

- **Given** 已有用户数据与会话
- **When** 产物重新投放（marker 变化触发重新解压）
- **Then** 数据目录内容不受影响；反之清空数据目录也不影响产物解压结果

## 6. 非功能需求

- **失败可见**：装配、自检、sqlite 加载、目录创建四类事件 MUST 有阶段化输出；禁止「卡住但不说」。
- **启动开销**：目录创建与自检 SHOULD 在秒级完成；自检只做一次写入探针，不做全盘遍历。
- **数据安全**：数据根 MUST 位于应用沙箱内；MUST NOT 写入用户目录、系统临时目录或 `resfile`。
- **可移植性**：装配逻辑 MUST 集中于**宿主侧单点**（`src-main/`），MUST NOT 在上游 bundle 内散落路径补丁。
- **可测试性**：装配与自检 SHOULD 在 host 侧 Node 22.17 上可被单元测试直接驱动（用临时目录模拟 `userData`）。
- **可诊断**：每个根路径与每次自检结论 MUST 出现在 `[oc-desktop]` 日志中（含失败原因与 errno）。

## 7. 假设与约束

**假设（逐条待验证）**

- ⬜ **待验证** 1：`OPENCODE_BETTER_SQLITE3_PATH` 这一 env 名与加载方式需在补丁 `0002` 落地时与上游 `#sqlite` 变体接口对齐；若上游未预留 env 形态，则改为固定相对路径解析（`app.getAppPath()` 或 `libs/arm64-v8a/` 相对 HAP 的解析），并回写本节。
- ⬜ **待验证** 2：better-sqlite3 v12.4.5 的 `aarch64-ohos` / ABI **v138** 预编译产物可直接使用（否则需按框架 headers + `libshim.a` 重编，参数见 `docs/工程规划-V2.md` §2.4）。
- ⬜ **待验证** 3：`os.tmpdir()` patch 的**生效范围** —— 是否存在在模块加载期缓存 `tmpdir()` 结果的依赖（若存在，需在装配顺序上先 patch 后 import，或补打点）。
- ⬜ **待验证** 4：`XDG_*` 四个根是否被 v2 的 `global-roots` 全部消费（`XDG_STATE_HOME` 与 `Flock` 的关系需核对上游实现）。
- ⬜ **待验证** 5：better-sqlite3 在 `hmfs` 上的 `-wal` / `-shm` 与 rename 语义是否完全正常（需真机写入-重启-回读实测）。
- ⬜ **待验证** 6：首启 DB 创建耗时、DB 体积增长（写入 `docs/真机验证记录.md`）。
- ⬜ **待验证** 7：`/data/service/hnp/bin` 是否在本工程设备上存在且可执行（`PATH` 装配的候选目录之一）。
- 🔶 **沿用** 8：旧工程 `opencode-harmony` 的真机结论 —— `node:sqlite` **FAIL（`No such binding: sqlite`）**、`/tmp` 与 `os.tmpdir()` 不可写且 `TMPDIR` 无效、`homedir()` 不可写、可用命令仅 toybox 与第三方 `node`/`npm`/`python3`；本工程必须逐条复验。

**约束**

- 约束 1：**应用域是唯一可信观测点**（同 `specs/011-workspace-auth/` 约束 4）。
- 约束 2：**不改动上游 `node` 变体**：所有偏离都放在 `ohos` 条件变体与宿主装配里。
- 约束 3：**不随包执行自有 ELF**：本模块只投放 `.node` 原生库（随包原生库，不需要二进制证书），MUST NOT 引入需要证书的可执行文件。
- 约束 4：**补丁纪律**：补丁 `0002` 必须幂等、可往返、不与既有补丁上下文重叠（`docs/工程规划-V2.md` §6.2 六条硬规则）。

## 8. 依赖

**上游（opencode v2.0.26）**

- `packages/util/src/global-roots.ts`、`packages/util/src/global.ts` —— 数据/缓存/配置/状态根的解析（`XDG_*` + `os.tmpdir()`）。
- `packages/core/package.json` 的 `imports` 条件变体表 + `packages/core/src/database/{sqlite.node.ts,database.ts}` —— `#sqlite` 变体的接口形状。
- `packages/cli/src/server-process.ts` —— env 契约（`OPENCODE_DB` / `OPENCODE_CONFIG_DIR` / `OPENCODE_CONFIG…`）。
- `packages/server/src/options.ts` 的 `ServerOptions.database{path}` —— 显式 DB 路径注入点（⬜ 字段核对）。

**本工程其它模块**

- `specs/010-tool-shell/` —— 消费 `<userData>/tmp` 作为路径围栏的第二个允许根。
- `specs/011-workspace-auth/` —— 提供项目根（数据落点之外的唯一用户可见目录）。
- `specs/007-runtime-entry/`（另建）—— 宿主形态决定 patch 注入点（主进程进程内 / utility / worker）。
- `docs/鸿蒙环境能力清单.md`、`docs/真机验证记录.md` —— 能力边界与真机复验结论落点。
- `docs/ACL申请清单.md` —— 「随包原生库不需要二进制证书」这一判定的引用来源。
