# 101 — 版本更新：2.0.26 技术方案

> **回引:** `specs/101-version-2.0.26/spec.md` ｜ **模块:** release ｜ **最后更新:** 2026-10-13
> **上游基线:** opencode `v2.0.26`（`9b4ec5714d`）；pi `v2.0.26`（需求原文第二条基线；本工程不使用 pi 产物，见 `spec.md` §3.1）｜ **运行期:** Electron 37（Node 22.17.0 / ABI v138）

## 1. 决策

| # | 决策 | 依据 | 回引 |
|---|---|---|---|
| D1 | 版本规则沿用 `major*10000 + minor*100 + patch` → `2.0.26` = **20026**；`versionName = "2.0.26"` | 与兄弟工程 `pi-desktop-hos` 的版本规则一致，便于跨工程比对 | FR-ver-003 |
| D2 | 清理采用**显式枚举清单**（而非 `git clean -xfd` 之类的通配删除），逐条在删除前断言「存在于 `.gitignore`」 | `git clean` 会误删签名材料与依赖缓存；枚举可审阅 | FR-ver-001/002 |
| D3 | 保留 `node_modules/`、`oh_modules/`、`.cache/`、签名材料：它们是**依赖与可重建输入**，不是中间产物 | `pi-desktop-hos` 101 的 keep 列表 | FR-ver-001 |
| D4 | 补丁集**不新增**上游改动（品牌化与 JS 工具均在**本工程自有产物/插件**上实现），仅保留设备侧必需的 4 条 | 减少上游漂移面；`patches/README` 的「空目录不建」与「编号单调递增」规则 | FR-ver-005/006/007 |
| D5 | 品牌化在**构建期**作用于 `packages/app/dist` 产物（不改上游源码、不改 git 分支） | U4：UI 归档由 `app-assets.ts` 从 `dist/` 编码；产物级替换可审计、可反向断言 | FR-ver-022 |
| D6 | JS 工具以 **opencode 插件**形态交付（`plugins/oc-plugin-*` → 物化到 `<userData>/config/opencode/plugin/`），不在上游加补丁 | 上游无 `OPENCODE_DISABLE_PLUGIN*` 硬开关，插件是唯一「不改上游」的注入通道 | FR-ver-022 |
| D7 | 能力复验以 **host 门禁 + 应用域取证**双通道：服务端能力先由 `smoke-node22.mjs` 与 `/api/*` 锁定，再做 UI 侧取证 | 避免「UI 挂了就什么都测不了」；也避免把 `hdc shell` 域结论当作应用域结论 | FR-ver-017/020 |
| D8 | 报告写新文件 `docs/鸿蒙环境能力清单-v2.0.26.md`，v0.1 文件原地保留 | 结论有版本锚点；历史基线不回写 | FR-ver-019 |

## 2. 步骤

| 步 | 动作 | 命令 / 落点 | 出口判据 |
|---|---|---|---|
| S0 | 记录基线：设备、上游 HEAD、构建前产物指纹 | `hdc list targets`、`git describe`、`sha256(app-archive.bin)` | 数据写入 `logs/20261013-1/` |
| S1 | 版本号 | `AppScope/app.json5`（`0.1.0/1` → `2.0.26/20026`）+ `README.md` + 本规格 | AC-02/AC-03 |
| S2 | 清理中间/临时产物 | 见 §3 删除清单 | AC-01 |
| S3 | 补丁往返校验 | `git -C ../opencode apply --check\|--reverse --check patches/v2.0.26/*.patch` | AC-04 |
| S4 | 收集运行时 | `node scripts/collect-runtime.mjs` | 阶段 10 守卫全绿（AC-05） |
| S5 | 构建 opencode Node 产物 | `node scripts/build-opencode.mjs` | dist-node 就绪 + 冒烟 8 项全绿（AC-06） |
| S6 | 构建 + 签名 HAP | `pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/build-debug.ps1` | 产出 `electron-default-signed.hap`（AC-07） |
| S7 | 部署 | `hdc uninstall` → `hdc app install -r` → `aa start` | 应用进程起来（AC-08） |
| S8 | 基本功能 | 设置 DeepSeek Key → 建工作区 → 一次对话 | AC-09/10/11/12 |
| S9 | 能力复验 | 按 spec §4.5 逐条取证 | AC-13 |
| S10 | 文档同步 + 报告 | `docs/鸿蒙环境能力清单-v2.0.26.md`、`README.md`、`docs/真机验证记录.md` | AC-13/14 |
| S11 | 代码评审 | `requesting-code-review` + `receiving-code-review` | AC-15 |
| S12 | 提交 | `git-commit` 技能的规范前缀 | AC-16 |

## 3. 清理清单（D2）

