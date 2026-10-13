# patches/v2.0.26 —— opencode v2.0.26 上游补丁（4 条）

本目录是**上游补丁**（不是本工程的构建脚本）。补丁只做「新增文件 + 开关式少量改动」，由
`scripts/build-opencode.mjs` 阶段 ① 幂等应用到 `../opencode`，再由阶段 ③ 构建产物。
契约见 `docs/工程规划-V2.md` §3.5 / §3.6 / §6.2 / §7.4。

## 基线（改动与验证的唯一基准）

| 项 | 值 |
|---|---|
| 仓库 | `../opencode`（上游，submodule） |
| tag | **v2.0.26** |
| 提交 | **9b4ec5714d**（`release: v2.0.26`），分支 `Branch_v2.0.26` |
| 补丁头路径 | `a/packages/...` → `b/packages/...`（`git apply` 默认 `-p1`） |

换基线必须**新建** `patches/<新 tag>/` 目录重生成补丁，本目录只对 v2.0.26 成立
（`scripts/build-opencode.mjs` 的 `EXPECTED_BASELINE=9b4ec5714d` 会前置校验）。

## 补丁清单

| 编号 | 落点文件 | 作用 |
|---|---|---|
| `0001-node-target-ohos.patch` | `packages/cli/vite.node.config.ts`（2 行改） | ① `build.target` 由硬编码 `"node26"` 改为 `process.env.OPENCODE_NODE_TARGET ?? "node26"`（本工程构建时设 `node22`，对齐 Electron 37 内置 Node 22.17.0）；② `resolve.conditions` 由 `["node"]` 改为 `["ohos", "node"]`，让 `ohos` 条件变体优先解析。仅此两处，无其它行为变化。 |
| `0002-sqlite-ohos.patch` | `packages/core/package.json`（`#sqlite` 增 1 行）+ 新文件 `packages/core/src/database/sqlite.ohos.ts`（294 行） | 真机 `node:sqlite` **无 binding**（`No such binding: sqlite`）。ohos 变体实现与 `sqlite.node.ts` 同形接口（`supportsTuningPragmas` / `supportsForeignKeyToggle` / `sqliteLayer`），两级加载后端：① `require(OPENCODE_BETTER_SQLITE3_PATH ?? "better-sqlite3")`（设备侧，`.node` 由 `electron/libs/arm64-v8a/` 投放，不能从 resfile dlopen）；② 失败回落 `node:sqlite` 的 `DatabaseSync`（**仅 host 侧**，Node 22.17 冒烟门禁用）；两级都失败时错误里同时给出两条路径与原因。better-sqlite3 API 映射：`safeIntegers`↔`setReadBigInts`、`raw(true)`↔`setReturnArrays`、`new Database(filename,{readonly,timeout,fileMustExist})`、`exec/loadExtension/pragma/close`。`disableWAL !== true && readonly !== true` 时 `PRAGMA journal_mode = WAL`。**语义对齐（2026-10-12 真机实测新增）**：better-sqlite3 的 `Statement#all()` 对「不返回数据」的语句抛 `This statement does not return data. Use run() instead`，而 `node:sqlite` 返回 `[]` —— 若不对齐，服务端启动的 `PRAGMA synchronous = NORMAL` 会直接失败（真机表现为 `cli process failed`）。因此 `all()` 先按 `reader === false` 走 `run()` 并返回 `[]`，再以错误信息兜底（aarch64-ohos / ABI v138 的构建**未**暴露可用的 `reader` 标志，故不能只依赖该属性）。 |
| `0003-runtime-stubs-ohos.patch` | `packages/core/package.json`（`#pty`、`#persistent-pty-binary` 各增 1 行）+ 新文件 `packages/core/src/pty/pty.ohos.ts`（34 行）、`packages/core/src/persistent-pty/binary.ohos.ts`（22 行） | **必需**：`pty.node.ts` 在**模块顶层**执行 `createRequire(import.meta.url)(OPENCODE_NODE_PTY_PATH ?? "@lydell/node-pty")`，glibc `.node` 加载失败会**中断整个 bundle 的 import**（`pty.ts` 经 `lazy(() => import("#pty"))` 把它拉进模块图）。打桩后由「启动即崩」降级为「终端不可用」：两个 stub 均 `available = false`、调用即抛错，错误说明设备侧 PTY 平台级不可用（SELinux 拒 `forkpty/openpty/popen`）、`opencode-pty` 无 ohos 构件且沙箱禁执行自带 ELF。 |
| `0004-tui-zed-sqlite-ohos.patch` | `packages/tui/package.json`（`#zed-sqlite` 增 1 行）+ 新文件 `packages/tui/src/editor-zed-sqlite.ohos.ts`（54 行） | **必需**：`#zed-sqlite` 原先只有 `bun` / `node` / `default` 三个条件，在 `conditions: ["ohos", "node"]`（0001）下落到 `node` 变体，而该变体**静态** `import "node:sqlite"` ⇒ 模块加载期即抛 `No such binding: sqlite`，整个 CLI 产物无法启动（服务端宿主无输出、应用白屏）。ohos 变体改用 better-sqlite3（与 0002 同一策略与同一 `.node`），接口只暴露 `all` / `get`。 |

以下为**尚未立项**的候选（按 §6.2 追加到列表末尾即可，编号单调递增）：`0005-search-ohos`（`#fff` 纯 JS 走查）、
`0006-plugin-gate`（插件闸门）、`0007-branding`（若品牌化改为上游补丁而非产物级替换）。本目录当前为 4 条。

