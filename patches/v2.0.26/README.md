# patches/v2.0.26 —— opencode v2.0.26 上游补丁（8 条）

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
| `0005-string-width-ohos.patch` | `packages/tui/package.json`（`#string-width` 增 1 行）+ 新文件 `packages/tui/src/util/string-width.ohos.ts`（28 行） | **当时判定为必需（2026-10-13）；2026-10-14 复盘：根因误判，已登记为可回收**。`#string-width` 原先只有 `bun` / `node` / `default`，在 `conditions: ["ohos", "node"]` 下落到 `node` 变体，而该变体在**模块顶层**构造 `new RegExp("^\p{Emoji}\p{Mark}*$", "u")` 与 `new RegExp("^\p{Emoji_Presentation}", "u")`；当时设备上运行期抛 `Invalid regular expression: ... Invalid property name` ⇒ 服务端 import 即失败、应用白屏（现场见 `logs/20261013-1/INCIDENT` 与 `ocr-trace.log` 的 `[启动服务端宿主] FAIL`）。**该现象的真实根因不是设备 ICU 能力缺失，而是 `web_engine/src/main/resources/resfile/icudtl.dat` 被 CRLF 归一化损坏了 51 字节**（详见 `docs/鸿蒙环境能力清单-v2.0.26.md` §10.2 / §10.4）；`icudtl.dat` 修复后真机实测 `\p{Emoji}` / `\p{Emoji_Presentation}` / `\p{Emoji_Component}` / `\p{Extended_Pictographic}` 全部可用，本补丁**因此不再必要**。回收需重跑 `build-opencode` 并复核品牌化断言，登记为后续项；当前保留不影响运行（差异只影响 TUI 文本对齐，本工程设备上无终端，`#pty` 已由 0003 打桩）。 |
| `0006-shell-select-ohos.patch` | `packages/core/src/shell/select.ts`（2 处改，`git apply --numstat` = **+13 / −1**） | **必需（2026-10-14 真机定位）**：① `stat()`（`statSync(file, { throwIfNoEntry: false })`）在 OpenHarmony 应用域内对**系统路径**（如 `/bin/sh`、`/system/bin/sh`）抛 `EACCES: permission denied` 而**不是** `ENOENT`，`throwIfNoEntry` 只兜 `ENOENT` ⇒ 异常冒泡到 `select → executable → environment`；② `fallback()` 增认 `OC_SHELL_FALLBACK`。故障现象极具迷惑性：opencode 在**每次模型请求前**都会解析 shell（`SessionModelRequest.prepare → environment()`），因此会话建得出、用户消息能进库、SSE 也连得上，**但助手永远不回复**，服务端日志只有 `ERROR "Failed to drain Session" cause="EACCES: permission denied, stat '/bin/sh'"`，UI 侧表现为消息列表里冒出 `{type:"idle",outcome:"failed"}`。修法把「不可读」与「不存在」一视同仁（都当作「该 shell 不可用」，交给 `fallback()`），并让壳侧通过 `OC_SHELL_FALLBACK=/system/bin/sh`（`src-main/main.js` 的 `configureEnvironment`，可用 `OCR_SHELL` 覆盖）注入设备上真正可执行的 shell。 |
| `0007-workspace-roots-picker.patch` | 新文件 `packages/app/src/workspaces/selection/roots.ts`（270 行）、`roots.test.ts`（210 行）；改 `packages/app/src/workspaces/selection/dialog.tsx`（**+190**）、`packages/app/src/runtime/i18n/en.ts`（**+18**）、`zh.ts`（**+18**） | **需求 203（`specs/203-plugin-workspace-picker`）**：把「选择工作区目录」对话框升级为**四个主目录**（沙箱 / 桌面 / 文档 / 下载）。① `roots.ts` 承载纯函数（根围栏 `isWithin`、根识别 `rootOf`、裁剪 `clampToRoot`、默认名去重 `defaultFolderName`、面包屑 `crumbSegments`、隐藏项过滤 `filterHiddenEntries`、主目录记忆读写）与壳侧能力 RPC 的调用封装；② `dialog.tsx` 在**能力 RPC 可用时**渲染四主目录 Tab、把浏览域锁在主目录内（`navigate` / `load` / `resolve` 三处独立判定）、移除手动路径输入、新增「新建文件夹」内联表单，并在主目录不可用或列举被拒时就地给出原因与「请求授权 / 去系统设置 / 重试」；③ **自门控**：RPC 不可达（非本壳部署 / 插件未激活）时 `roots.latest` 恒为 `undefined` ⇒ 全部 203 分支关闭，对话框**回退上游行为**，不出现半残状态。能力侧**不在本补丁内**，由壳专用插件 `plugins/oc-plugin-workspace-roots` 经 `POST /api/rpc/:rpcID/:method`（上游既有端点，**零 codegen**）提供；目录数据仍走既有 `fs/list`。 |
| `0008-git-credentials-settings.patch` | 新文件 `packages/app/src/settings/git/{credentials.ts,git.tsx,git.css}`；改 `packages/app/src/settings/{route.ts,pages.ts,shell.tsx}`、`packages/app/src/runtime/i18n/en.ts`、`zh.ts` | **需求 204（`specs/204-plugin-git`）**：新增「设置 → Git」凭据页。① `credentials.ts` 承载 RPC 封装（`credentials.describe` / `list` / `save` / `remove`，`rpcID = oc-harmony-git`）、输出形状归一化与表单校验；② `git.tsx` 渲染凭据文件路径、协议/主机/用户名/口令表单与条目列表，口令输入 `type="password"` 且**保存后只显示长度**；③ **自门控**：`credentials.describe` 不可达（非本壳部署 / 插件未加载）时该 Tab 不出现在导航里，路由若停在 `git` 会被重定向回 `general`；探测在 server sdk 就绪后执行（`createEffect` 而非 `onMount`——服务器清单是异步加载的，`onMount` 时 sdk 往往还不存在，会把「服务还没就绪」误判成「不是本壳」并 latch 住）。能力侧由壳专用插件 `plugins/oc-plugin-git` 提供；git 数据不经本补丁。 |

