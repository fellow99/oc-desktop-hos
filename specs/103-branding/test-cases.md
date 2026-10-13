# 103 — 品牌化 测试用例

> **回引:** `spec.md` §5 ｜ **执行落点:** `logs/20261013-1/TEST_CHECKLIST.md`

## 1. 静态与负向（host）

| 用例 | 关联 | 步骤 | 期望 | 结果 |
|---|---|---|---|---|
| BT-01 | AC-06 | 读 `AppScope/.../media/app_icon.png` IHDR | 1024×1024 且 `colorType=2`（无 alpha） | ⬜ |
| BT-02 | AC-06 | 同 `icon.png` / `startIcon.png` | 512×512 且无 alpha | ⬜ |
| BT-03 | AC-06 | 同 `product_logo_32.png` | 32×32 且无 alpha | ⬜ |
| BT-04 | AC-06 | 同 `window_icon.png` | 512×512（允许 alpha） | ⬜ |
| BT-05 | AC-06 | 5 个图标 md5 与清理前基线比对 | 全部不同（不再是占位图） | ⬜ |
| BT-06 | AC-10 | 连续两次运行图标生成 | 两次 sha256 一致 | ⬜ |
| BT-07 | AC-09 | 临时移走 `../assets/logo-1024-with-bg.png` 后跑品牌化 | 非零退出 + 明确指引 | ⬜ |
| BT-08 | AC-09 | 临时移走 `../assets/logo.svg` 后跑 | 非零退出 + 明确指引 | ⬜ |
| BT-09 | AC-08 | `git -C ../opencode status --porcelain` | 仅既有 4 条补丁造成的 7 项改动 | ⬜ |
| BT-10 | AC-08 | `ls patches/v2.0.26/*.patch` | 仍为 4 条，未新增 | ⬜ |
| BT-11 | FR-brand-006 | `grep -rn "opencode 桌面端" AppScope electron/src` | 无命中 | ⬜ |

## 2. 产物断言（对 `app-archive.bin`）

| 用例 | 关联 | 步骤 | 期望 | 结果 |
|---|---|---|---|---|
| BT-20 | AC-01 | 解码归档取 `index.html` | `<title>OC Desktop</title>` | ⬜ |
| BT-21 | AC-02 | 解码取 `site.webmanifest` | `name`/`short_name` = `OC Desktop` | ⬜ |
| BT-22 | AC-03 | 逐条检查保护清单（商标句 / `OpenCode Console` / `OpenCode Go` / `OpenCode Zen` / `OpenCode Free` / `www.opencode.ai`） | 全部**仍在** | ⬜ |
| BT-23 | AC-03 | 排除保护清单行后统计以本应用为指称的 `OpenCode` | 0 | ⬜ |
| BT-24 | AC-03 | 统计技术标识符（`opencode_session`、`@opencode/`、`opencode:`、SW 缓存前缀） | 计数与变换前**一致** | ⬜ |
| BT-25 | AC-05 | 解码取 `index.html`/`_assets/*` 内联 Logo | 命中父工程 `logo.svg` 的 path 特征 | ⬜ |
| BT-26 | AC-07 | 归档内 `favicon.ico` / `apple-touch-icon.png` / `web-app-manifest-192x192.png` / `web-app-manifest-512x512.png` | 与物料生成物逐字节一致 | ⬜ |
| BT-27 | R3 | 变换前后条目数 | 一致 | ⬜ |
| BT-28 | R3 | 变换后归档可被 `AppArchive.decode` 成功解析且所有资产可 brotli 解压 | 成功 | ⬜ |
| BT-29 | R2 | 归档中出现 `OC Desktop` 的资产数 | ≥1（且 `index.html` 必中） | ⬜ |
| BT-30 | 负向 | 对**变换前**归档跑 `verify-branding.mjs` | 非零退出 | ⬜ |

## 3. 真机用例

| 用例 | 关联 | 步骤 | 期望 | 结果 |
|---|---|---|---|---|
| BT-40 | AC-04 | 部署后应用域读 `document.title` | `OC Desktop` | ⬜ |
| BT-41 | AC-04 | 首屏品牌区截图 | 显示 `OC Desktop`，Logo 为新物料 | ⬜ |
| BT-42 | AC-01 | 窗口标题栏 | `OC Desktop` | ⬜ |
| BT-43 | AC-06 | 桌面/任务栏图标 | 新图标（非纯色占位） | ⬜ |
| BT-44 | AC-12 | 读设备包信息 | `versionName 2.0.26` / `versionCode 20026` / `bundleName org.fellow99.oc.OCDesktop` | ⬜ |
| BT-45 | AC-11 | 一次真实对话 | 正常回复（不回归） | ⬜ |
