# 012-data-dirs-sqlite 技术方案（plan）

> 模块：012-data-dirs-sqlite ｜ 对应规格：[spec.md](./spec.md) ｜ Last Updated: 2026-10-11
> 上游基线：opencode `v2.0.26`（`Branch_v2.0.26` / `9b4ec5714d`）｜ 证据口径：✅ 实测 ／ 🔶 沿用 ／ ⬜ 待验证

## 1. 技术上下文

| 项 | 值 | 来源 |
|---|---|---|
| 服务端产生的根 | `@opencode/util/global-roots`：`XDG_DATA_HOME` / `XDG_CACHE_HOME` / `XDG_CONFIG_HOME` / `XDG_STATE_HOME` + `os.tmpdir()` | `docs/工程规划-V2.md` §2.1 ✅（源码核实） |
| 宿主进程 | Electron 37 = Node **22.17.0**；服务端 bundle `dist-node/opencode.mjs` 由宿主 `import` 后跑 `serve` | 同上 §3.4、§3.5 |
| 可写文件系统 | `userData` = `/data/storage/el2/base/files` = **`hmfs`**（如实生效 mode、支持 rename） | dsh 真机 ✅（本工程 ⬜ 复验） |
| 用户目录文件系统 | `/storage/Users/currentUser` = **`hmdfs`**（无 hardlink、应用域无 symlink、`chmod` 静默、默认大小写不敏感、官方 prose 称 rename 仅同目录而实测跨目录亦成功） | dsh 真机 ✅（本工程 ⬜ 复验） |
| `node:sqlite` | 设备上 **无 binding**：`No such binding: sqlite` | 🔶 旧工程 `opencode-harmony` 真机；本工程 ⬜ 复验 |
| 原生构件落点 | 必须 `electron/libs/arm64-v8a/` → `/data/storage/el1/bundle/libs/arm64/`；**不能**从 resfile 解压目录 `dlopen` | 🔶 dsh 0.1.5 上架版本已验证；本工程 ⬜ 复验 |
| `libc++_shared.so` | 取自 DevEco SDK `native/llvm/lib/aarch64-linux-ohos/` | `docs/工程规划-V2.md` §2.4 |

**目录映射（`docs/工程规划-V2.md` §5.3 的落地表）**

| 变量 | 目标 | 理由 |
|---|---|---|
| `HOME` / `USERPROFILE` | `<userData>` | 让「家目录」可写 |
| `XDG_DATA_HOME` | `<userData>/data` | `opencode/opencode.db` 落点 |
| `XDG_CACHE_HOME` | `<userData>/cache` | 缓存（rg 下载目录在本工程被禁用） |
| `XDG_CONFIG_HOME` | `<userData>/config` | 配置目录（含插件发现目录） |
| `XDG_STATE_HOME` | `<userData>/state` | 状态与锁 |
| `TMPDIR` + `os.tmpdir()` patch | `<userData>/tmp` | 真机上环境变量对 Node 无效，必须 patch |
| `OPENCODE_DB`（可选） | `<userData>/data/opencode/opencode.db` | 固定落点，减少根解析依赖 |
| `PATH` | 前置 `/system/bin`、`/data/service/hnp/bin`（如存在）+ 系统默认 | 让 shell 找到 applet |
| v2 能力开关 | `OPENCODE_DISABLE_MODELS_FETCH=1`、`OPENCODE_FILEWATCHER_DISABLE=1`、`OPENCODE_DISABLE_FFF=1`（可选 `OPENCODE_MODELS_PATH`） | 上游已支持，无需补丁 |

**依赖**

