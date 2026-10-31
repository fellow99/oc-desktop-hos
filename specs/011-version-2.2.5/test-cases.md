# 011 — 版本更新：2.2.5 测试用例（hos）

> **回引:** `spec.md` / `plan.md` ｜ **最后更新:** 2026-10-31
> **本轮约束:** 无鸿蒙真机 —— 真机类用例（TC-10 起）统一标注 **SKIP-无设备**；以 host 门禁（TC-06~09）为替代证据。

## 1. 环境

| 项 | 值 |
|---|---|
| 主机 | Windows，Node 24.14.1，bun（脚本解析 1.4.4），pwsh 7，DevEco Studio 26.0/6.1 |
| 上游 | `../opencode` @ v2.2.5 `9bbb8ce18c`（Branch_v2.2.5） |
| 设备 | 无（TC-10+ 跳过） |

## 2. 静态与构建用例

| 用例 | 关联 | 步骤 | 期望 | 结果 |
|---|---|---|---|---|
| TC-01 清理不伤已跟踪文件 | AC-01 | `git status --porcelain` | 无 ` D ` 行 | ⬜ |
| TC-02 版本号 | AC-02 | 读 `AppScope/app.json5` | `2.2.5` / `20205` | ⬜ |
| TC-03 补丁正向 | AC-04 | `patches/v2.2.5/*.patch` 逐条 `git apply --check` | 8 条全通过 | ⬜ |
| TC-04 补丁反向 | AC-04 | 应用后逐条 `--reverse --check` | 8 条全通过 | ⬜ |
| TC-05 守卫自洽 | AC-05 | build-opencode.mjs 常量 | `9bbb8ce18c` / `2.2.5` / `patches/v2.2.5` / bun 1.4.4 | ⬜ |
| TC-06 运行时守卫 | AC-05 | `node scripts/collect-runtime.mjs` | 全阶段守卫绿 | ⬜ |
| TC-07 host 冒烟 | AC-05/07 | `node scripts/build-opencode.mjs`（末段 smoke-node22） | 冒烟全绿 | ⬜ |
| TC-08 HAP 产出与版本 | AC-02/06 | build-debug.ps1 + 解包读版本 | `electron-default-signed.hap`，`2.2.5`/`20205` | ⬜ |
| TC-09 插件/品牌/Git 门禁 | AC-07 | `test-harmony-plugins.mjs`、`verify-branding.mjs`、`verify-git-plugin.mjs` | 全绿 | ⬜ |

## 3. 真机基本功能用例（SKIP-无设备）

| 用例 | 关联 | 步骤 | 期望 | 结果 |
|---|---|---|---|---|
| TC-10 安装启动就绪 | FR-ver-106 | hdc 卸载/安装/`aa start` | 界面非白屏 | ⏭ SKIP-无设备 |
| TC-11 模型配置 | FR-ver-107 | 设置页录入 DeepSeek `<API_KEY>`（运行时） | Key 保存、模型可选 | ⏭ SKIP-无设备 |
| TC-12 工作区 | FR-ver-107 | 沙箱内新建测试目录 | 创建成功并为当前工作区 | ⏭ SKIP-无设备 |
| TC-13 一次对话 | FR-ver-107 | 发送「介绍一下你自己」 | SSE 流式正常回复 | ⏭ SKIP-无设备 |
| TC-14 图片分析对话 | FR-ver-107 | 发图并要求描述 | 基于图片内容回复 | ⏭ SKIP-无设备 |

## 4. GIT 用例（SKIP-无设备；凭证运行时录入，用后删除）

| 用例 | 关联 | 步骤 | 期望 | 结果 |
|---|---|---|---|---|
| TC-15 无账号 clone/常用操作 | FR-ver-107 | 公开仓 clone + status/branch/diff/log | 正常 | ⏭ SKIP-无设备 |
| TC-16 凭据保存/clone/清理 | FR-ver-107/108 | `<USER>`/`<PASSWORD>` 运行时录入，用后删除 | 0600 不回显、无残留 | ⏭ SKIP-无设备 |

## 5. 环境能力抽查（对照 `../../docs/能力对照清单.md`；SKIP-无设备）

| 用例 | 关联 | 步骤 | 期望 | 结果 |
|---|---|---|---|---|
| TC-17 启动链路 | FR-ver-107 | 日志无 sqlite/PTY 崩溃/白屏 | 无致命错误 | ⏭ SKIP-无设备（host 冒烟 TC-07 部分覆盖） |
| TC-18 shell 插件覆盖 | U2 | host `test-harmony-plugins`：插件名 `shell` 覆盖内置 | 工具名 `shell`，哨兵/超时自愈正常 | ⬜（host 可验） |
| TC-19 PTY 仍不可得 | U3 | 0003 桩 `available=false` | 终端面板不投放 | ⬜（源码/构建可验） |

## 6. 敏感信息扫描用例

| 用例 | 关联 | 步骤 | 期望 | 结果 |
|---|---|---|---|---|
| TC-20 暂存区扫描 | AC-08 | `git diff --staged` 逐文件复查 | 无 Key/账号/密码明文 | ⬜ |
| TC-21 全库扫描 | AC-08 | 对新增/变更文件 grep 敏感串 | 零命中 | ⬜ |
| TC-22 opencode 树恢复 | D11 | `git -C ../opencode status --porcelain` | 构建后工作树干净 | ⬜ |
