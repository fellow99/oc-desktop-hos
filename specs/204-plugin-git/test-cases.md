# 204-plugin-git 测试用例

> **Module:** 204-plugin-git ｜ 对应规格：[spec.md](./spec.md) ｜ 对应方案：[plan.md](./plan.md) ｜ **Last Updated:** 2026-10-17
>
> **凭据纪律（硬性）**：本文件与任何日志、报告**不得**出现真实仓库地址、主机名、账号、口令或 API Key。
> 一律使用占位符：`<公开仓库地址>`、`<内网 GIT 主机>:<端口>`、`<内网仓库路径>`、`<用户名>`、`<口令>`、`<DEEPSEEK_API_KEY>`、`<设备 SN>`。
> 操作清单语义见 [`docs/204-插件-GIT.md`](../../docs/204-插件-GIT.md) §18（AN / AR / AW 编号）。

## 0. 测试环境与前置

| 项 | 值 |
|---|---|
| 设备 | 真机（`hdc target <设备 SN>`），2-in-1 / PC 模式 |
| 应用 | `org.fellow99.oc.OCDesktop`（`versionCode 20026`），debug 签名 HAP |
| 宿主形态 | `OCR_HOST_MODE=inprocess`（默认） |
| 渲染通道 | `OCR_RENDER_MODE=chromium`（默认） |
| 关键路径 | `<userData>` = `/data/storage/el2/base/files`；沙箱工作区 `<userData>/workspace`；凭据文件 `<userData>/.git-credentials`；插件物化点 `<userData>/config/opencode/plugin/oc-plugin-git/` |
| 调试通道 | `--inspect`（debug 构建）+ `hdc fport tcp:19229 tcp:9229` + CDP `Runtime.evaluate` |
| 前置 | ① `collect-runtime` → `build-opencode` → `collect-app` → `build-debug` 全绿并安装；② 应用内输入 `<DEEPSEEK_API_KEY>`；③ 已创建一个工作区（沙箱或用户目录） |

## 1. 构建期用例

### TC-B1 — 插件投放与静态断言

| 项 | 内容 |
|---|---|
| 目的 | 确认插件被投放且通过准入断言 |
| 步骤 | `node scripts/collect-app.mjs --check-only` |
| 期望 | `oc-plugin-git` 被识别；静态断言通过（无 PTY / 无 `spawn` / 无 `.node` / 无 `exec` 家族）；`node --check`（CJS + ESM 双检）通过 |
| 失败含义 | FR-204-042 违例（第三方依赖误落源目录，或源码引入禁用调用） |

### TC-B2 — 21 项工具元数据

| 项 | 内容 |
|---|---|
| 目的 | 确认工具表与规格一致（多一个/少一个都失败） |
| 步骤 | 同上（`assertToolMetadata` 阶段） |
| 期望 | 输出 `oc-plugin-git → [21 个 git_* 工具]`；名称、`description`、`input`、`execute` 齐备；用户可见文案无禁用词 |
| 覆盖 | FR-204-002、FR-204-041 |

### TC-B3 — 依赖物化与产物断言

| 项 | 内容 |
|---|---|
| 目的 | 确认 `collectPluginRuntime()` 正确落位并可重复执行 |
| 步骤 | ① `node scripts/collect-app.mjs`；② 再执行一次（观察快路径）；③ `node scripts/collect-app.mjs --force-plugin-runtime` |
| 期望 | ① `resfile/.../plugins/oc-plugin-git/node_modules/{isomorphic-git,diff}` 在位；`isomorphic-git/package.json` 版本 = `1.44.2`、`diff` = `9.0.0`；`isomorphic-git/http/node.js` 存在；包数 56；体积 ≤ 12 MB；无 `.node`/`.so`。② 输出「已存在，跳过」。③ 重建并再次断言通过 |
| 覆盖 | FR-204-040、NFR-204-002 |

### TC-B4 — 补丁幂等与往返

