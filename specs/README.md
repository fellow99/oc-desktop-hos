# specs/ —— OC Desktop · Electron on HarmonyOS Edition 规格索引

> **工程：** `oc-desktop-hos`（Electron 37 / Node 22.17 / Chromium 138）
> **版本：** 2.2.5 / `versionCode 20205`
> **上游基线：** opencode **v2.2.5**（`9bbb8ce18c` / `Branch_v2.2.5`）
> **方法：** `specs-as-built` —— 以源码、构建脚本与真机证据为事实源；`spec.md` 写做什么/判据，`plan.md` 写怎么做/落点。
> **父规范：** [`../../specs/constitution.md`](../../specs/constitution.md)（编号与文档分工）、[`../../specs/013-branding/`](../../specs/013-branding/)、[`../../specs/012-building-workflow/`](../../specs/012-building-workflow/)。
> **最后更新：** 2026-11-01（按父宪法重排编号：`0XX` 公共、`1XX` 基础、`2XX` 插件）

---

## 一、文档总览

| 层级 | 分类 | 文档数量 | 说明 |
|---|---|---|---|
| 公共 | `011` 版本更新 | 3 个版本四件套 | v2.0.26 / v2.1.2 / v2.2.5 |
| 公共 | `013` 品牌化 | 4 | spec / plan / tasks / test-cases |
| 基础 | `101–115` | 20（10 模块 × spec+plan） | 运行时、载荷、渲染、鉴权、签名、生命周期、构建、UI 加载、工作区、数据 |
| 插件 | `201–207` | 12+ | 插件运行时、技能、工作区、Git、JS 工具、shell |
| **合计** | **20 个模块目录** | **+ README** | 不含可选 tasks/test-cases |

> 本工程无独立 `API.md` / `overall-api.md`；API 契约以上游 `/api/*` 为准。

---

## 二、公共模块（`0XX`）

### 011 — 版本更新（Version）

| 版本 | 目录 | 文档 | 状态 |
|---|---|---|---|
| v2.0.26 | [011-version-2.0.26/](./011-version-2.0.26/) | spec / plan / tasks / test-cases | ✅ 历史锚点 |
| v2.1.2 | [011-version-2.1.2/](./011-version-2.1.2/) | spec / plan / tasks / test-cases | ✅ 历史锚点 |
| v2.2.5 | [011-version-2.2.5/](./011-version-2.2.5/) | spec / plan / tasks / test-cases | ✅ 当前；真机待补 `⬜` |

### 013 — 品牌化（Branding）

> 从原 `103-branding` 迁移；构建期改归档 title/字标/PWA + 37 项守卫。

| 文档 | 链接 | 说明 |
|---|---|---|
| 功能规格 | [013-branding/spec.md](./013-branding/spec.md) | 应用名/UI 标题/图标/非官方声明/守卫 |
| 技术方案 | [013-branding/plan.md](./013-branding/plan.md) | `branding.mjs`、`verify-branding.mjs`、物料链路 |
| 任务清单 | [013-branding/tasks.md](./013-branding/tasks.md) | 落地任务 |
| 测试用例 | [013-branding/test-cases.md](./013-branding/test-cases.md) | 品牌断言用例 |

> **012-building-workflow：鸿蒙工程暂无**云端 tag 发布工作流；本工程构建见 [`112-build-pipeline`](./112-build-pipeline/)。父工程公共规格见 [`../../specs/012-building-workflow/`](../../specs/012-building-workflow/)。

---

## 三、基础功能模块（`1XX`）

### 101 — 运行时宿主（Runtime Host）

> 宿主形态定标（进程内 / utility / worker 三候选）、服务端进程模型、统一宿主契约。

| 文档 | 链接 | 说明 |
|---|---|---|
| 功能规格 | [101-runtime-host/spec.md](./101-runtime-host/spec.md) | 宿主契约、候选、定标结论落点 |
| 技术方案 | [101-runtime-host/plan.md](./101-runtime-host/plan.md) | 候选实现、探针、错误与退出 |

