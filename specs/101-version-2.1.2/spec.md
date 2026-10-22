# 101 — 版本更新：2.1.2 功能规格

> **Module:** release ｜ **Status:** Implementing ｜ **Last Updated:** 2026-10-22
> **需求编号:** 101-version-2.1.2 ｜ **需求名称:** 版本更新：2.1.2
> **git 分支:** 不改动（不新建、不切换、不重命名；沿用 `main`，与 `./opencode` 的 `Branch_v2.1.2` 无关）
> **涉及工程:** `oc-desktop-hos`（父工程 `D:\opencode-workspace\`）
> **上游基线:** opencode **v2.1.2**（tag `v2.1.2` / 提交 `a517687fde` / 分支 `Branch_v2.1.2`）
> **运行期:** Electron 37（`v37.2.3-20260825.1` = Node **22.17.0** / Chromium 138 / ABI **v138**）
> **前序规格:** `specs/101-version-2.0.26/`（2.0.26 轮；本规格是其版本化续篇）

## 1. 目的

把 `oc-desktop-hos` 的上游基线从 opencode `v2.0.26`（`9b4ec5714d`）推进到 **`v2.1.2`**（`a517687fde`），
工程版本号固化为 **`2.1.2` / `versionCode 20102`**；清理中间/临时文件，把补丁集迁移到新基线
（新建 `patches/v2.1.2/`），重新编译构建并部署真机，随后完成环境能力与基本功能测试。

## 2. 范围

**In scope**

- 工程**中间文件 / 临时文件**清理（显式枚举清单，见 `plan.md` §3）。
- **版本号** `2.1.2` / `20102`（`AppScope/app.json5`、`README.md`、规格与文档同步）。
- **补丁集迁移**：`patches/v2.0.26/`（8 条）→ `patches/v2.1.2/`；能干净应用的复用，冲突的**重生成**。
- **构建脚本基线守卫更新**：`scripts/build-opencode.mjs` 的 `PATCH_DIR` / `EXPECTED_BASELINE` / 版本正则。
- **重新编译构建**：`collect-runtime` → `collect-app` → `build-opencode`（含 host 侧 Node 22.17 冒烟门禁）→ `build-debug.ps1`。
- **真机部署与测试**：模型 Key 设置、沙箱工作区、一次对话、一次图片分析对话、GIT 仓库常用操作（见 `test-cases.md`）。
- **鸿蒙环境能力复验**：按 `docs/鸿蒙环境能力清单-v2.0.26.md` 既有结论抽查关键项。
- **敏感信息纪律**：测试用密钥/账号/密码**不落盘**（§6）。

**Out of scope**

- **不改上游一个字节（直接编辑）**：`../opencode` 只通过 `patches/` 施加改动。
- **不改 git 分支**：不新建、不切换、不重命名（明确要求）。
- **不动兄弟工程基线**：`harmonypc-electron`（Electron 37 物料不变）。
- **不做上架材料**：不申请 ACL、不生成发布证书。
- **不改品牌化与插件体系**（103 / 201 / 202 / 203 / 204 既有结论沿用，仅随补丁迁移适配）。

## 3. 上游事实（本规格前提）

### 3.1 需求声明的上游基线

| 项 | 值 |
|---|---|
| 需求声明 | opencode `tag=v2.1.2`，分支 `Branch_v2.1.2` 已创建 |
| 实际状态 | ✅ `../opencode` HEAD = `a517687fde`（`release: v2.1.2`），分支 `Branch_v2.1.2`，tag `v2.1.2` 存在，工作树干净 |
| 构建期守卫 | `scripts/build-opencode.mjs` 阶段 0 校验基线与 `packages/*/package.json` 版本（**本规格 S3 改为 v2.1.2**） |
| 其余构建输入 | `../harmonypc-electron-versions/v37.2.3-20260825.1-release.zip`、`../assets/`（不变） |

### 3.2 上游漂移评估（v2.0.26 → v2.1.2）

| # | 事实 | 影响 |
|---|---|---|
| U1 | 两基线间 **1815 个提交**（含 v2.0.27…v2.1.1 中间版本），`acdcdb8dd9 refactor: v2.1 minor breaking changes` 等大改 | 补丁不能盲复用，逐条 `--check` |
| U2 | 落点 `packages/core/src/persistent-pty`、`packages/app/src/workspaces`（workspace submenu 共享 `65932e870c`）、`packages/app/src/settings` 有实质演进 | 0003 / 0007 / 0008 大概率冲突，需重生成 |
| U3 | 上游 `packages/*/package.json` 版本号为 `2.1.2` | 守卫正则同步改 |
| U4 | `vite.node.config.ts` / `shell/select.ts` 落点仍存在 | 0001 / 0006 可能小幅偏移 |

## 4. 需求条目

- **FR-ver-101**（MUST）：清理中间/临时文件；不得删除源码、配置、文档、`patches/`、`specs/`、`skills/`、`plugins/`、
  依赖目录（`node_modules/`、`oh_modules/`）与签名材料；清理后 `git status` 不得出现已跟踪文件被删除。
- **FR-ver-102**（MUST）：`AppScope/app.json5` 的 `versionName = "2.1.2"`、`versionCode = 20102`
  （规则 `major*10000 + minor*100 + patch`）。
- **FR-ver-103**（MUST）：版本号同步 `README.md` 与规格/文档；无「当前版本 2.0.26」残留
  （历史变更记录与能力清单文件名中的版本锚点除外，须可解释）。
- **FR-ver-104**（MUST）：新建 `patches/v2.1.2/`，每条补丁在新基线上满足 `git apply --check`（未应用态）；
  应用后满足 `git apply --reverse --check`；`patches/v2.0.26/` 原地保留（历史锚点，不再被构建引用）。
- **FR-ver-105**（MUST）：构建链全绿：`collect-runtime` 守卫、`build-opencode`（含 `EXPECTED_BASELINE=a517687fde`
  与 `"version": "2.1.2"` 守卫、冒烟 8 项）、`collect-app`、`build-debug.ps1` 签名产出。
- **FR-ver-106**（MUST）：真机部署成功：卸载 → 安装 → 启动 → 界面加载非白屏。
- **FR-ver-107**（MUST）：真机测试通过：`test-cases.md` 全部用例有结论（能力清单抽查 + 基本功能 + GIT 操作）。
- **FR-ver-108**（MUST）：**敏感信息不落盘**（§6）。
- **FR-ver-109**（SHOULD）：提交按 `git-commit` 技能规范前缀（`feat/fix/docs/chore/...`），本地签名配置不入库。

## 5. 验收标准

| # | 标准 | 证据 |
|---|---|---|
| AC-01 | 清理完成且不伤已跟踪文件 | `git status --porcelain` 无 ` D ` 行 |
| AC-02 | 版本号 `2.1.2` / `20102` | `AppScope/app.json5` + HAP `pack.info` |
| AC-03 | 文档无旧版本残留语义 | `grep` 复查记录 |
| AC-04 | `patches/v2.1.2/` 往返可应用 | 逐条 `--check` / `--reverse --check` 记录 |
| AC-05 | 构建链全绿 | 各阶段日志（`logs/20261022-1/`） |
| AC-06 | HAP 签名产出 | `electron-default-signed.hap` 存在且签名有效 |
| AC-07 | 真机安装启动就绪 | `hdc` 安装输出 + 启动日志 + 界面加载 |
| AC-08 | 测试用例全执行 | `TEST_REPORT.md` 每条用例有结论 |
| AC-09 | 敏感信息零落盘 | §6 扫描记录 |
| AC-10 | 提交规范 | `git log` 前缀符合 git-commit 技能 |

## 6. 敏感信息纪律（不落盘）

| 类别 | 纪律 |
|---|---|
| 模型 API Key | 只在**应用 UI 运行时**输入；规格/日志/报告/脚本中一律写占位符 `<API_KEY>` |
| GIT 账号/密码 | 只在**应用 Git 凭据页运行时**输入；文档中写 `<USER>` / `<PASSWORD>`；测试完成后在凭据页**删除该条目** |
| 内网测试 URL | 可写仓库地址，但**不写**「URL 内嵌凭证」形式（`http://user:pass@host/...`） |
| 本地签名配置 | `build-profile.json5` 的本地签名 diff 与 `signing.*.local.json` 均不入库 |
| 提交前检查 | `git add` 后 `git diff --staged` 人工复查 + 全库敏感串扫描（`logs/20261022-1/`） |
