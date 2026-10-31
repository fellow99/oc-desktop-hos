# 011 — 版本更新：2.2.5 技术方案（hos）

> **回引:** `spec.md` ｜ **模块:** release ｜ **最后更新:** 2026-10-31
> **上游基线:** opencode `v2.2.5`（`9bbb8ce18c`）｜ **运行期:** Electron 37（Node 22.17.0 / ABI v138）
> **日志目录:** `logs/20261031-1/`

## 1. 决策

| # | 决策 | 依据 | 回引 |
|---|---|---|---|
| D1 | 版本规则沿用 `major*10000 + minor*100 + patch` → `2.2.5` = **20205** | 前序 D1 | FR-ver-102 |
| D2 | 清理沿用显式枚举清单，删除前断言命中 `.gitignore`；保留 `node_modules/`、`oh_modules/`、`.cache/`、签名材料、Electron 物料 | 前序 D2 | FR-ver-101 |
| D3 | 补丁迁移：逐条 `git apply --check`；通过者原样复制入 `patches/v2.2.5/`；0003/0007/0008 在干净 v2.2.5 树上施加等效改动后 `git diff` 重生成，编号/语义不变 | `--check` 实测（5 通过 / 3 失败） | FR-ver-104 |
| D4 | 构建守卫更新：`PATCH_DIR=patches/v2.2.5`、`EXPECTED_BASELINE=9bbb8ce18c`、版本正则 `2\.2\.5` | `scripts/build-opencode.mjs` | FR-ver-105 |
| D5 | bun 契约 **1.4.2 → 1.4.4**（`BUN_REQUIRED='1.4.4'`）；上游 `packageManager=bun@1.4.4` 硬校验；脚本自动下载到 `.cache/bun/`（gitignored） | `packages/script/src/index.ts` | FR-ver-105 |
| D6 | `patches/v2.1.2/` 原地保留 | 历史锚点 | FR-ver-104 |
| D7 | 内置 `bash→shell` 改名无需适配：hos 自带名为 `shell` 的插件，插件同名优先，继续覆盖内置工具 | v2.2.5 `tool-input-repair.ts` 别名规则 | U2 |
| D8 | 0008 凭据页按 v2.2.5 **新 settings 架构重锚**（功能等价：凭据 CRUD + 0600 仍由宿主/插件 RPC 提供，UI 仅入口）；若新架构无合适 tab，则挂入通用/服务器页同级，保证可达 | `settings/git/` 已消失 | U4 |
| D9 | 无鸿蒙真机：FR-ver-106/107 标记跳过；以 host 侧全门禁（smoke-node22、test-harmony-plugins、verify-branding、verify-git-plugin）作为替代证据 | 用户约束 | FR-ver-107 |
| D10 | 报告写入 `logs/20261031-1/`；能力清单不新建本轮文档，抽查结论记 TEST_REPORT | 避免文档膨胀 | FR-ver-107 |
| D11 | 凭证零落盘；构建后 `../opencode` 工作树恢复干净（不提交 submodule 改动） | spec §6 | FR-ver-108 |

## 2. 步骤

| 步 | 动作 | 命令 / 落点 | 出口判据 |
|---|---|---|---|
| S0 | 记录基线 | `git -C ../opencode describe --tags`、工具链版本 | 写入日志 |
| S1 | 清理中间/临时产物 | §3 清单逐条删除并断言 `.gitignore` | AC-01 |
| S2 | 版本号 | `AppScope/app.json5` → 2.2.5/20205；README | AC-02/03 |
| S3 | 构建守卫 + bun 契约更新 | build-opencode.mjs（D4/D5） | 脚本自洽 |
| S4 | 补丁迁移 | 复制 5 条；重生成 0003/0007/0008 → `patches/v2.2.5/` + README | AC-04 |
| S5 | opencode 产物构建 | `collect-runtime` → `collect-app` → `build-opencode` | 守卫全绿 + 冒烟 |
| S6 | HAP 构建 | `pwsh -File scripts/build-debug.ps1` | AC-06 |
| S7 | host 门禁替代证据 | smoke-node22 / test-harmony-plugins / verify-branding / verify-git-plugin | AC-07 |
| S8 | 真机测试 | **跳过（无设备）** | test-cases 标注 |
| S9 | 代码评审 | requesting/receiving-code-review | REVIEW_REPORT |
| S10 | 敏感信息扫描 | diff 复查 + 敏感串扫描；opencode 树恢复干净 | AC-08 |
| S11 | 提交 + 本地 tag | Conventional Commits；`git tag v2.2.5`；不 push | AC-09 |

## 3. 清理清单（D2）

**删除（构建产物与临时文件；删除前逐条断言命中 `.gitignore`）**

| 类别 | 路径 |
|---|---|
| hvigor 生成物 | `electron/build/`、`web_engine/build/`、`electron/.preview/`、`.hvigor/`、`web_engine/BuildProfile.ets` |
| 构建暂存 | `.stage/` |
| resfile 投放物 | `web_engine/src/main/resources/resfile/resources/app/opencode-dist.tar.gz`、`opencode-dist.version`、`resfile/opencode/`（以新产物为准） |
| bun 旧缓存 | `.cache/bun/`（内容为可下载物，删除后脚本自动取 1.4.4） |
| 日志/临时 | 工程根散落 `*.log`（不含 `docs/`、`logs/`） |

**保留**：`node_modules/`、`oh_modules/`、`electron/libs/`、`signing.*.local.json*`、`.idea/`、`logs/`、`patches/`、`specs/`、`skills/`、`plugins/`。

## 4. 风险

| # | 风险 | 缓解 |
|---|---|---|
| R1 | 0007（1001 行）/0008（577 行）新结构差异大，重生成工作量高 | 以 v2.2.5 源码为准做功能等价移植；逐条 `--reverse --check` 闭环；host 插件单测兜底 |
| R2 | 0003 打桩与持久终端新 `pty-binding.ts` 接口不匹配导致 bundle 期类型/导出错误 | 构建门禁前移暴露；按新接口调整 ohos 桩；平台仍 `available=false` |
| R3 | bun 1.4.4 下载失败（网络） | `.cache/bun` 自动下载；失败则用已安装版本或 `--bun` 指定，不静默降级 |
| R4 | 误删签名材料/依赖缓存 | D2 显式清单 + `.gitignore` 断言 |
| R5 | 凭证落入规格/日志/提交 | D11 + S10 双重扫描；占位符纪律 |
| R6 | 三端共用 `../opencode` 单一工作树，补丁互相污染 | 每端构建在干净树上幂等打补丁；结束后恢复干净；串行执行 hos→ark→android |