| 项 | 内容 |
|---|---|
| 目的 | 确认 0008 补丁可应用、可反向 |
| 步骤 | ① 未应用时 `git -C ../opencode apply --check patches/v2.0.26/0008-git-credentials-settings.patch`；② 应用后 `git -C ../opencode apply --reverse --check` 同一补丁；③ 连续两次 `build-opencode` 阶段① |
| 期望 | ①②③ 均成功；第二次输出「已应用，跳过」 |
| 覆盖 | FR-204-024、T26 |

### TC-B5 — 上游 UI 重建与品牌化断言

| 项 | 内容 |
|---|---|
| 目的 | 确认补丁进入产物且品牌化 37 项断言全绿 |
| 步骤 | `node scripts/build-opencode.mjs`；观察 `verify-branding` 输出 |
| 期望 | `vite build` 成功；归档重建；断言全绿（引用点漂移即硬失败，**不得绕过**） |
| 覆盖 | AC-15 |

### TC-B6 — host 侧门禁脚本

| 项 | 内容 |
|---|---|
| 目的 | 真实跑一次 git 最小链（不联网） |
| 步骤 | `node scripts/verify-git-plugin.mjs` |
| 期望 | 单测全绿 + 临时目录 `init → add → commit → status → log → diff` 全部成功；退出码 0 |
| 覆盖 | AC-13、T22 |

## 2. 单元用例（`node --test plugins/oc-plugin-git/tests/`）

| 编号 | 用例 | 期望 | 覆盖 |
|---|---|---|---|
| TC-U1 | 凭据文件缺省路径 | `HOME` 存在时解析为 `<HOME>/.git-credentials` | FR-204-020 |
| TC-U2 | 解析容忍 | 空行 / `#` 注释 / 非 URL / 无 userinfo 行被跳过，不抛错 | FR-204-021 |
| TC-U3 | 百分号编码往返 | 口令含 `:` `@` `/` 时写入后可原样读回 | FR-204-021 |
| TC-U4 | 匹配优先级 | 协议 + host 必须一致；带路径行优先；同分时靠后者胜 | FR-204-021 |
| TC-U5 | 写入语义 | 同 `协议+host+用户名` 替换、异用户名新增；其它行与注释保留 | FR-204-021 |
| TC-U6 | 权限 | 写入后 `mode & 0o777 === 0o600`（Windows 跳过权限断言） | FR-204-020 |
| TC-U7 | 删除语义 | 只删匹配行；删空则文件消失；缺文件读作「无凭据」不抛错 | FR-204-021 |
| TC-U8 | chroot 拒绝 | `../x`、绝对路径、根外路径一律拒绝且未触达 `node:fs` | FR-204-010/011 |
| TC-U9 | 适配器全 async | 每个方法 `constructor.name === 'AsyncFunction'`；无参调用返回 rejected Promise（复刻 `isPromiseFs` 探测） | FR-204-012 |
| TC-U10 | diff 渲染 | 文本产出 `---`/`+++`/`@@`；含 NUL 判二进制并输出 `Binary files … differ`；超限截断标注 | FR-204-005、NFR-204-006 |
| TC-U11 | status 分组 | `statusMatrix` 正确映射 staged / modified / deleted / untracked | FR-204-002 |
| TC-U12 | revert 冲突判定 | 工作区别叉时拒绝并列出冲突路径 | FR-204-005、场景 12 |

## 3. 真机 `--inspect` 用例

### TC-I1 — 插件在役与诊断行

| 项 | 内容 |
|---|---|
| 步骤 | `hdc fport tcp:19229 tcp:9229`；CDP `Runtime.evaluate` 取 `/api/plugin`（主进程内 `fetch`） |
| 期望 | 清单含 `oc-harmony-git`，`status` 非 `failed`/`pending`；hilog 出现 `[oc-desktop] plugin oc-harmony-git: tools=21 vcsProvider=git(override) credentials=<path>` |
| 覆盖 | AC-1、FR-204-032 |

### TC-I2 — 凭据文件形态