| 依赖 | 来源 | 用途 |
|---|---|---|
| `node:os` | Node 22.17.0 内置 | 读取/替换 `homedir()`、`tmpdir()` |
| `node:fs` | 内置 | `mkdir`（幂等）、探针写入回读 |
| `better-sqlite3` v12.4.5（aarch64-ohos / ABI v138） | `../harmonypc-electron-versions` | `#sqlite` 的 `ohos` 变体实现 |
| `libc++_shared.so` | DevEco SDK | 原生构件运行期依赖 |
| 上游 `#sqlite` 变体接口 | `packages/core/src/database/sqlite.node.ts` | 同形接口契约 |

## 2. 关键决策

| # | 决策 | 备选与理由 | 状态 |
|---|---|---|---|
| D1 | 数据根全部落在 `userData`（`hmfs`），用户目录只作为**项目根**（见 011） | 备选「把数据放家目录/用户目录」被否：不可写 + hmdfs 语义缺陷（无 hardlink、chmod 静默） | 已决策 |
| D2 | `TMPDIR` 环境变量**必须**配 `os.tmpdir()` patch | 备选「只设环境变量」被否：真机实测环境变量对 Node 无效 | 已决策 |
| D3 | sqlite 走 `ohos` 条件变体 + better-sqlite3，**不改上游 node 变体** | 备选「改 node 变体直接换实现」被否：破坏补丁幂等与上游可追溯性 | 已决策 |
| D4 | 原生 `.node` 放 `libs/arm64-v8a/`，路径经 env 注入 | 备选「放 resfile 解压目录」被否：真机与 dsh 上架版本均已验证不可 dlopen | 已决策 |
| D5 | 装配后**自检 + 探针**，失败即 fail-visible | 备选「信任装配」被否：权限/路径问题在真机上往往是静默的（`chmod`、EPERM 都是例子） | 已决策 |
| D6 | 数据根与产物解压根**物理分离**（`{data,cache,config,state,tmp}` vs `opencode-dist/`） | 备选「放同一棵树」被否：产物重新解压会波及用户数据 | 已决策 |
| D7 | 目录创建、装配、自检全部**幂等** | 备选「首次安装才做」被否：`hdc uninstall` 后重装、升级路径都要能跑 | 已决策 |

## 3. 数据模型

| 类型 | 字段 | 说明 |
|---|---|---|
| `DataRoots` | `userData` / `data` / `cache` / `config` / `state` / `tmp` | 全部绝对路径；由 `userData` 单点推导 |
| `EnvAssembly` | `vars` / `appliedAt` / `tmpdirPatched` / `order[]` | `order` 记录注入顺序（patch 必须早于 bundle import） |
| `RootSelfCheck` | `checks[]`（`name`/`expected`/`actual`/`ok`）/ `probe{file,readBackMatches,errno}` / `verdict` | 逐项比对 + 一次写入探针 |
| `SqliteBinding` | `absPath` / `exists` / `sizeBytes` / `loadErrorKind ∈ {missing, abi, symbol, unknown}` | 加载前的显式校验 |
| `FsSemanticsProbe` | `hardlink` / `symlink` / `chmodReadBack{requested,actual}` / `caseSensitive` | 设备语义探针（可作 Phase 0/1 诊断用） |
| `DbLocation` | `path` / `fs`（`hmfs`）/ `siblings[]` | 含 `-wal` / `-shm` |
| `ArtifactRoot` | `path`（`<userData>/opencode-dist`）/ `markerPath` | 与数据根分离 |

## 4. 接口契约

### 4.1 环境装配（宿主侧，顺序敏感）

