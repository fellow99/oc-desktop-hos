# 101 — 版本更新：2.1.2 技术方案

> **回引:** `specs/101-version-2.1.2/spec.md` ｜ **模块:** release ｜ **最后更新:** 2026-10-22
> **上游基线:** opencode `v2.1.2`（`a517687fde`）｜ **运行期:** Electron 37（Node 22.17.0 / ABI v138）

## 1. 决策

| # | 决策 | 依据 | 回引 |
|---|---|---|---|
| D1 | 版本规则沿用 `major*10000 + minor*100 + patch` → `2.1.2` = **20102** | 与前序规格 `101-version-2.0.26` D1 一致 | FR-ver-102 |
| D2 | 清理沿用**显式枚举清单**，删除前断言命中 `.gitignore`；保留 `node_modules/`、`oh_modules/`、`.cache/`、签名材料 | 前序 D2/D3；`git clean -xfd` 会误删 | FR-ver-101 |
| D3 | 补丁迁移策略：对 `patches/v2.0.26/` 逐条在新基线 `git apply --check`；通过者**原样复制**入 `patches/v2.1.2/`，失败者**按新基线重生成**（在干净 v2.1.2 树上施加等效改动后 `git diff` 产出），编号沿用原语义、目录内 README 重写清单 | `patches/v2.0.26/README.md`「换基线必须新建目录」契约 | FR-ver-104 |
| D4 | 构建守卫同步改三处：`PATCH_DIR` → `patches/v2.1.2`、`EXPECTED_BASELINE` → `a517687fde`、版本正则 → `2.1.2` | `scripts/build-opencode.mjs:48-85` | FR-ver-105 |
| D5 | `patches/v2.0.26/` **原地保留**不删除 | 历史锚点与 2.0.26 轮证据链可回溯 | FR-ver-104 |
| D6 | 测试凭证零落盘：API Key 与 GIT 账号只在运行时输入，文档占位；GIT 凭据测试后删除 | spec §6 | FR-ver-108 |
| D7 | 能力复验按 `docs/鸿蒙环境能力清单-v2.0.26.md` 已 ✅ 项**抽查**（升级轮回归），⬜ 项维持原状 | 升级不改变平台能力边界；抽查聚焦启动链路 | FR-ver-107 |
| D8 | 报告写入 `logs/20261022-1/`；能力清单**不新建** v2.1.2 文档（抽查结论记录在 TEST_REPORT） | 避免文档膨胀；能力清单以 2.0.26 轮为权威 | FR-ver-107 |

## 2. 步骤

| 步 | 动作 | 命令 / 落点 | 出口判据 |
|---|---|---|---|
| S0 | 记录基线：设备、上游 HEAD | `hdc list targets`、`git -C ../opencode describe --tags` | 写入 `logs/20261022-1/` |
| S1 | 清理中间/临时产物 | §3 删除清单逐条删除 | AC-01 |
| S2 | 版本号 | `AppScope/app.json5` → `2.1.2`/`20102`；`README.md` 同步 | AC-02/03 |
| S3 | 构建守卫更新 | `scripts/build-opencode.mjs` 三处（D4） | 脚本自洽 |
| S4 | 补丁迁移 | 逐条 `--check`；复制/重生成 → `patches/v2.1.2/` + README | AC-04 |
| S5 | opencode 产物构建 | `node scripts/collect-runtime.mjs` → `node scripts/collect-app.mjs` → `node scripts/build-opencode.mjs` | 守卫全绿 + 冒烟 8 项 |
| S6 | HAP 构建 + 签名 | `pwsh -NoProfile -ExecutionPolicy Bypass -File scripts\build-debug.ps1` | AC-06 |
| S7 | 部署 | `hdc uninstall` → `hdc app install -r` → `aa start` | AC-07 |
| S8 | 真机测试 | `test-cases.md` §3/§4 | AC-08 |
| S9 | 代码评审 | `requesting-code-review` + `receiving-code-review` | REVIEW_REPORT |
| S10 | 敏感信息扫描 | §spec 6 清单 + `git diff --staged` 复查 | AC-09 |
| S11 | 提交 | `git-commit` 规范前缀；签名配置不提交 | AC-10 |

## 3. 清理清单（D2）

**删除（构建产物与临时文件；删除前逐条断言命中 `.gitignore`）**

| 类别 | 路径 |
|---|---|
| hvigor 生成物 | `electron/build/`、`web_engine/build/`、`electron/.preview/`、`.hvigor/`、`web_engine/BuildProfile.ets` |
| 构建暂存 | `.stage/` |
| resfile 投放物 | `web_engine/src/main/resources/resfile/resources/app/opencode-dist.tar.gz`、`opencode-dist.version`、`web_engine/src/main/resources/resfile/opencode/`（如构建脚本重新投放则以新产物为准） |
| 日志/临时 | `*.log`（工程根散落的临时日志，不含 `docs/` 内文档） |

**保留（可重建输入与凭证，不是中间产物）**

`node_modules/`、`oh_modules/`、`.cache/`（bun）、`electron/libs/`（dlopen 锚点）、
`signing.*.local.json*`、`.idea/` 等本地 IDE 配置、`logs/` 历史证据。

## 4. 风险

| # | 风险 | 缓解 |
|---|---|---|
| R1 | 上游 1815 提交漂移导致 0007/0008（需求 203/204 落点 `workspaces`/`settings`）大幅冲突 | 以 v2.1.2 源码为准重生成；重生成后跑 `scripts/test-harmony-plugins.mjs` 与对应规格自检 |
| R2 | 上游 v2.1 minor breaking（`acdcdb8dd9`）改变服务端行为，冒烟或真机启动失败 | 冒烟门禁前移暴露；真机日志取证；必要时按工程规划「冲突即终止」回报用户 |
| R3 | 误删签名材料/依赖缓存 | D2 显式清单 + `.gitignore` 断言 |
| R4 | 凭证落入规格/日志/提交 | D6 占位纪律 + S10 双重扫描 |
