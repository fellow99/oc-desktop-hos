# 011 — 版本更新：2.1.2 测试用例

> **回引:** `spec.md` §5 ｜ **执行落点:** `logs/20261022-1/TEST_CHECKLIST.md` / `TEST_REPORT.md`
> **敏感信息纪律:** 模型 Key 与 GIT 账号/密码**只在运行时输入**，本文档与一切产出物中一律占位（`<API_KEY>` / `<USER>` / `<PASSWORD>`）。

## 1. 环境

| 项 | 值（执行时填写实测值） |
|---|---|
| 设备序列号 | `3QC0226526001227`（`hdc list targets`） |
| 设备型号 / 系统 / API | ⬜ 执行时记录 |
| 设备类型 | 2in1 / tablet |
| HAP 版本 | `2.1.2` / `20102` |
| 上游基线 | opencode `v2.1.2` / `a517687fde` |
| 运行期 | Electron 37.2.3 / Node 22.17.0 / ABI v138 |

## 2. 静态与构建用例

| 用例 | 关联 | 步骤 | 期望 | 结果 |
|---|---|---|---|---|
| TC-01 清理不伤已跟踪文件 | AC-01 | `git status --porcelain` | 无 ` D ` 行；源码/配置/文档完好 | ⬜ |
| TC-02 版本号 | AC-02 | 读 `AppScope/app.json5` | `2.1.2` / `20102` | ⬜ |
| TC-03 补丁正向 | AC-04 | `patches/v2.1.2/*.patch` 逐条 `git apply --check` | 全部通过 | ⬜ |
| TC-04 补丁反向 | AC-04 | 应用后逐条 `git apply --reverse --check` | 全部通过 | ⬜ |
| TC-05 守卫自洽 | AC-05 | `scripts/build-opencode.mjs` 基线/版本常量 | `a517687fde` / `2.1.2` / `patches/v2.1.2` | ⬜ |
| TC-06 运行时守卫 | AC-05 | `node scripts/collect-runtime.mjs` | 阶段 10 守卫全绿 | ⬜ |
| TC-07 host 冒烟 | AC-05 | `node scripts/build-opencode.mjs`（末段冒烟） | 8 项全绿 | ⬜ |
| TC-08 HAP 产出与版本 | AC-02/06 | 构建输出 + 解包读版本 | `electron-default-signed.hap`，`2.1.2`/`20102` | ⬜ |
| TC-09 插件语义测试 | AC-05 | `node scripts/test-harmony-plugins.mjs` | 全绿 | ⬜ |

## 3. 真机基本功能用例

| 用例 | 关联 | 步骤 | 期望 | 结果 |
|---|---|---|---|---|
| TC-10 安装启动就绪 | AC-07 | 卸载 → 安装 → `aa start` | 界面加载，非白屏 | ⬜ |
| TC-11 模型配置 | FR-ver-107 | 设置页输入 DeepSeek API Key（`<API_KEY>`，运行时键入） | Key 保存成功，模型列表可选 `deepseek-flash` | ⬜ |
| TC-12 工作区 | FR-ver-107 | 新建工作区（沙箱内新建测试目录） | 目录创建成功并成为当前工作区 | ⬜ |
| TC-13 一次对话 | FR-ver-107 | 发送一条问候消息 | 助手正常回复（SSE 流式） | ⬜ |
| TC-14 图片分析对话 | FR-ver-107 | 发送一张图片并要求描述 | 助手基于图片内容回复 | ⬜ |

## 4. GIT 仓库操作用例（对应需求「无账号 / 带账号 GIT」）

> 凭证纪律：带账号仓库的 `<USER>` / `<PASSWORD>` 仅在应用 Git 凭据页运行时输入；用例结束后**删除凭据条目**。

| 用例 | 关联 | 步骤 | 期望 | 结果 |
|---|---|---|---|---|
| TC-15 无账号 clone | FR-ver-107 | 工作区内 clone `https://github.com/fellow99/pi-desktop-website.git` | clone 成功，`git log` 可读 | ⬜ |
| TC-16 无账号常用操作 | FR-ver-107 | 在该仓库内 `status` / `branch` / `diff` / `log` | 输出正常，无鉴权报错 | ⬜ |
| TC-17 带账号凭据保存 | FR-ver-107/108 | 设置 → Git 凭据页，录入 `<USER>` / `<PASSWORD>`（http 仓库 `gjgit.pcitech.com:8080` 的 force_test.git） | 条目保存成功；口令只显示长度 | ⬜ |
| TC-18 带账号 clone/pull | FR-ver-107 | 用已存凭据 clone / pull 该私有仓库 | 成功，无 401 | ⬜ |
| TC-19 带账号 commit/push | FR-ver-107 | 新建测试分支做一次提交并推送 | push 成功；远端可见 | ⬜ |
| TC-20 凭据清理 | FR-ver-108 | 删除 TC-17 保存的凭据条目 | 条目移除；凭据文件中无残留 | ⬜ |

## 5. 环境能力抽查用例（回归 `docs/鸿蒙环境能力清单-v2.0.26.md`）

| 用例 | 关联 | 步骤 | 期望 | 结果 |
|---|---|---|---|---|
| TC-21 启动链路 | AC-07 | 启动日志检查 | 无 `No such binding: sqlite` / PTY 崩溃 / 白屏 | ⬜ |
| TC-22 数据库 | AC-07 | 对话后检查 `<filesDir>/data/opencode/opencode.db` | WAL 模式读写正常 | ⬜ |
| TC-23 网络与 fetch | FR-ver-107 | TC-13 对话本身即网络用例 | 模型 API 可达 | ⬜ |
| TC-24 剪贴板/文件系域能力抽查 | FR-ver-107 | 应用域读写工作区文件 | 正常 | ⬜ |

## 6. 敏感信息扫描用例

| 用例 | 关联 | 步骤 | 期望 | 结果 |
|---|---|---|---|---|
| TC-25 暂存区扫描 | AC-09 | `git diff --staged` 逐文件复查 | 无 Key/账号/密码明文 | ⬜ |
| TC-26 全库扫描 | AC-09 | 对新增/变更文件 grep 敏感串（Key 前缀、密码字面量） | 零命中 | ⬜ |
| TC-27 设备侧清理 | AC-09 | 确认凭据页条目已删除 | 无残留 | ⬜ |