```
1. const userData = app.getPath("userData")            // /data/storage/el2/base/files
2. ensureDirs([data, cache, config, state, tmp])       // 幂等 mkdir -p
3. Object.assign(process.env, {
     HOME:            userData,
     USERPROFILE:     userData,
     XDG_DATA_HOME:   `${userData}/data`,
     XDG_CACHE_HOME:  `${userData}/cache`,
     XDG_CONFIG_HOME: `${userData}/config`,
     XDG_STATE_HOME:  `${userData}/state`,
     TMPDIR:          `${userData}/tmp`,
     OPENCODE_DB:     `${userData}/data/opencode/opencode.db`,   // 可选
     OPENCODE_CONFIG_DIR: `${userData}/config/opencode`,         // 可选
     OPENCODE_DISABLE_MODELS_FETCH: "1",
     OPENCODE_FILEWATCHER_DISABLE:  "1",
     OPENCODE_DISABLE_FFF:          "1",
     PATH: prependPath(["/system/bin", "/data/service/hnp/bin"]),
   })
4. patchOsTmpdir(`${userData}/tmp`)                    // 必须早于 bundle import
5. selfCheck()                                         // 期望值 vs 实际值 + 写入探针
6. log([oc-desktop] 全部根路径 + 自检结论)
7. await import("<dist-node>/opencode.mjs")            // 服务端
```

- `patchOsTmpdir` 的落地形状（`os.tmpdir = () => p` 或对模块命名空间赋值）⬜ 待验证（Node 22 下 `node:os` 命名空间的可写性）。
- 所有 env 只使用 v2 已声明的键（`docs/工程规划-V2.md` §2.1、附录 B）；`OPENCODE_PASSWORD` 由宿主随机生成并注入（密码必填）。

### 4.2 sqlite 变体契约

```
# packages/core/package.json（imports）
"#sqlite": {
  "ohos": "./src/database/sqlite.ohos.ts",
  "node": "./src/database/sqlite.node.ts"
}
```

`sqlite.ohos.ts` 导出与 node 变体同形的实现（`prepare` / `setReadBigInts` / `setReturnArrays` / `loadExtension` / `exec` / `close`），内部：

```
const require = createRequire(import.meta.url)
const abs = process.env.OPENCODE_BETTER_SQLITE3_PATH          // 绝对路径（env 名 ⬜ 待核对）
assertFileExists(abs)                                         // 缺失 → 抛错（响亮）
const Database = require(abs)
```

- **禁止**静默回退 `node:sqlite`。
- 加载失败按 `missing` / `abi` / `symbol` 分类记录（FR-012-017）。

### 4.3 自检契约

```
selfCheck() -> RootSelfCheck
  checks: homedir | tmpdir | xdg_data | xdg_cache | xdg_config | xdg_state | path
  probe : mkdir tmp/<uuid>.probe → write "oc" → read back → unlink
```

任一 `ok === false` 或探针失败 ⇒ `verdict = "fail"`，宿主进入 fail-visible 分支（阶段化 loading 页 + 日志），MUST NOT 继续启动服务端。

## 5. 实现策略

1. **宿主侧单点什么都不猜**：`src-main/runtime-dirs.js` 负责推导、创建、注入、自检；`main.js` 只调用一次并检查 `verdict`。
2. **顺序固定**：目录 → env → `os.tmpdir` patch → 自检 → 日志 → `import` bundle。把顺序写进注释与测试（顺序错了就是「patch 太晚」这一类难查问题）。
3. **补丁 0002（`sqlite-ohos`）**：`packages/core/package.json` 增加 `"ohos"` 条目（1 行）+ 新增 `packages/core/src/database/sqlite.ohos.ts`（1 个新文件，实现同形接口）；追加到补丁列表末尾，跑 `git apply --reverse --check` 与正反向往返 SHA-256 校验（`docs/工程规划-V2.md` §6.2）。
4. **投放链**：`scripts/collect-runtime.mjs` 从 v37 归档 + DevEco SDK 投放 `better_sqlite3.node` 与 `libc++_shared.so` 到 `electron/libs/arm64-v8a/`，并做 `existsSync` + 尺寸 + md5 校验（fail-visible）。
5. **诊断优先**：`FsSemanticsProbe` 在真机首启打印一次（`hardlink` / `symlink` / `chmod` 回读 / 大小写），把平台语义从「文档结论」变成「本机实测值」。
6. **host 侧先行**：装配与自检函数不依赖 Electron（只依赖一个被注入的 `userData` 路径），因此可以在 Windows 上用临时目录跑单元测试与 Node 22.17 门禁。

