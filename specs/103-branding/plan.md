# 103 — 品牌化 技术方案

> **回引:** `specs/103-branding/spec.md` ｜ **最后更新:** 2026-10-13

## 1. 决策

| # | 决策 | 依据 | 回引 |
|---|---|---|---|
| D1 | 品牌化在**本工程脚本**里对 `app-archive.bin` 做**解码 → 变换 → 重编码**，**不新增上游补丁** | U4：归档格式是自描述且可在 Node 内无损往返；避免上游漂移面 | FR-brand-013 |
| D2 | 替换对象限定为**纯文本资产**中的**首字母大写字面量** `OpenCode`；二进制资产只做「整文件替换」，不做字节替换 | R1：小写 `opencode` 全是技术标识符；二进制内替换会破坏结构 | FR-brand-005 |
| D3 | 保护清单实现为**常量表**（`PROTECTED_SUBSTRINGS`），默认保护上游服务名与法律声明 | FR-brand-005 的四类；可配置=可复核 | FR-brand-005 |
| D4 | 图标由 `scripts/lib/branding.mjs` 用**纯 JS** 从 PNG 母版生成（PNG 编解码自研最小实现），不引入 npm 依赖 | 设备/宿主都可能无网络；不引第三方依赖以免污染上游 `node_modules` | FR-brand-008 |
| D5 | UI 内联 Logo 用 `assets/logo.svg` 的 path 数据替换上游 `opencode-logo` 的 SVG 内容 | U3 + FR-brand-007 | FR-brand-007 |
| D6 | electron 模块的 `$media:app_icon` / `$media:startIcon` 通过**扩展 `runtime-overlays/` 白名单**投放到该模块的 media 目录 | U9 + R7：`AppScope` 只管应用级；模块级图标必须落在模块自己的 `resources/base/media` | FR-brand-008 |
| D7 | 品牌化阶段放在 `collect-opencode.mjs` 的「归档产出后、投放 resfile 前」，并做**后置断言** | 断言必须在最终产物上做（FR-brand-004/R2） | FR-brand-004 |
| D8 | 断言脚本独立：`scripts/verify-branding.mjs`（可对任意 `.bin` 跑），便于回归与负向用例 | AC-03/AC-09 需要在产物上反复跑 | FR-brand-003 |
| D9 | 生成物**入库**（`AppScope/.../media/*.png` 已在库内；本需求替换其内容） | 与既有 `collect-runtime` 的「仅缺失时生成」策略一致，避免每次构建改动二进制 | FR-brand-011 |

## 2. 变换流水线

```
collect-opencode.mjs
  ① 取 dist-node/assets/app-archive.bin（上游构建产物）
  ② AppArchive 解码 → { key: brotli(bytes) }
  ③ 逐资产变换（scripts/lib/branding.mjs 的 transformArchive）：
       - 文本资产（index.html / site.webmanifest / _assets/*.js / *.css / *.json / sw.js）：
           a. 品牌替换：/OpenCode/ → "OC Desktop"，命中保护清单的行**跳过**
           b. index.html：<title> 兜底断言
           c. 内联 Logo：把 opencode-logo 的 path 数据替换为 assets/logo.svg 的 path 数据
       - 二进制资产（*.png / *.ico / *.woff2）：按 key 白名单整文件替换为物料生成的图标
  ④ 重编码 AppArchive.encode（brotli quality 11），写回
  ⑤ 后置断言（verify-branding.mjs）：见 §3
  ⑥ 继续原有的 tar.gz 打包与 resfile 投放
```

## 3. 后置断言（fail-visible）

| 断言 | 期望 | 关联 |
|---|---|---|
| `index.html` 的 `<title>` | `OC Desktop` | AC-01 |
| `site.webmanifest` 的 `name` / `short_name` | `OC Desktop` | AC-02 |
| 保护清单逐条仍在产物中 | 存在 | AC-03 |
| 以本应用为指称的 `OpenCode` 计数（排除保护清单行） | `0` | AC-03 |
| 产物中出现 `OC Desktop` | ≥1 | R2 |
| favicon / apple-touch-icon / manifest 图标 | 与物料生成物逐字节一致 | AC-05/AC-07 |
| 资产条目数 | 与变换前一致（只换内容不增删） | R3 |

## 4. 图标生成

| 目标 | 源 | 规则 |
|---|---|---|
| `AppScope/.../app_icon.png` | `../assets/logo-1024-with-bg.png` | 1024×1024，**去 alpha**（转 RGB） |
| `AppScope/.../icon.png` | 同上 | 512×512，去 alpha |
| `AppScope/.../startIcon.png` | 同上 | 512×512，去 alpha |
| `AppScope/.../product_logo_32.png` | 同上 | 32×32，去 alpha |
| `AppScope/.../window_icon.png` | `../assets/logo.png` | 512×512，**保留 alpha**（窗口图标允许透明） |
| `runtime-overlays/electron/src/main/resources/base/media/app_icon.png` | `logo-1024-with-bg.png` | 1024²，去 alpha |
| `runtime-overlays/electron/src/main/resources/base/media/startIcon.png` | 同上 | 512²，去 alpha |
| UI 内联 Logo | `../assets/logo.svg` | 取 path 数据填入组件 |

> 缩放算法：纯 JS 双线性（`logo-1024-with-bg.png` → 512/32 为整数比，质量足够）；1024 目标直接复制并去 alpha。

## 5. 步骤

| 步 | 动作 | 落点 | 出口判据 |
|---|---|---|---|
| S0 | 记录物料与旧图标指纹 | `logs/20261013-1/BASELINE.md` | 已记录 |
| S1 | `scripts/lib/branding.mjs`：PNG 读写 + 缩放 + 去 alpha + 归档变换 | 脚本 | host 自测通过 |
| S2 | 生成 AppScope 5 图标与 electron overlay 2 图标 | 仓库 | 尺寸/alpha/幂等断言通过 |
| S3 | Logo SVG path 提取与替换规则 | 脚本 | 产物断言通过 |
| S4 | `scripts/verify-branding.mjs` | 脚本 | 对变换前后各跑一次（前：应失败） |
| S5 | 接入 `collect-opencode.mjs` | 流水线 | 归档产出后断言全绿 |
| S6 | `collect-runtime.mjs`：overlay 白名单加模块级 media；图标守卫改为「与物料生成物一致」 | 脚本 | 守卫全绿 |
| S7 | 文档同步 | `README.md` | AC 审阅 |
| S8 | 真机验证 | 部署 + `document.title` | AC-04/AC-11 |

## 6. 风险

| # | 风险 | 处置 |
|---|---|---|
| R1 | 替换误伤技术标识符 | 只替换 `OpenCode`（大写 O 开头）；断言保护清单计数不变 |
| R2 | UI 升级后引用点漂移 | 后置断言（§3）失败即构建失败 |
| R3 | 归档重编码破坏 UI | 保持 encode 格式与 brotli q11；断言条目数一致；`smoke-node22` 门禁「内嵌 UI 可取回」 |
| R4 | 物料缺失 | 硬失败（FR-brand-010） |
| R5 | 位图放大发虚 | 大尺寸一律用 1024² 母版；UI 用矢量 |
| R6 | 生成物污染工作树 | 参数固定 + AC-10 幂等断言 |
| R7 | 模块级图标覆盖不到 | overlay 白名单 + 守卫断言 |