| 项 | 内容 |
|---|---|
| 步骤 | CDP 在应用进程内 `stat` + 读取 `<userData>/.git-credentials`（只输出结构与非空长度） |
| 期望 | 存在、`mode=600`、条目数 = 页面保存条数；行形为 `<协议>://<user>:<pass>@<host>[:port]` |
| 覆盖 | AC-3、FR-204-020 |

### TC-I3 — 工具表可见

| 项 | 内容 |
|---|---|
| 步骤 | 会话内让模型列出可用工具（或经 RPC/会话工具表读取） |
| 期望 | 21 个 `git_*` 全部可见，无重复、无遮蔽 |
| 覆盖 | AC-2 |

### TC-I4 — VCS provider 生效

| 项 | 内容 |
|---|---|
| 步骤 | 在含 `.git` 的工作区打开会话/差异视图；同时采集 hilog |
| 期望 | 界面显示当前分支与文件变更/差异；hilog 无 `worktree discovery failed … strategy=git`（或该失败不再影响本工作区） |
| 覆盖 | AC-6、FR-204-030/031 |

### TC-I5 — 依赖装载状态

| 项 | 内容 |
|---|---|
| 步骤 | 首次调用任一 `git_*` 工具前后各观察一次时间与日志 |
| 期望 | 首次调用发生懒加载（NFR-204-001），后续调用无重复装载；版本不符时报「git 运行时缺失（期望 1.44.2）」 |
| 覆盖 | FR-204-045 |

## 4. 凭据页 UI 用例

| 编号 | 用例 | 步骤 | 期望 | 覆盖 |
|---|---|---|---|---|
| TC-UI1 | 页面出现 | 打开设置 | 「Git」Tab 存在且可进入；显示凭据文件绝对路径 | FR-204-024 |
| TC-UI2 | 保存 | 填 `<协议>` / `<内网 GIT 主机>:<端口>` / `<用户名>` / `<口令>` → 保存 | 提示已保存；列表出现「主机 + 用户名 + 已配置（长度 N）」；**口令不回显** | AC-3、FR-204-023/024 |
| TC-UI3 | 落盘 | 见 TC-I2 | 文件出现对应行且 `0600` | FR-204-020 |
| TC-UI4 | 删除 | 删除该条 | 列表消失；文件对应行消失；其余条目不变 | FR-204-021 |
| TC-UI5 | 回显纪律 | 重新进入页面 / 刷新 | 只显示长度，口令与任何可逆信息都不出现 | FR-204-025 |
| TC-UI6 | 自门控 | 停用插件（或非本壳部署）后打开设置 | 「Git」Tab 不出现；导航/路由与上游一致；无错误弹窗 | 场景 9、FR-204-024 |
| TC-UI7 | 非法输入 | 空主机 / 空用户名 / 空口令 | 返回可读 `code`（`invalid-host` / `invalid-username` / `invalid-password`），不写文件 | FR-204-023 |

## 5. 操作用例（对话驱动）

### 5.1 无账号仓库（映射 §18.1）

| 编号 | 用例 | 期望（关键证据） |
|---|---|---|
| TC-AN-1 | 远端 refs 探测 | 列出服务端分支数 |
| TC-AN-2 | 浅克隆到工作区 | 成功；目录出现；`status` 干净或如实列出 |
| TC-AN-3 | 历史 / 单提交 | 提交列表与元信息+变更清单 |
| TC-AN-4 | 制造改动 → diff | unified diff（含 `@@`）；二进制如实标记 |
| TC-AN-5 | add / commit | 生成提交；作者身份正确 |
| TC-AN-6 | branch / checkout | 列表正确；切换后 `currentBranch` 正确 |
| TC-AN-7 | fetch / pull | 成功或「已是最新」 |
| TC-AN-8 | 本地 merge | 成功；冲突时报路径且工作区未污染 |
| TC-AN-9 | stash push/list/pop | 收起并可恢复 |
| TC-AN-10 | tag 创建/列出/删除 | 三动作成功（本地） |
| TC-AN-11 | reset soft/mixed/hard | 三模式行为正确 |
| TC-AN-12 | cherry-pick + revert | 均成功；revert 与原提交互为逆 |
| TC-AN-13 | push（无凭据） | **预期失败**，报「未配置凭据 + 主机 + 文件路径」 |
| TC-AN-14 | init 空仓库 | 生成 `.git`，默认分支正确 |
| TC-AN-15 | remote 增删 | 可见/消失 |
| TC-AN-16 | config 设身份 | 写入仓库本地并回读一致 |
| TC-AN-17 | 新仓库首次提交 | 作者身份与 TC-AN-16 一致 |
| TC-AN-18 | VCS 界面 | 分支与变更/差异可见（AC-6） |