### 102 — 产物就位（Artifact Bootstrap）

> HAP 内 `opencode-dist.tar.gz` 首启流式解压到 `<userData>/opencode-dist/`；SHA-256 marker 幂等。

| 文档 | 链接 | 说明 |
|---|---|---|
| 功能规格 | [102-artifact-bootstrap/spec.md](./102-artifact-bootstrap/spec.md) | 产物形态、完整性、幂等、升级 |
| 技术方案 | [102-artifact-bootstrap/plan.md](./102-artifact-bootstrap/plan.md) | 流式解压、marker、旧产物清理 |

### 103 — 渲染通道（Render Channel）

> R2（ArkWeb，目标）/ R1（Chromium，回退）的选通道、URL 构造、loading、探针。

| 文档 | 链接 | 说明 |
|---|---|---|
| 功能规格 | [103-render-channel/spec.md](./103-render-channel/spec.md) | 通道选择、首屏、失败可见、外链 |
| 技术方案 | [103-render-channel/plan.md](./103-render-channel/plan.md) | Web 组件/BrowserWindow、P0-2 探针 |

### 105 — 请求头与凭据钩子（Request Hooks）

> `OPENCODE_PASSWORD` 注入、`Host`/`Origin` 改写、Basic 注入、`NO_PROXY`、日志脱敏。

| 文档 | 链接 | 说明 |
|---|---|---|
| 功能规格 | [105-request-hooks/spec.md](./105-request-hooks/spec.md) | 凭据注入、头改写、安全边界 |
| 技术方案 | [105-request-hooks/plan.md](./105-request-hooks/plan.md) | 密码句柄、钩子安装、健康检查凭据 |

### 108 — 签名与应用身份（Signing Identity）

> bundleName / AppScope、debug/release 签名材料内存注入、`versionCode`、三处显示名同步。

| 文档 | 链接 | 说明 |
|---|---|---|
| 功能规格 | [108-signing-identity/spec.md](./108-signing-identity/spec.md) | 身份、签名、版本、ACL 归属 |
| 技术方案 | [108-signing-identity/plan.md](./108-signing-identity/plan.md) | `hvigorfile.ts` 注入、守卫、三处同步 |

### 111 — 生命周期（Lifecycle）

> 环境装配、`env → artifact → host → health → load` 五阶段、失败可见、退出清理。

| 文档 | 链接 | 说明 |
|---|---|---|
| 功能规格 | [111-lifecycle/spec.md](./111-lifecycle/spec.md) | 阶段、失败态、退出、单实例 |
| 技术方案 | [111-lifecycle/plan.md](./111-lifecycle/plan.md) | 状态机、环境变量单一来源、退出钩子 |

### 112 — 构建流水线（Build Pipeline）

> 四阶段：collect-runtime / build-opencode / collect-app / hvigor 构建签名；host 冒烟门禁。

| 文档 | 链接 | 说明 |
|---|---|---|
| 功能规格 | [112-build-pipeline/spec.md](./112-build-pipeline/spec.md) | 阶段、幂等、门禁、产物 |
| 技术方案 | [112-build-pipeline/plan.md](./112-build-pipeline/plan.md) | 脚本契约、守卫、签名注入 |

### 113 — 服务端与 UI 加载（Server UI Load）

> stock CLI bundle 的 `serve` argv/env、健康检查、UI 同源加载、就绪判定。

| 文档 | 链接 | 说明 |
|---|---|---|
| 功能规格 | [113-server-ui-load/spec.md](./113-server-ui-load/spec.md) | 启动契约、就绪、CSP、单实例 |
| 技术方案 | [113-server-ui-load/plan.md](./113-server-ui-load/plan.md) | argv/env、`/api/info`、UI 归档 |

### 114 — 工作区选择与授权（Workspace Auth）

