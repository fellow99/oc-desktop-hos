# patches/v2.1.2 —— opencode v2.1.2 上游补丁（8 条）

本目录是**上游补丁**（不是本工程的构建脚本）。补丁只做「新增文件 + 开关式少量改动」，由
`scripts/build-opencode.mjs` 阶段 ① 幂等应用到 `../opencode`，再由阶段 ③ 构建产物。
契约见 `docs/工程规划-V2.md` §3.5 / §3.6 / §6.2 / §7.4。

## 基线（改动与验证的唯一基准）

| 项 | 值 |
|---|---|
| 仓库 | `../opencode`（上游，submodule） |
| tag | **v2.1.2** |
| 提交 | **a517687fde**（`release: v2.1.2`），分支 `Branch_v2.1.2` |
| 补丁头路径 | `a/packages/...` → `b/packages/...`（`git apply` 默认 `-p1`） |

换基线必须**新建** `patches/<新 tag>/` 目录重生成补丁，本目录只对 v2.1.2 成立
（`scripts/build-opencode.mjs` 的 `EXPECTED_BASELINE=a517687fde` 会前置校验）。

## 与 v2.0.26 的关系（迁移记录，2026-10-22）

v2.0.26 → v2.1.2 上游漂移 **1815 个提交**。8 条补丁逐条在新基线
`git apply --check` **全部通过**（上游演进未触及补丁上下文），按迁移策略
**原样复制**（内容零改动），编号/落点/作用与 `patches/v2.0.26/` 完全一致；
该目录作为 2.0.26 轮历史锚点原地保留。

## 补丁清单

| 编号 | 落点文件 | 作用（摘要） |
|---|---|---|
| `0001-node-target-ohos.patch` | `packages/cli/vite.node.config.ts` | ① `build.target` 支持 `OPENCODE_NODE_TARGET` 覆盖（本工程设 `node22`，对齐 Electron 37 内置 Node 22.17.0）；② `resolve.conditions` 增 `ohos` 条件变体优先。 |
| `0002-sqlite-ohos.patch` | `packages/core/package.json` + 新文件 `packages/core/src/database/sqlite.ohos.ts` | 真机 `node:sqlite` 无 binding：两级加载后端（better-sqlite3 `.node` → `node:sqlite` 兜底）+ API 语义对齐（`all()` 对非读取语句走 `run()`）。 |
| `0003-runtime-stubs-ohos.patch` | `packages/core/package.json` + 新文件 `pty.ohos.ts` / `binary.ohos.ts` | PTY 打桩（`available=false`），避免 `@lydell/node-pty` 顶层加载失败中断整个 bundle import。 |
| `0004-tui-zed-sqlite-ohos.patch` | `packages/tui/package.json` + 新文件 `editor-zed-sqlite.ohos.ts` | `#zed-sqlite` 增 ohos 变体，避免静态 `import "node:sqlite"` 在模块加载期即崩。 |
| `0005-string-width-ohos.patch` | `packages/tui/package.json` + 新文件 `util/string-width.ohos.ts` | `#string-width` 增 ohos 变体（2.0.26 轮已复盘为可回收项，保留不影响运行）。 |
| `0006-shell-select-ohos.patch` | `packages/core/src/shell/select.ts` | ① `stat()` 的 `EACCES` 与 `ENOENT` 一视同仁（设备域系统路径 stat 抛 EACCES）；② `fallback()` 增认 `OC_SHELL_FALLBACK`（壳侧注入 `/system/bin/sh`）。 |
| `0007-workspace-roots-picker.patch` | 新文件 `workspaces/selection/roots.ts`(+test)；改 `dialog.tsx`、`i18n/en.ts`、`zh.ts` | 需求 203：工作区目录选择对话框升级为四主目录（沙箱/桌面/文档/下载），自门控回退上游行为。 |
| `0008-git-credentials-settings.patch` | 新文件 `settings/git/*`；改 `settings/{route,pages,shell}.tsx`、`i18n/*` | 需求 204：「设置 → Git」凭据页（协议/主机/用户名/口令），自门控。能力侧由壳插件 `plugins/oc-plugin-git` 提供。 |

## 生成命令（可复现）

```bash
# 在 ../opencode（干净 v2.1.2 工作树）上按序应用全部补丁后，对每条改动生成：
git apply <patch>          # 验证正向可应用
git apply -R --check <patch>  # 应用态验证反向可应用
# 本轮（v2.1.2）为 v2.0.26 原样复制：cp ../patches/v2.0.26/*.patch ./
```
