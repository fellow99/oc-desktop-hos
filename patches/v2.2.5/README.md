# patches/v2.2.5 —— opencode v2.2.5 上游补丁（8 条）

本目录是**上游补丁**（不是本工程的构建脚本）。补丁只做「新增文件 + 开关式少量改动」，由
`scripts/build-opencode.mjs` 阶段 ① 幂等应用到 `../opencode`，再由阶段 ③ 构建产物。
契约见 `docs/工程规划-V2.md` §3.5 / §3.6 / §6.2 / §7.4。

## 基线（改动与验证的唯一基准）

| 项 | 值 |
|---|---|
| 仓库 | `../opencode`（上游，submodule） |
| tag | **v2.2.5** |
| 提交 | **9bbb8ce18c**（`release: v2.2.5`），分支 `Branch_v2.2.5` |
| 补丁头路径 | `a/packages/...` → `b/packages/...`（`git apply` 默认 `-p1`） |
| 构建 bun | 上游 `packageManager=bun@1.4.4`（脚本 `BUN_REQUIRED='1.4.4'`） |

换基线必须**新建** `patches/<新 tag>/` 目录重生成补丁，本目录只对 v2.2.5 成立
（`scripts/build-opencode.mjs` 的 `EXPECTED_BASELINE=9bbb8ce18c` 会前置校验）。

## 与 v2.1.2 的关系（迁移记录，2026-10-31）

v2.1.2 → v2.2.5 上游漂移 **1117 个提交**（v2.2.0 为 minor：Desktop UI 大改版、`@opencode/ai`
根导出改 Promise API；v2.2.4 持久终端重构；v2.2.5 内置工具 `bash` 改名 `shell`）。逐条在新基线
`git apply --check` 结果：

- **原样复用（5 条）**：`0001` / `0002` / `0004` / `0005` / `0006`（内容零改动，干净应用）。
- **按 v2.2.5 源码重生成（3 条）**：
  - `0003`：`packages/core/package.json` 的 `#pty` / `#persistent-pty-binary` 导出图位置漂移
    （新增的 `#claude-agent-sdk` 段插在中间）；两个 ohos 打桩文件仍为新增，
    对 v2.2.4 持久终端新结构（`pty-binding.ts`）复核后维持 `available=false` 平台边界。
  - `0007`：`workspaces/selection/` 重构——旧 `roots.ts` 被上游拆为 `domain.ts` / `policy.ts` /
    `picker.tsx`，对话框改用 `createStore`。纯逻辑模块 `roots.ts`（+23 单测）整体保留，UI 注入
    按新 store/新 JSX 结构等价移植；i18n 键锚点迁移到新 `dialog.directory.readError` 后。
  - `0008`：settings 架构重排（旧 `settings/git/` 已不存在，新增 workspaces/projects/extensions
    等 tab）。凭据 RPC 封装与页面组件整体保留，接线点改到新的 `route.ts` / `pages.ts` /
    `shell.tsx`（`SettingsRootTab` 增 `git`、导航组与 `Tabs.Content`）；图标用 `outline-worktree`。

> `bash→shell` 改名对本工程无影响：hos 自带名为 `shell` 的 JS 插件，按上游「插件同名优先」
> 规则继续覆盖内置工具（v2.2.5 `packages/core/src/plugin/tool-input-repair.ts` 仅做 `bash→shell` 别名）。

## 补丁清单

| 编号 | 落点文件 | 作用（摘要） | 迁移 |
|---|---|---|---|
| `0001-node-target-ohos.patch` | `packages/cli/vite.node.config.ts` | ① `build.target` 支持 `OPENCODE_NODE_TARGET` 覆盖（本工程 `node22`，对齐 Electron 37 Node 22.17.0）；② `resolve.conditions` 增 `ohos` 优先。 | 原样 |
| `0002-sqlite-ohos.patch` | `packages/core/package.json` + `database/sqlite.ohos.ts` | better-sqlite3 `.node` → `node:sqlite` 两级加载后端 + API 语义对齐。 | 原样 |
| `0003-runtime-stubs-ohos.patch` | `packages/core/package.json` + 新 `pty.ohos.ts` / `binary.ohos.ts` | PTY 打桩（`available=false`），避免原生模块顶层加载中断 bundle。 | **重生成** |
| `0004-tui-zed-sqlite-ohos.patch` | `packages/tui/package.json` + `editor-zed-sqlite.ohos.ts` | `#zed-sqlite` 增 ohos 变体。 | 原样 |
| `0005-string-width-ohos.patch` | `packages/tui/package.json` + `util/string-width.ohos.ts` | `#string-width` 增 ohos 变体。 | 原样 |
| `0006-shell-select-ohos.patch` | `packages/core/src/shell/select.ts` | `stat()` EACCES/ENOENT 同等处理；`fallback()` 认 `OC_SHELL_FALLBACK`。 | 原样 |
| `0007-workspace-roots-picker.patch` | 新 `workspaces/selection/roots.ts`(+test)；改 `dialog.tsx`/`dialog.css`、i18n | 需求 203：四主目录（沙箱/桌面/文档/下载）选择器，自门控回退上游。 | **重生成** |
| `0008-git-credentials-settings.patch` | 新 `settings/git/*`；改 `settings/{route,pages,shell}`、i18n | 需求 204：「设置 → Git」凭据页，自门控；能力由 `plugins/oc-plugin-git` 提供。 | **重生成** |

## 验证记录（2026-10-31）

- 干净 v2.2.5 树上 8 条逐条 `git apply --check` 通过；按序全应用后逐条
  `git apply --reverse --check` 通过（幂等往返）。
- 全应用树 `tsc -b packages/app`：selection/settings/git/i18n 范围零类型错误
  （其余报错为预存在的可选依赖 `knobs`/`@opencode/gui-plugins`/playwright 等缺失，与补丁无关）。
- `roots.test.ts` 23 项纯函数单测全绿。

## 生成命令（可复现）

```bash
# 在 ../opencode（干净 v2.2.5 工作树）上：
git apply <patch>                 # 验证正向可应用
git apply -R --check <patch>      # 应用态验证反向可应用
# 重生成：在干净树上施加等效改动后
git add -N <新文件> && git diff <相关路径> | tr -d '\r' > <编号>-<名>.patch
```