> 项目目录选择、`fileShare.activatePermission`、真实路径、每次启动重申、路径围栏同源。

| 文档 | 链接 | 说明 |
|---|---|---|
| 功能规格 | [114-workspace-auth/spec.md](./114-workspace-auth/spec.md) | 目录授权、权限面、项目根传递 |
| 技术方案 | [114-workspace-auth/plan.md](./114-workspace-auth/plan.md) | Picker、权限、真实路径、与 shell 围栏 |

### 115 — 数据目录与持久化（Data Dirs / SQLite）

> `HOME` / `XDG_*` / `TMPDIR` / `os.tmpdir()` patch；better-sqlite3 持久化。

| 文档 | 链接 | 说明 |
|---|---|---|
| 功能规格 | [115-data-dirs-sqlite/spec.md](./115-data-dirs-sqlite/spec.md) | 目录映射、落盘、WAL、重启可读 |
| 技术方案 | [115-data-dirs-sqlite/plan.md](./115-data-dirs-sqlite/plan.md) | 环境装配、sqlite 物化、NULL 兜底 |

---

## 四、补丁 / 插件模块（`2XX`）

### 201 — 插件运行时（Plugin Runtime）

> 插件机制与三档降级（L0 关闭 / L1 仅本地 / L2 允许安装）、物化路径与校验。

| 文档 | 链接 | 说明 |
|---|---|---|
| 功能规格 | [201-plugin-runtime/spec.md](./201-plugin-runtime/spec.md) | 档位、发现、加载、治理 |
| 技术方案 | [201-plugin-runtime/plan.md](./201-plugin-runtime/plan.md) | 物化、校验、降级 |

### 202 — 壳专用技能与能力清单（Skill Runtime）

> `skills/` 树投放、能力清单规范源、技能与规范源单向派生。

| 文档 | 链接 | 说明 |
|---|---|---|
| 功能规格 | [202-skill-runtime-capabilities/spec.md](./202-skill-runtime-capabilities/spec.md) | 技能内容、能力口径 |
| 技术方案 | [202-skill-runtime-capabilities/plan.md](./202-skill-runtime-capabilities/plan.md) | 投放、校验 |

### 203 — 工作区选择器插件（Workspace Picker）

> 四主目录（沙箱/桌面/文档/下载）切换、逐级浏览、新建文件夹；插件 RPC + 最小上游补丁。

| 文档 | 链接 | 说明 |
|---|---|---|
| 功能规格 | [203-plugin-workspace-picker/spec.md](./203-plugin-workspace-picker/spec.md) | 四根、浏览围栏、权限门、回退 |
| 技术方案 | [203-plugin-workspace-picker/plan.md](./203-plugin-workspace-picker/plan.md) | 插件 RPC、补丁 0007、状态机 |
| 任务清单 | [203-plugin-workspace-picker/tasks.md](./203-plugin-workspace-picker/tasks.md) | T1–T6 |
| 测试用例 | [203-plugin-workspace-picker/test-cases.md](./203-plugin-workspace-picker/test-cases.md) | TC-203-* |

### 204 — Git 插件（Git Plugin）

> isomorphic-git 嵌入；21 个 `git_*` 工具、VCS provider 覆盖、凭据设置页。

| 文档 | 链接 | 说明 |
|---|---|---|
| 功能规格 | [204-plugin-git/spec.md](./204-plugin-git/spec.md) | 工具表、凭据、VCS、L1 |
| 技术方案 | [204-plugin-git/plan.md](./204-plugin-git/plan.md) | 引擎版本、RPC id、物化、风险 |
| 任务清单 | [204-plugin-git/tasks.md](./204-plugin-git/tasks.md) | 落地任务 |
| 测试用例 | [204-plugin-git/test-cases.md](./204-plugin-git/test-cases.md) | 插件用例 |

### 206 — 鸿蒙 JS 工具（JS Tools）

