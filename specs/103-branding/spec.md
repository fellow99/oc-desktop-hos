# 103 — 品牌化：OpenCode → OC Desktop / Logo / 图标 功能规格

> **Module:** branding ｜ **Status:** Implementing ｜ **Last Updated:** 2026-10-13
> **需求编号:** 103-branding ｜ **需求名称:** UI 品牌化与图标物料统一（需求「第二轮」）
> **git 分支:** 不改动 ｜ **上游基线:** opencode `v2.0.26`（`9b4ec5714d`）
> **物料来源:** **父工程** `../assets/`（本机 `D:\opencode-workspace\assets\`）—— `logo.png`（200²，含透明）、
> `logo.svg`（矢量）、`logo-1024-with-bg.png`（1024²，**完全不透明**）、`logo-200-with-bg.png`、`logo.ico`、`logo.icns`
> **参考实现:** `pi-desktop-hos` 的 `specs/103-branding/`（同型工程，已真机交付）

## 1. 目的

当前构建把上游 opencode 的品牌直接暴露给用户：窗口/浏览器标题是 `OpenCode`、页面元数据与 PWA manifest
是 `OpenCode`、favicon 与 apple-touch-icon 是上游图标、应用图标是**纯色占位图**。本需求把这一层收束到
本工程自己的品牌：

- 界面与元数据：用户看到的 **`OpenCode`** → **`OC Desktop`**；
- 页面 Logo 与**所有**图标位：统一用父工程 `assets/` 物料；
- 不回归既有能力（启动、会话、工具）。

## 2. 范围

**In scope**

- Web UI 产物的**构建期品牌化**：窗口/页面标题、PWA manifest 名、界面品牌文本、favicon / apple-touch-icon /
  PWA 图标 / 内联 Logo。
- HarmonyOS 包内图标物料的**构建期生成**：`AppScope/resources/base/media/*`（应用图标 / 启动图标 / 窗口图标 /
  产品图标）与 electron 模块实际投放的图标位。
- 壳侧显示名资源同步（`module_desc` 等仍写 `opencode` 的文案）。
- 文档同步：`README.md`、`docs/鸿蒙环境能力清单-v2.0.26.md` 的「图标为占位图」条目关闭。
- 构建、真机部署与验证（含负向用例）。

**Out of scope**

- **不改上游源码**：`../opencode` 工作树除既有 `patches/v2.0.26/` 的 4 条外**零改动**；本需求**不新增补丁**
  （品牌化在**本工程自己的产物**上做，见 §3 U4）。
- **不改技术标识符**：`@opencode/*` 包名、`opencode:*` 存储键、`opencode_session_*` cookie、
  `OPENCODE_*` 环境变量、SW 缓存前缀、API 路径、文件名。改了会破坏兼容与用户数据。
- **不改上游的服务名与法律声明**（见 §4 FR-brand-005 的保护清单）：`OpenCode Console` / `OpenCode Go` /
  `OpenCode Zen` / `OpenCode Free` 是上游**真实产品名**，`settings.about.trademark` 是上游**商标归属声明**；
  把它们改成本工程品牌属于事实错误与法律风险。
- **不改** `bundleName`（`org.fellow99.oc.OCDesktop`）。
- 不做 i18n 文案重写（除品牌名本身）；不做发布证书 / 上架材料。

## 3. 上游事实（本规格前提，已核实）

| # | 事实 | 出处 |
|---|---|---|
| U1 | 页面标题是**编译期内联**的静态 HTML：`packages/app/index.html` 的 `<title>OpenCode</title>`；favicon/apple-touch-icon 走 `%OPENCODE_FAVICON%` / `%OPENCODE_APPLE_TOUCH_ICON%` 占位符（由 `vite.icons.ts` 在构建期替换为 `/favicon.ico`、`/apple-touch-icon.png`） | `packages/app/index.html`、`packages/app/vite.icons.ts:48-49` |
| U2 | PWA 清单由 `packages/app/manifest.json` 生成 `dist/site.webmanifest`，`name` / `short_name` 均为 `OpenCode` | `packages/app/manifest.json`、`dist/site.webmanifest` |
| U3 | 界面内联 Logo 是 `src/providers/opencode-logo.tsx` 的 16×16 SVG（`data-component="opencode-logo"`），用在 models / settings 两处 | `packages/app/src/providers/opencode-logo.tsx`、`providers/models/provider-group.tsx:38,156`、`settings/providers/providers.tsx:468` |
| U4 | Web UI 产物 = `packages/app` 的 `bun run build` → `dist/` → 逐文件 brotli → **`AppArchive.encode`** 写入 `assets/app-archive.bin`。归档格式：`[u32LE 索引长度][JSON 索引 {key:[offset,len]}][各资源 brotli 体]` —— **可在本工程脚本内无损解码/重编码**，因此品牌化**不需要上游补丁** | `packages/cli/script/app-assets.ts`、`packages/cli/src/app-archive.ts:11-36` |
| U5 | 服务端加载 UI 只认 `$OPENCODE_NODE_ASSETS_DIR/app-archive.bin`（非 SEA）；**没有**任何环境变量/配置项可让服务端从静态目录读取 UI | `packages/cli/vite.node.config.ts:35-45`、`packages/cli/src/app-assets.ts:12` |
| U6 | `dist/` 内含 `OpenCode` 字面量的文件 5464 处，绝大多数是 ~60 个语言包的 i18n bundle（`_assets/<locale>-*.js`）；文本资产经 brotli 压缩 | 实测（`grep -ro OpenCode dist \| wc -l`） |
| U7 | 上游 `settings.about.trademark` = `OpenCode is a registered trademark of Anomaly Innovations, Inc.`；服务名出现在 `provider.connect.opencode.*` 等键 | `packages/app/src/runtime/i18n/en.ts:122-124,677-678` |
| U8 | 图标位实测：`AppScope/resources/base/media/` 有 5 个 PNG（`app_icon` 1024²、`icon` 512²、`startIcon` 512²、`window_icon` 512²、`product_logo_32` 32²），均为**纯色不透明**（`colorType=2`，无 alpha），由 `collect-runtime` 仅在缺失时生成 | `scripts/collect-runtime.mjs:177-185` 与实测 PNG IHDR |
| U9 | electron 模块的 `$media:app_icon` / `$media:startIcon` 由**运行时发行版**投放（`AppScope` 不被 `collect-runtime` 覆盖），`runtime-overlays/` 白名单只覆盖 `module.json5` 与三套 locale 的 `string.json` | `runtime-overlays/`、`scripts/collect-runtime.mjs:107-113` |
| U10 | 应用级图标要求 **1024×1024 且不带 alpha**（含 Alpha 会被应用市场驳回）；窗口/状态栏图标允许透明 | `scripts/collect-runtime.mjs:177`、`docs/工程规划-V2.md` §8.5 |
| U11 | 父工程物料实测：`logo.png` 200×200（含透明像素）、`logo.svg` 矢量、`logo-1024-with-bg.png` 1024×1024 **minAlpha=255（完全不透明）** | 实测 PNG IHDR + alpha 直方图 |
| U12 | 壳侧显示名已部分品牌化：`AppScope/resources/base/element/string.json` 的 `app_name` = `OC Desktop`；`EntryAbility_label` = `OC Desktop`；但 `module_desc` 仍为 `opencode 桌面端（HarmonyOS 版）` | `AppScope/.../string.json`、`electron/src/main/resources/*/string.json` |

## 4. 需求条目

### 4.1 文案与标题

- **FR-brand-001**（MUST）：**窗口/页面标题必须为 `OC Desktop`** —— 判据是**交付产物**中的
  `index.html` 的 `<title>` 为 `OC Desktop`，且真机上 `document.title` 读回 `OC Desktop`。
- **FR-brand-002**（MUST）：PWA manifest（`site.webmanifest`）的 `name` 与 `short_name` 必须为 `OC Desktop`。
- **FR-brand-003**（MUST）：界面中**引用本应用自身**的品牌文本必须为 `OC Desktop`；落地判据是
  **交付产物中「以本应用为指称」的 `OpenCode` 字面量为 0**（受保护清单除外，见 FR-brand-005）。
- **FR-brand-004**（MUST）：改名**必须**落在交付产物里（`app-archive.bin` 解码后可断言），而不是「源码里改了」。
- **FR-brand-005**（MUST NOT）：**不得**改动以下内容（保护清单，实现为可配置常量）：
  1. 技术标识符：`@opencode/*`、`opencode:`、`opencode_session_*`、`OPENCODE_*`、`opencode-*` 文件名、API 路径、
     `site.webmanifest` 的 `id`/`start_url`/`scope`、SW 缓存前缀；
  2. 上游**服务名**：`OpenCode Console`、`OpenCode Go`、`OpenCode Zen`、`OpenCode Free`（含其连接/登录文案）；
  3. 上游**法律声明**：`settings.about.trademark` 的商标归属句；
  4. URL：`www.opencode.ai` 等。
- **FR-brand-006**（MUST）：壳侧显示名资源必须与品牌一致（`AppScope` 与 `electron` 的 `string.json` 不得再以
  `opencode` 指称本应用）。

### 4.2 Logo 与图标物料

- **FR-brand-007**（MUST）：页面 Logo 的**两个引用点**都必须使用父工程物料（`assets/logo.svg` 优先），
  任一缺失即**构建失败**（不得静默留下上游图形）：
  - **§7.1 内联 Logo**：16×16 的 `opencode-logo` 组件位置（models / settings 两处）。
    判据：产物中该处不再出现上游 16×16 方框 path 数据，且出现物料 path 数据；
  - **§7.2 连接页矢量字标**：服务端配对/连接页的 `server-connect-brand`（原 `viewBox "0 0 720 129"`）。
    判据：产物中该处不再出现上游字标 path（特征串 `M55.3846 36.4286H18.4615V91.7143H55.3846V36.4286Z…`），
    且出现物料 path 数据。保留原 viewBox：上游 CSS 只给该槽位 `width:160px`，把 viewBox 换成正方形会把它
    从约 29px 顶到 160px，破坏首屏布局；物料按等比缩放居中放入（`translate((720-129)/2, 0) scale(129/1024)`）。
    替换边界取**模板字面量的结束反引号**而非 `</svg>` —— 上游压缩器省略了该片段的结束标签。
- **FR-brand-008**（MUST）：包内**每一个被引用的图标位**必须来自同一物料：`AppScope/.../app_icon.png`、
  `icon.png`、`startIcon.png`、`window_icon.png`、`product_logo_32.png`，以及 electron 模块实际投放的
  `$media:app_icon` / `$media:startIcon`。
- **FR-brand-009**（MUST）：应用级不透明图标（`app_icon` / `startIcon` / `icon` / `product_logo_32`）必须为
  **1024×1024 或对应尺寸且不带 alpha 通道**；窗口图标（`window_icon`）允许透明。
- **FR-brand-010**（MUST）：物料**缺失或不可解析**时构建**必须硬失败**并给出明确指引（不得静默产出占位图标）。
- **FR-brand-011**（MUST）：图标生成必须**幂等且确定性**（同一物料 → 同一字节），生成物入库一次，
  保证重复构建不污染工作树。
- **FR-brand-012**（MUST NOT）：**不得**删除 `collect-runtime` 的图标合规守卫；品牌图标必须同样通过
  「1024² 且无 alpha」的断言。

### 4.3 上游零改动与不回归

- **FR-brand-013**（MUST NOT）：不得新增 `patches/v2.0.26/` 补丁；不得改动 `../opencode` 工作树
  （既有 4 条补丁之外）。
- **FR-brand-014**（MUST）：不得回归既有能力：应用启动到就绪、会话可建、真实对话可完成、`shell`/`grep`/`glob`
  工具仍可用（需求 102 的成果）。
- **FR-brand-015**（MUST）：版本号**不变**（`2.0.26` / `20026`），`bundleName` 不变。

### 4.4 文档

- **FR-brand-016**（MUST）：文档必须与实现后的现状一致：`README.md` 的目录/素材说明、
  `docs/鸿蒙环境能力清单-v2.0.26.md` 的「图标为占位图」条目**关闭**、本规格的 AC 结果。

## 5. 验收标准

| 编号 | 验收条件 | 判定方式 |
|---|---|---|
| AC-01 | 交付产物 `index.html` 的 `<title>` = `OC Desktop` | 解码 `app-archive.bin` 后断言 |
| AC-02 | `site.webmanifest` 的 `name`/`short_name` = `OC Desktop` | 同上 |
| AC-03 | 交付产物中以本应用为指称的 `OpenCode` 为 0；受保护清单（FR-brand-005）逐条仍在 | 解码后按保护清单逐条断言 |
| AC-04 | 真机 `document.title` = `OC Desktop` | 应用域 CDP / 截图 |
| AC-05 | 产物中的品牌 Logo 来自父工程物料 | 断言 SVG 内容命中物料特征（或明文比对） |
| AC-06 | `AppScope` 5 个图标的尺寸与 alpha 合规，且不再等于旧占位图 md5 | PNG IHDR + md5 比对 |
| AC-07 | electron 模块实际投放的图标位同样来自物料 | 解包 HAP 比对 md5 |
| AC-08 | `../opencode` 工作树除既有 4 条补丁外零改动；`patches/` 未新增 | `git -C ../opencode status --porcelain` + `ls patches/v2.0.26` |
| AC-09 | 负向：临时移走 `../assets/logo-1024-with-bg.png` 后跑品牌化 → **非零退出**且信息明确 | 命令退出码 |
| AC-10 | 幂等：同一物料连续两次生成图标 → 字节一致 | sha256 比对 |
| AC-11 | 不回归：启动就绪、会话可建、真实对话完成、`shell`/`grep`/`glob` 仍可用 | hilog + 会话记录 |
| AC-12 | 版本号仍 `2.0.26` / `20026`，`bundleName` 未变 | `AppScope/app.json5`、`bm dump` |

## 6. 已知风险

| # | 风险 | 处置 |
|---|---|---|
| R1 | 字符串替换误伤技术标识符 → 破坏兼容/用户数据 | 只替换**首字母大写的字面量** `OpenCode`（技术标识符全是小写 `opencode` / 驼峰 `OpenCode*` 代码标识符不入产物）；替换后断言保护清单计数不变（AC-03） |
| R2 | 上游 UI 升级后品牌引用点漂移 → 品牌化静默失效 | 后置断言：产物中必须出现 `OC Desktop`，且 `<title>` 必须命中；引用点缺失即失败 |
| R3 | 归档解码/重编码破坏 UI（brotli 质量、索引顺序） | 重编码保持 `AppArchive.encode` 的格式与 brotli quality 11；`smoke-node22` 门禁断言「内嵌 UI 可取回」；解压后文件数与原始一致（仅内容变化） |
| R4 | 物料在**父工程**（本仓外）→ 干净 checkout 无法构建 | 文档显式登记前置；缺失即硬失败（FR-brand-010） |
| R5 | 把 200² 位图放大当大图标 → 模糊 | ≥512 与不透明图标一律用 1024² 母版 `logo-1024-with-bg.png`；UI 内联用矢量 `logo.svg` |
| R6 | 生成图标污染工作树 |
修复：生成参数固定（scale + format），生成物**入库**；AC-10 断言幂等 |
| R7 | electron 模块图标由运行时发行版投放，本工程无法覆盖 | 用 `runtime-overlays/` 白名单扩展（electron 模块 media）并在 `collect-runtime` 守卫中登记 |
| R8 | 产品上架审核把「AI 生成内容」与品牌混同 | 界面保留上游 AI 生成内容标识（本需求不动该标识） |

## 7. 不做

i18n 以外的文案重写、上游服务名与商标声明改写（FR-brand-005）、上游仓库改动、
静态目录替换 UI（U5 不可行）、发布证书与上架材料。