## 生成命令（可复现）

```bash
# 1) 独立 worktree（.cache/ 已 gitignore），绝不改主工作树
cd ../opencode
git worktree add ../oc-desktop-hos/.cache/patch-wt --detach 9b4ec5714d

# 2) 在 worktree 内改文件；新增文件先登记 intent-to-add，才能进 diff
cd ../oc-desktop-hos/.cache/patch-wt
git add -N packages/core/src/database/sqlite.ohos.ts

# 3) 每条补丁单独导出（分文件，保证只含自己的改动）
git diff -- packages/cli/vite.node.config.ts > ../patches/v2.0.26/0001-node-target-ohos.patch

# 4) 清理
cd ../opencode && git worktree remove --force ../oc-desktop-hos/.cache/patch-wt && git worktree prune
```

**注意（0002 与 0003 都改 `packages/core/package.json`）**：为了让两条补丁各自只含自己的
`package.json` 改动，生成时按「先 0002 后 0003」递进，并在两者之间把 `package.json`
暂存到索引（`git add packages/core/package.json`），使 0003 取「索引 ↔ 工作区」的增量 diff：
`0002` 用 `git diff -- packages/core/package.json packages/core/src/database/sqlite.ohos.ts`，
`0003` 用 `git diff -- packages/core/package.json packages/core/src/pty/pty.ohos.ts packages/core/src/persistent-pty/binary.ohos.ts`。
若两条补丁都带上完整 `package.json` diff，则先应用者会让后应用者的 hunk 失败。

## 校验（每次改动补丁后必须全做）

```bash
# 干净基线 + 幂等判据（build-opencode.mjs 阶段 ① 的判据）
git apply --check <补丁>                 # 未应用：必须成功
git apply --reverse --check <补丁>       # 已应用：必须成功 ⇒ 跳过（幂等）
# 往返（逐条：apply → reverse-check → reverse 后工作区必须与基线逐字节一致）
git apply <补丁> && git apply --reverse --check <补丁> && git apply --reverse <补丁>
git status --porcelain                   # 必须为空（含 -uall）
```

本目录 4 条补丁在 9b4ec5714d 上的实际校验结果（**2026-10-13 复核并重跑**）：

| 校验项 | 方法 | 结果 |
|---|---|---|
| 已应用判据（幂等） | 逐条 `git -C ../opencode apply --reverse --check` | 4/4 **成功** ⇒ 主工作树当前为「已应用」态，`build-opencode.mjs` 阶段 ① 会全部跳过 |
| 正向未应用判据 | 逐条 `git -C ../opencode apply --check` | 4/4 失败（预期：已应用） |
| 干净基线按序应用 | `git worktree add --detach 9b4ec5714d` 后按 `0001→0002→0003→0004` 依次 `git apply` | 4/4 **干净应用**，无 fuzz、无 `--3way` |
| 应用结果一致性 | 补丁应用后的 7 个落点文件 vs 主工作树对应文件 | 6/7 **逐字节一致**；`packages/tui/src/editor-zed-sqlite.ohos.ts` 因 `core.autocrlf=true` 的 CRLF/LF 落地差异在 `diff -q` 下报差异，**规范化行尾后逐字节一致**（见下方「其它约定」的行尾条） |
| 往返 | `git apply` → `git apply --reverse --check` → `git apply --reverse` | 通过；反向应用后工作区回到基线 |

历史记录（3 条版本，2026-10-11）：逐条 `--check` 通过、往返后工作区为空、blob 哈希一致、
对真实上游主工作树做只读 `git apply --check` 亦全部通过。

## 补丁硬规则（`docs/工程规划-V2.md` §6.2）

1. **幂等**：应用前先 `git apply --reverse --check`，成功即视为已应用 → 跳过；
2. **冲突即终止**：绝不 `--3way` 强行合并，绝不覆盖 `../opencode` 中的用户改动；
3. **不带镜像噪声**：`bun.lock` 等由 `bun install` 重新生成，不进补丁；
4. **按上游 tag 组织**：`patches/v2.0.26/`；上游升级时新建目录，旧目录保留可追溯；
5. **不得落在既有补丁的连续上下文区间**（前后各 3 行），新补丁一律追加到列表末尾；
6. **可往返**：正向应用 → 反向应用后源码 SHA-256 必须还原。

## 其它约定

- **补丁只在 worktree 内生成**（`git worktree add … --detach <基线>`），主工作树
  `../opencode` 保持干净（`git status --porcelain` 为空），不使用 `git checkout --`/`git clean`/`git stash` 动主树。
- 构建期环境变量（由构建流水线传入，补丁本身不设默认值）：
  `OPENCODE_NODE_TARGET=node22`（0001）、`OPENCODE_BETTER_SQLITE3_PATH=<.node 绝对路径>`（0002，设备侧必须；host 侧冒烟可留空以走 `node:sqlite` 回落）。
- 行尾：上游 checkout 为 `core.autocrlf=true`（工作区 CRLF，仓库内 LF）。补丁内容按 LF 生成；
  `git apply` 会按仓库设置落地，新增文件在 CRLF 工作区表现为 CRLF，但 blob 内容与补丁一致（回合校验以 `git apply` 结果为准）。
- `ohos` 条件条目放在各变体条件对象内、`node`/`default` 之前（本目录放在 `workerd` 之后），
  与 0001 的 `resolve.conditions: ["ohos", "node"]` 配合——条件对象按键顺序取首个命中项。