> 用纯 JS 插件替代设备上不可得的工具能力（grep/glob 等）；从原 `102-harmony-js-tools` 迁移。

| 文档 | 链接 | 说明 |
|---|---|---|
| 功能规格 | [206-js-tools/spec.md](./206-js-tools/spec.md) | 工具面、上限、跳过、降级 |
| 技术方案 | [206-js-tools/plan.md](./206-js-tools/plan.md) | 插件实现、匹配、上限 |
| 任务清单 | [206-js-tools/tasks.md](./206-js-tools/tasks.md) | 落地任务 |
| 测试用例 | [206-js-tools/test-cases.md](./206-js-tools/test-cases.md) | 117 用例口径 |

### 207 — 纯 JS shell 工具插件（Shell Plugin）

> 常驻 `/system/bin/sh` + 随机哨兵、路径围栏（fail-closed）、超时/取消；从原 `010-tool-shell` 迁移。

| 文档 | 链接 | 说明 |
|---|---|---|
| 功能规格 | [207-plugin-shell/spec.md](./207-plugin-shell/spec.md) | shell 语义、围栏、超时、错误 |
| 技术方案 | [207-plugin-shell/plan.md](./207-plugin-shell/plan.md) | 常驻 shell、哨兵协议、围栏 |

---

## 五、编号迁移表

| 旧编号 | 新编号 | 说明 |
|---|---|---|
| `001-render-channel` | `103-render-channel` | 渲染通道 → 基础 1XX |
| `002-lifecycle` | `111-lifecycle` | 生命周期 |
| `003-artifact-bootstrap` | `102-artifact-bootstrap` | 产物就位 |
| `004-request-hooks` | `105-request-hooks` | 凭据钩子 |
| `005-build-pipeline` | `112-build-pipeline` | 构建流水线 |
| `006-signing-identity` | `108-signing-identity` | 签名身份 |
| `007-runtime-host` | `101-runtime-host` | 运行时宿主 |
| `008-server-ui-load` | `113-server-ui-load` | 服务端/UI 加载 |
| `010-tool-shell` | `207-plugin-shell` | shell 插件 |
| `011-workspace-auth` | `114-workspace-auth` | 工作区授权 |
| `012-data-dirs-sqlite` | `115-data-dirs-sqlite` | 数据/持久化 |
| `101-version-*` | `011-version-*` | 公共版本模块 |
| `102-harmony-js-tools` | `206-js-tools` | JS 工具插件 |
| `103-branding` | `013-branding` | 公共品牌模块 |

---

## 六、编写约定

1. `spec.md` 与 `plan.md` 必须成对；`spec.md` 技术无关，`plan.md` 技术具体。
2. FR 编号格式 `FR-<模块编号>-<三位序号>`；模块编号取目录三位编号。
3. 事实性断言必须带证据标记：`✅ 实测` / `🔶 沿用` / `⬜ 待验证` / `⚠️ 冲突`。
4. 上游基线统一写 `opencode v2.2.5（Branch_v2.2.5）`；历史版本在 `011-version-*` 中保留。
5. 不在规格中写真实凭据；示例用 `<DEEPSEEK_API_KEY>` / `***`。
6. 新增模块按父宪法编号规则追加，不回填、不复用。

---

## 七、快速导航

| 目标读者 | 推荐顺序 |
|---|---|
| 新加入开发者 | `../../specs/constitution.md` → `101-runtime-host` → `102-artifact-bootstrap` → `103-render-channel` |
| Electron/宿主开发 | `101-runtime-host` → `111-lifecycle` → `113-server-ui-load` → `108-signing-identity` |
| 构建/发布 | `112-build-pipeline` → `../../specs/012-building-workflow/` → `011-version-2.2.5` |
| 插件开发 | `201-plugin-runtime` → `203` / `204` / `206` / `207` |
| 测试/合规 | `011-version-*` 真机记录 → `013-branding` → `../../specs/013-branding/` |