以下为**尚未立项**的候选（按 §6.2 追加到列表末尾即可，编号单调递增）：`0008-search-ohos`（`#fff` 纯 JS 走查）、
`0009-search-ohos`（`#fff` 纯 JS 走查）、`0010-plugin-gate`（插件闸门）、`0011-branding`（若品牌化改为产物级替换而非上游补丁）。本目录当前为 8 条。

> 编号顺延说明：原计划的候选 `0007-search-ohos` 起，编号让位给已立项的需求 203 补丁（本行下述 `0007`），
> 后续候选一律从 `0008` 起，不回填、不复用（`docs/工程规划-V2.md` §6.2 编号单调递增）。

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

本目录补丁在 9b4ec5714d 上的实际校验结果。下面前五行是 **6 条版本（加入 `0006` 后，2026-10-14）** 的复核结果；
`0007`（需求 203）的校验单列于表末四行，**未重跑全量按序应用**（该口径仍以 6 条版本的记录为准）：

| 校验项 | 方法 | 结果 |
|---|---|---|
| 已应用判据（幂等） | 逐条 `git -C ../opencode apply --reverse --check` | 加入 `0006` 前 **5/6 成功**（`0001`–`0005`；`0006` 未应用）⇒ `build-opencode.mjs` 阶段 ① 对前五条跳过、只应用 `0006`；`build-opencode` 跑完后 **6/6 成功** |
| 正向未应用判据 | 逐条 `git -C ../opencode apply --check` | 与该判据互补：`0001`–`0005` 失败、`0006` 成功（预期） |
| 干净基线按序应用 | `git worktree add --detach 9b4ec5714d` 后按 `0001→0002→…→0006` 依次 `git apply` | **6/6 干净应用**，无 fuzz、无 `--3way`；工作区 `git status --porcelain -uall` 恰为 **9 个落点文件**（4 个已跟踪文件被改 + 5 个新增文件） |
| 应用结果一致性 | 干净基线应用后的 9 个落点文件 vs 主工作树（`build-opencode` 跑完、`0006` 也应用之后）对应文件 | **8/9 逐字节一致**；`packages/tui/src/editor-zed-sqlite.ohos.ts` 因 `core.autocrlf=true` 的 CRLF/LF 落地差异在 `cmp` 下报差异，**删掉 `\r` 后逐字节一致**（见下方「其它约定」的行尾条）—— 即 **9/9 在行尾归一化后一致**（2026-10-14 实测口径） |
| 往返 | 逐条 `git apply` → `git apply --reverse --check` | **6/6 通过**（干净基线上逐条应用后反向判据全部成功，见上「干净基线按序应用」） |
| `0007` 正向判据 | 干净基线 `git worktree add --detach 9b4ec5714d` 内 `git apply --check` + `git apply` | **干净落地**，无 fuzz、无 `--3way`、无拒绝 hunk |
| `0007` 幂等判据 | 主工作树（`0007` 已应用）`git -C ../opencode apply --reverse --check` | **成功** ⇒ `build-opencode.mjs` 阶段 ① 判为已应用并跳过 |
| `0007` 应用结果一致性 | 干净基线应用后的 5 个落点文件 vs 主工作树对应文件 | **3/5 逐字节一致**（`dialog.tsx`、`runtime/i18n/en.ts`、`runtime/i18n/zh.ts`）；两个**新增**文件 `workspaces/selection/roots.ts` / `roots.test.ts` 在 `cmp` 下报差异 —— 原因是 `core.autocrlf=true`：worktree 检出为 CRLF、主工作树内为 LF，**行尾归一化后一致**（同 `0005` 的既有口径） |
| `0007` host 侧语义 | 主工作树内 `bun test --conditions=solid --preload ./happydom.ts src/workspaces/selection` | **63 pass / 0 fail**（3 个测试文件：新增 `roots.test.ts` 22 项 + 既有 `domain.test.ts` / `picker.test.ts` 回归） |
| `0008` 幂等判据 | 主工作树（`0008` 已应用）`git -C ../opencode apply --reverse --check` | **成功** ⇒ `build-opencode.mjs` 阶段 ① 判定为已应用并跳过 |
| `0008` 正向判据 | 干净基线 `git worktree add --detach 9b4ec5714d` 内按 `0001→0008` 依次 `git apply` | **8/8 干净落地**，无 fuzz、无 `--3way` |
| `0008` 应用结果一致性 | 干净基线应用后的 8 个落点文件 vs 主工作树对应文件 | **8/8 一致**（`git/credentials.ts`、`git/git.tsx`、`git/git.css`、`shell.tsx`、`pages.ts`、`route.ts`、`i18n/{en,zh}.ts`） |

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