## 6. 测试与验证

| 层 | 手段 | 覆盖 |
|---|---|---|
| 单元（裸 Node 22.17） | `node:test` + 临时目录模拟 `userData` | 目录幂等创建、env 注入值、`os.tmpdir` patch 生效、自检逐项比对、探针失败分支、data/artifact 根分离、`chmod` 回读校验函数 |
| 静态断言 | `grep` 守卫 | 代码中**无** `link(` / `symlink(` 调用；**无**把数据根指向 `/tmp` 或用户目录的字面量；无 `chmod` 无回读的调用点 |
| host 侧门禁 | `scripts/smoke-node22.mjs`（`docs/工程规划-V2.md` §6.4） | 服务端启动后 `GET /api/info` 200、DB 文件被创建且可复用（第二次启动不重建空库） |
| 真机（Phase 0/1） | 应用域取证（`hdc shell "hilog -x \| grep oc-desktop"`、`--inspect`） | ① 装配自检通过并输出全部绝对路径 ② 会话创建 → 重启应用 → 会话仍在 ③ `better_sqlite3.node` 缺失时的响亮失败 ④ `FsSemanticsProbe` 输出（hardlink `EPERM` / symlink `EACCES` / chmod 回读值 / 大小写） |
| 先决探针 | Phase 0 **P0-1**（宿主形态）与 **P0-3**（host 门禁） | P0-1 决定 patch 注入位置；P0-3 决定产物与 DB 在 Node 22.17 上是否成立 |

**纪律**：设备条目在未执行时保持 ⬜；结论与原始证据写入 `docs/真机验证记录.md`。

## 7. 文件清单

| 路径 | 角色 | 状态 |
|---|---|---|
| `src-main/runtime-dirs.js` | 目录推导 / 幂等创建 / env 注入 / `os.tmpdir` patch / 自检 / 探针 | 计划（Phase 1） |
| `src-main/main.js` | 启动时序中的装配调用点（在 `import` bundle 之前） | 计划 |
| `patches/v2.0.26/0002-sqlite-ohos.patch` | `#sqlite` 的 `"ohos"` 条目 + `sqlite.ohos.ts` | 计划（Phase 0/1） |
| `scripts/collect-runtime.mjs` | 投放 `better_sqlite3.node` 与 `libc++_shared.so` 到 `electron/libs/arm64-v8a/` 并校验 | 计划（见 001/005 模块） |
| `electron/libs/arm64-v8a/better_sqlite3.node` | 原生构件（**不入库**，由脚本投放） | 计划 |
| `specs/012-data-dirs-sqlite/{spec.md,plan.md}` | 本模块规格与方案 | 本次创建 |
| `docs/真机验证记录.md` | 装配 / 持久化 / 语义探针的真机结论落点 | 本次创建 |

## 8. 与规格的交叉引用

| 规格条目 | 本方案落点 |
|---|---|
| FR-012-001 ~ FR-012-009 | §4.1 环境装配（顺序契约）、§1 目录映射表、D1/D2/D5 |
| FR-012-010 ~ FR-012-017 | §4.2 sqlite 变体契约、D3/D4、§5.3 补丁 0002、§5.4 投放链 |
| FR-012-018 ~ FR-012-024 | D1（数据根在 `hmfs`）、§5.5 语义探针、§6 静态断言 |
| FR-012-025 ~ FR-012-028 | D6（数据/产物分离）、§4.3 自检契约、§6 host 门禁与真机用例 |
| 假设 1~8（⬜） | §4.2 env 名、§2 D4、§5.6 host 先行、§6 真机用例、§1 沿用来源 |
| 约束 1~4 | §5.3 补丁纪律、D3、`docs/ACL申请清单.md`（随包原生库免证书） |