**删除（构建产物与临时文件，全部在 `.gitignore` 内）**

| 类别 | 路径 |
|---|---|
| hvigor 生成物 | `electron/build/`、`web_engine/build/`、`electron/.preview/`、`.hvigor/`、`web_engine/BuildProfile.ets` |
| 构建暂存 | `.stage/`（`dist-node/`、`opencode-dist.tar.gz`） |
| resfile 投放物 | `web_engine/src/main/resources/resfile/resources/app/opencode-dist.tar.gz`、`opencode-dist.version` |
| 原生注入物 | `electron/libs/`（含 `better_sqlite3.node` 锚点——由 `collect-runtime` 重新投放） |
| 可再生的分析/解压缓存 | `.cache/runtime/`、`.cache/better-sqlite3/`、`.cache/smoke-host/`、`.cache/pkg-final.json` |
| 下载残留 | `.cache/node/node-v22.17.0-win-x64.zip`（解压后不再需要的下载包） |
| 脚本暂存 | `.collect-runtime-tmp/`、`.collect-opencode-tmp/`、`electron/.preview/` |
| 诊断残留 | 设备侧 `/data/storage/el2/base/files/ocr-trace.log`（部署前清理，避免混淆新旧失败） |
**保留（不得删除）**

`src-main/`、`electron/src/`、`web_engine/src/`（含 `resfile/resources/app` 下**已跟踪**的 `main.js` / `sidecar.js` /
`tar-extract.js` / `package.json` / `electron_white.png` / `skills/`）、`scripts/`、`patches/`、`runtime-overlays/`、
`specs/`、`docs/`、`skills/`、`plugins/`、`AppScope/`、`hvigorfile.ts`、`build-profile.json5`、`oh-package.json5`、
`code-linter.json5`、`LICENSE`、`README.md`、`signing.*.local.json{,.sample}`、`node_modules/`、`oh_modules/`、
`.cache/bun/`、`.cache/node/node-v22.17.0-win-x64/`、`.idea/`。

> **`.cache/` 的边界（D3 与 D2 的取舍）**：脚本缓存目录里既有「可再生的中间结果」也有「外部工具链分发」。
> 本轮删除**可再生的中间结果**（`runtime/` 解压树、`better-sqlite3/` 解压树、`smoke-host/`、`pkg-final.json`）
> 与**下载残留**（`node-v22.17.0-win-x64.zip`），保留**外部工具链**（`.cache/bun/` 的 bun 发行版、
> `.cache/node/node-v22.17.0-win-x64/` 的 Node 22.17.0 可执行文件）。理由：工具链不是本工程的中间产物，
> 而是**离线可构建的前置条件**；删除它会迫使 `build-opencode` / `smoke-node22` 联网重新下载（可能失败），
> 与「任一失败即中止，绝不静默降级」的纪律冲突。该例外在此显式登记。
>
> **实测结果（2026-10-13）**：删除量 `electron/build` 929 MB、`electron/libs` 183 MB、`.cache/runtime` 1.8 GB、
> `.stage` 105 MB、`.hvigor` 6.1 MB，合计约 3.0 GB；清理后 `git status` 无「已跟踪文件被删除」。

## 4. 版本同步落点

| 落点 | 现值 | 目标值 |
|---|---|---|
| `AppScope/app.json5` `versionName` | `0.1.0` | `2.0.26` |
| `AppScope/app.json5` `versionCode` | `1` | `20026` |
| `README.md` 状态段 | 「工程骨架…未在真机验证」 | 「已在真机验证（版本 2.0.26）」 |
| `docs/鸿蒙环境能力清单-v2.0.26.md` 文档头 | — | 版本 / 日期 / 设备 / 上游基线 |

## 5. 回滚

- 版本号与清理：`git checkout -- .` 可复原（清理对象全部未跟踪）。
- 构建：重跑 S4–S6 即可（幂等）。
- 部署：`hdc uninstall` 后安装上一版 HAP。
- 上游：补丁集未变更；若已应用，`git -C ../opencode apply --reverse <patch>` 可回退。

## 6. 风险处置映射

| 风险 | 处置落点 |
|---|---|
| R1 | S0/S6 记录 `app-archive.bin` 指纹；S5 冒烟含「内嵌 UI 可取回」 |
| R2 | §3 的保留清单 + 清理后立即跑 S4 守卫 |
| R3 | 保留 `ocr-trace.log` 诊断；`collect-runtime` 阶段 4 的 `node --check` 门禁 |
| R4 | S0 记录本轮设备型号/序列号/系统版本/API |
| R5 | S1 提升 `versionCode`；S7 先 `uninstall` |
| R6 | S5/S8 先做 host 与 `/api/*` 取证，再做 UI 取证 |
| R7 | README 前置登记；缺失即硬失败 |
