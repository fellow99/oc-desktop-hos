# 011 — 版本更新：2.2.5 功能规格

> **Module:** 011-version-2.2.5 ｜ **Status:** Implementing ｜ **Last Updated:** 2026-10-31
> **需求编号:** 011-version-2.2.5 ｜ **需求名称:** 版本更新：2.2.5
> **git 分支:** 不改动（不新建、不切换、不重命名；沿用 `main`）
> **涉及工程:** `oc-desktop-hos`（父工程 `D:\opencode-workspace\`）
> **上游基线:** opencode **v2.2.5**（tag `v2.2.5` / 提交 `9bbb8ce18c` / 分支 `Branch_v2.2.5`）
> **运行期:** Electron 37（`v37.2.3-20260825.1` = Node **22.17.0** / Chromium 138 / ABI **v138**，物料不变）
> **前序规格:** `specs/011-version-2.1.2/`（v2.1.2 轮；本规格是其版本化续篇）

## 1. 目的

把 `oc-desktop-hos` 的上游基线从 opencode `v2.1.2`（`a517687fde`）推进到 **`v2.2.5`**（`9bbb8ce18c`，
区间 1117 个提交），工程版本号固化为 **`2.2.5` / `versionCode 20205`**；清理中间/临时文件，
把补丁集迁移到新基线（新建 `patches/v2.2.5/`，14 处失败补丁在干净 v2.2.5 树上重生成），
重新编译构建并通过 host 侧门禁。

## 2. 范围

**In scope**

- 工程**中间文件 / 临时文件**清理（显式枚举清单，沿用 v2.1.2 plan §3，见本规格 plan §3）。
- **版本号** `2.2.5` / `20205`（`AppScope/app.json5`、`README.md`、规格与文档同步）。
- **补丁集迁移**：`patches/v2.1.2/`（8 条）→ `patches/v2.2.5/`：
  - 原样复用（`--check` 干净）：0001 / 0002 / 0004 / 0005 / 0006（5 条）。
  - **重生成**（3 条）：0003（package.json 导出图漂移；两个 ohos 文件为新增）、
    0007（`workspaces/selection/` 重构：`roots.ts` 拆为 `domain.ts`/`policy.ts`/`picker.tsx`）、
    0008（settings 架构重排：`settings/git/` 目录消失，按新设置架构重锚凭据页）。
- **构建脚本基线守卫更新**：`scripts/build-opencode.mjs` 的 `PATCH_DIR` / `EXPECTED_BASELINE` / 版本正则；
  bun 契约由 `^1.4.2` 升到上游 `packageManager` 实际值 **`^1.4.4`**（`BUN_REQUIRED='1.4.4'`）。
- **重新编译构建**：`collect-runtime` → `collect-app` → `build-opencode`（含 host 侧 Node 22 冒烟）→ `build-debug.ps1`。
- **敏感信息纪律**：测试密钥/账号/密码**不落盘**（§6）。

**Out of scope**

- **不改上游一个字节（直接编辑入库）**：`../opencode` 只通过 `patches/` 施加改动；工作树改动仅在构建期，不提交 submodule。
- **不改 git 分支**（明确要求）。
- **鸿蒙真机测试**：本轮无鸿蒙真机，部署/真机测试用例标记「跳过-无设备」，仅保证 host 侧门禁与构建全绿。
- **不动 Electron 物料基线**：`../harmonypc-electron-versions/v37.2.3-20260825.1` 不变。
- **不跟随上游平台不可得能力**：PTY 仍打桩（v2.2.4 持久终端重构不改变平台边界）；插件在线安装、MCP stdio 仍不投放。

## 3. 上游事实（本规格前提）

### 3.1 需求声明的上游基线

| 项 | 值 |
|---|---|
| 需求声明 | opencode `tag=v2.2.5`，分支 `Branch_v2.2.5` 已创建 |
| 实际状态 | ✅ `../opencode` HEAD = `9bbb8ce18c`（`release: v2.2.5`），分支 `Branch_v2.2.5`，tag 存在，工作树干净 |
| packageManager | **bun@1.4.4**（`packages/script/src/index.ts` 以 `^1.4.4` semver 硬校验） |
| 其余构建输入 | `../harmonypc-electron-versions/v37.2.3-20260825.1-release.zip`、`../assets/`（不变） |

### 3.2 v2.2.0–v2.2.5 漂移评估（对本工程）

| # | 事实 | 影响 |
|---|---|---|
| U1 | 区间 **1117 提交**；v2.2.0 minor（Desktop UI 大改版、`@opencode/ai` Promise API 重构） | 本工程不直接 import `@opencode/ai`；Web UI 同源跟随，无适配代码 |
| U2 | **内置工具 `bash` 改名 `shell`**（v2.2.5，`tool-input-repair.ts` 保留 `bash→shell` 别名；插件同名 `bash` 优先） | hos 自带名为 `shell` 的 JS 插件，按「插件同名优先」**继续覆盖内置工具，行为不变**；无需改名 |
| U3 | v2.2.4 **持久终端**：`persistent-pty/` 目录重构（新增 `pty-binding.ts`、`binary.node.ts` 等） | 0003 的 `binary.ohos.ts`/`pty.ohos.ts` 打桩需对新接口复核后重生成；`available=false` 语义不变 |
| U4 | `workspaces/selection/` 重构（domain/policy/picker 拆分）；settings 重排（无 `settings/git/`） | 0007/0008 需按新结构重生成（功能等价移植） |
| U5 | 图片生成/artifacts/schedules 等均为实验开关，默认不启用；图片**分析**（多模态）链路保留 | 基本功能测试不受影响 |

## 4. 需求条目

- **FR-ver-101**（MUST）：清理中间/临时文件；不得删除源码、配置、文档、`patches/`、`specs/`、`skills/`、`plugins/`、
  依赖目录与签名材料；清理后 `git status` 不得出现已跟踪文件被删除。
- **FR-ver-102**（MUST）：`AppScope/app.json5` 的 `versionName = "2.2.5"`、`versionCode = 20205`
  （规则 `major*10000 + minor*100 + patch`）。
- **FR-ver-103**（MUST）：版本号同步 `README.md` 与规格/文档；无「当前版本 2.1.2」语义残留（历史锚点除外，须可解释）。
- **FR-ver-104**（MUST）：新建 `patches/v2.2.5/`，每条补丁在新基线上满足 `git apply --check`（未应用态）；
  应用后满足 `git apply --reverse --check`；`patches/v2.1.2/` 原地保留。
- **FR-ver-105**（MUST）：构建链全绿：`collect-runtime` 守卫、`build-opencode`（含 `EXPECTED_BASELINE=9bbb8ce18c`
  与 `"version": "2.2.5"` 守卫、bun 1.4.4、冒烟全绿）、`collect-app`、`build-debug.ps1` 签名产出。
- **FR-ver-106**（SKIP-本轮）：真机部署 —— 无鸿蒙真机，标记跳过。
- **FR-ver-107**（SKIP-本轮）：真机测试 —— 无鸿蒙真机；host 侧门禁（smoke-node22 / test-harmony-plugins / verify-branding / verify-git-plugin）必须全绿作为替代证据。
- **FR-ver-108**（MUST）：**敏感信息不落盘**（§6）。
- **FR-ver-109**（SHOULD）：提交按 `git-commit` 技能 Conventional Commits 前缀；本地签名配置不入库；本地打 tag `v2.2.5`，不 push。

## 5. 验收标准

| # | 标准 | 证据 |
|---|---|---|
| AC-01 | 清理完成且不伤已跟踪文件 | `git status --porcelain` 无 ` D ` 行 |
| AC-02 | 版本号 `2.2.5` / `20205` | `AppScope/app.json5` + HAP `pack.info` |
| AC-03 | 文档无旧版本残留语义 | `grep` 复查记录 |
| AC-04 | `patches/v2.2.5/` 往返可应用 | 逐条 `--check` / `--reverse --check` 记录 |
| AC-05 | 构建链全绿 | 各阶段日志（`logs/20261031-1/`） |
| AC-06 | HAP 签名产出 | `electron-default-signed.hap` 存在且 versionName 2.2.5 |
| AC-07 | host 侧门禁全绿（替代真机） | smoke-node22 / test-harmony-plugins / verify-branding / verify-git-plugin 输出 |
| AC-08 | 敏感信息零落盘 | §6 扫描记录 |
| AC-09 | 提交规范 + 本地 tag | `git log` 前缀合规；`git tag` 含 v2.2.5；不 push |

## 6. 敏感信息纪律（不落盘）

| 类别 | 纪律 |
|---|---|
| 模型 API Key | 只在应用 UI 运行时输入；规格/日志/报告/脚本一律占位符 `<API_KEY>` |
| GIT 账号/密码 | 只在应用 Git 凭据页运行时输入；文档写 `<USER>` / `<PASSWORD>` |
| 内网测试 URL | 不写「URL 内嵌凭证」形式 |
| 本地签名配置 | `build-profile.json5` 本地签名 diff 与 `signing.*.local.json` 均不入库 |
| 提交前检查 | `git add` 后 `git diff --staged` 复查 + 全库敏感串扫描 |