> **网络前提**：若 `<公开仓库地址>` 在设备网络下不可达（超时），按 D4 换可达等价仓库继续，并在报告记「原地址不可达 + 替代地址 + 时间」，**不记为插件缺陷**。

### 5.2 带账号仓库（映射 §18.2）

| 编号 | 用例 | 期望 | 副作用 |
|---|---|---|---|
| TC-AR-1 | refs 探测（认证） | 列出服务端分支 | 无 |
| TC-AR-2 | clone | 成功 | 无 |
| TC-AR-3 | status/log/diff/show | 均成功 | 无 |
| TC-AR-4 | fetch | 成功 | 无 |
| TC-AR-5 | pull（默认分支） | 成功或「已是最新」 | 无 |
| TC-AR-6 | 分支列举（本地+远端） | 正确 | 无 |
| TC-AW-1 | 新建测试分支 `204-plugin-git-test` | 成功 | 无（本地） |
| TC-AW-2 | 新增说明文件并提交 | 成功 | 无（本地） |
| TC-AW-3 | 推送测试分支 | 成功 | **远端新增分支** |
| TC-AW-4 | 附注标签 + 推送 | 成功 | **远端新增标签** |
| TC-AW-5 | 默认分支 pull → 提交 → 推送（**评审已裁决执行**） | 成功 | **⚠️ 共享仓库默认分支新增提交，不可回滚**（执行前当轮点名 + 给回滚说明） |
| TC-AW-6 | 删除远端测试分支（收尾，放最后） | 成功；被服务端策略拒绝则逐字上报 | **远端分支被删** |

## 6. 负例用例

| 编号 | 用例 | 期望 |
|---|---|---|
| TC-N1 | 缺凭据访问带账号主机 | 报「未配置凭据」+ 主机 + 设置入口 + 文件路径 + 可照抄占位行；**非裸 401/404** |
| TC-N2 | 错误口令 | 报「凭据被拒绝」+ 主机；最多重试 1 次；无无限重试 |
| TC-N3 | 围栏：`dir: "../.."` / 绝对路径 / 项目根外 | 拒绝并说明；目标位置**未被创建** |
| TC-N4 | `rebase` 请求 | 明确「本平台不支持」，不静默用 merge 冒充 |
| TC-N5 | `revert` 工作区分叉 | 拒绝并列出冲突路径；用户改动未被覆盖 |
| TC-N6 | 目标目录不是仓库 | 报「不是 git 仓库」并给 `git_init`/`git_clone` 建议；不静默创建 |
| TC-N7 | 远端拒绝推送（如服务端 hook） | 原样上报服务端答复；不自动 force |

## 7. 合规与回归

| 编号 | 用例 | 步骤 | 期望 |
|---|---|---|---|
| TC-C1 | 明文四载体检索 | 检索对话记录、`hilog -x`、`<userData>/config/opencode/**`、仓库 diff | 只出现主机名 / `GIT` 相关标识，**无口令明文** |
| TC-C2 | 品牌化断言 | `node scripts/verify-branding.mjs` | 全绿 |
| TC-C3 | 基本功能回归 | 设置 `<DEEPSEEK_API_KEY>` → 创建工作区 → 一次真实对话 | 正常完成，不被本模块影响 |
| TC-C4 | 既有插件回归 | `shell` / `grep` / `glob` / `workspace-roots` 各跑一次 | 行为不变 |
| TC-C5 | 文档与索引一致 | 检查 `specs/README.md` 204 行、`plugins/README.md` §7 行、能力清单 G9 | 三处与实现一致 |
