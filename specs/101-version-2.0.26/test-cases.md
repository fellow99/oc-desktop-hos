# 101 — 版本更新：2.0.26 测试用例

> **回引:** `spec.md` §5 ｜ **执行落点:** `logs/20261013-1/TEST_CHECKLIST.md` / `TEST_REPORT.md`

## 1. 环境

| 项 | 值（执行时填写实测值） |
|---|---|
| 设备序列号 | `3QC0226526001227`（`hdc list targets`） |
| 设备型号 / 系统 / API | ⬜ 执行时记录（`param get const.product.*` / `const.ohos.apiversion`） |
| 设备类型 | 2in1 / tablet |
| HAP 版本 | `2.0.26` / `20026` |
| 上游基线 | opencode `v2.0.26` / `9b4ec5714d` |
| 运行期 | Electron 37.2.3 / Node 22.17.0 / ABI v138 |

## 2. 静态与构建用例

| 用例 | 关联 | 步骤 | 期望 | 结果 |
|---|---|---|---|---|
| TC-01 清理不伤已跟踪文件 | AC-01 | `git status --porcelain` | 无 ` D ` 行；`patches/specs/skills/plugins/src-main` 均存在 | ⬜ |
| TC-02 清理清单命中 | AC-01 | 逐一 `test -e` 删除清单目标 | 全部不存在；保留清单全部存在 | ⬜ |
| TC-03 版本号 | AC-02 | 读 `AppScope/app.json5` | `2.0.26` / `20026` | ⬜ |
| TC-04 文档版本残留 | AC-03 | `grep -rn "0\.1\.0" --include=*.md .` | 无「当前版本」语义残留 | ⬜ |
| TC-05 补丁往返（正向） | AC-04 | 对每条补丁 `git apply --check` | 至少一条路径（正向/反向）成功且不冲突 | ⬜ |
| TC-06 补丁往返（反向） | AC-04 | 对已应用补丁 `git apply --reverse --check` | 成功 | ⬜ |
| TC-07 补丁清单一致 | AC-04 | 比对 `patches/v2.0.26/README.md` 与 `ls *.patch` | 编号/落点/作用一致 | ⬜ |
| TC-08 运行时守卫 | AC-05 | `node scripts/collect-runtime.mjs` | 阶段 10 全绿，输出守卫条数 | ⬜ |
| TC-09 dlopen 锚点 | AC-05 | `ls electron/libs/arm64-v8a/` | `libc++_shared.so` + `better_sqlite3.node` 均在，且为 aarch64 ELF | ⬜ |
| TC-10 host 冒烟 8 项 | AC-06 | `node scripts/smoke-node22.mjs` | 8 项全绿 | ⬜ |
| TC-11 产物指纹 | R1 | `sha256sum .stage/opencode-dist.tar.gz` | 记录值与 marker 一致 | ⬜ |
| TC-12 HAP 产出与签名 | AC-07 | 构建输出 + `hap-sign-tool verify-app` | 存在 `electron-default-signed.hap`，签名有效 | ⬜ |
| TC-13 HAP 内版本 | AC-02 | 解包 HAP 读 `pack.info` / `module.json` | `versionName 2.0.26` / `versionCode 20026` | ⬜ |
| TC-14 负向：图标合规 | AC-05 | `collect-runtime` 图标守卫 | 5 个 AppScope 图标 1024/512/32 且无 alpha 通道 | ⬜ |

## 3. 真机用例

| 用例 | 关联 | 步骤 | 期望 | 结果 |
|---|---|---|---|---|
| TC-15 安装启动就绪 | AC-08 | `hdc uninstall` → `app install -r` → `aa start` | 阶段日志至「界面已加载」；非白屏 | ✅ 2026-10-14：`msg:install bundle successfully`；`ocr-trace.log` 到 `[就绪] 界面已加载 …`；`ps -A` 稳定 3 个进程 |
| TC-16 首屏 UI | AC-08 | 应用域读 `location.href` + 首屏标记 | 命中 v2 UI 首屏 | ✅ 2026-10-14：`uitest dumpLayout` 取得 v2 UI 节点（`rootWebArea`/`header`/`tabList`/`popUpButton`…）；截图为真实 UI（客户区均值亮度 249.4） |
| TC-17 服务端健康 | AC-09 | 应用域 `fetch('/api/info')` | 200 且 `version=2.0.26` | ✅ 2026-10-14：`/api/info 就绪 version=0.0.0-Branch_v2.0.26-202610140152`（构建标识含 `v2.0.26`，非纯 semver） |
| TC-18 鉴权引导 | FR-ver-021 | 读 `<userData>/ocr-connection.json` | 含 `cookieName`/`port`/`passwordKind` | ⚠️ 2026-10-14：配对通道不可用（`/auth/connect` HTTP 404），按设计回落 Basic 头注入；该文件 `0600`，shell 域不可读，内容未取证 |
| TC-19 DeepSeek Key | AC-10 | UI 设置 DeepSeek API Key（**真实密钥人工输入，不入库**） | 保存成功且可再次读取 | ⬜ 需人工输入真实密钥，本轮未做 |
| TC-20 工作区创建 | AC-11 | 沙箱内建测试目录并选为工作区 | 服务端以该目录为项目根 | ⬜ 本轮未做 |
| TC-21 一次真实对话 | AC-12 | 发送「介绍一下你自己」 | 取得模型回复（非报错、非空） | ⬜ 本轮未做 |
| TC-22 better-sqlite3 持久化 | FR-ver-021 | 重启应用后回读会话 | 会话仍在（未重建空库） | ⬜ `.db`/`-wal`/`-shm` 为 `0600`，shell 域不可读；需应用域探针 |
| TC-23 窗口分辨率 1280×720 | AC-08 | 默认建窗 + `getBounds()` + `uitest dumpLayout` | App 可见窗口为 1280×720 | ✅ 2026-10-14：`[创建窗口] 建窗 1280×720`；web 客户区 `[342,290]-[2774,1659]`（屏 3120×2080 / 1.9× ⇒ 1280×720.5） |
| TC-24 设置中切换深色主题 | AC-08 | 设置 → 外观 → 配色方案 → 深色 | 主题切换为深色并可截图 | ✅ 2026-10-14：`uitest uiInput click`（坐标取自 `dumpLayout`）→ 客户区均值亮度 251.0 → 26.9，关闭设置后 21.7；截图 `logs/20261013-1/screenshots/app-dark-1280x720.png` |

## 4. 能力复验用例（对应 spec §4.5 的 ⬜-1…⬜-12）

| 用例 | 待验证项 | 取证方式 | 结果 |
|---|---|---|---|
| CAP-01 | 应用域 `spawn('/system/bin/sh')` 与事件序列 / 僵尸计数 | 应用域探针 + `/proc/<pid>/stat` | ⬜ |
| CAP-02 | 应用域子进程 JIT（SIGSYS 是否复现） | 三候选宿主各跑 JIT 示性 | ⬜ |
| CAP-03 | `import` bundle 的可行性与耗时 | 阶段日志耗时 | ✅ 2026-10-14：`进程内加载 …opencode.mjs` → `IMPORT_RESOLVED exports=0`，约 1.0 s |
| CAP-04 | `0.0.0.0` + 局域网 IP 访问 `/api/info` | 应用域与外部探测 | ✅ 2026-10-14：`[就绪] 界面已加载 http://192.168.137.31:46763/`；`/api/info` 就绪 |
| CAP-05 | ArkWeb / Chromium 对 v2 UI 的八项能力 | 渲染通道真机 | ✅（**仅 Chromium/R1**）2026-10-14：首屏渲染 + `localStorage` 主题持久化生效；ArkWeb 通道未验 |
| CAP-06 | 明文 HTTP 策略与头改写是否仍需 | 渲染通道真机 | ✅（R1）2026-10-14：Chromium 通道首屏成功（亮/深两版截图） |
| CAP-07 | `os.tmpdir()` patch 与 `<userData>/tmp` 可写 | 应用域探针 | ✅ 2026-10-14：`[环境装配] … TMPDIR=/data/storage/el2/base/files/tmp`；53 文件成功解压到 `<userData>` |
| CAP-08 | better-sqlite3 加载与 `-wal` 行为 | 应用域写读 + 重启回读 | ⬜ `.db`/`-wal`/`-shm` 为 `0600`，shell 域不可读 |
| CAP-09 | 用户目录授权与可写性 | 文件选择器 + 重启 | ⬜ |
| CAP-10 | 项目根传参与 `GET /api/location` | 应用域接口 | ⬜ |
| CAP-11 | 插件通道（进程内物化语义） | 真机插件加载 | ⬜ |
| CAP-12 | 托盘 / 状态栏 / 通知 | 真机 | ⬜ |

## 5. 负向与边界用例

| 用例 | 关联 | 步骤 | 期望 | 结果 |
|---|---|---|---|---|
| TC-N1 | FR-ver-012 | 用 release 签名包 `hdc app install -r` | 被拒（not trusted app source）——证明必须 debug 签名 | ⬜ |
| TC-N2 | FR-ver-010 | 临时移走 `electron/libs/arm64-v8a/better_sqlite3.node` 后跑 `--verify-only` | 守卫硬失败并给出明确指引 | ⬜ |
| TC-N3 | FR-ver-018 | 抽查 2 条无法在真机执行的待验证项 | 报告中保留 `⬜` 而非 ✅ | ⬜ |
| TC-N4 | FR-ver-011 | 用非 22.17 的 node 跑冒烟 | 门禁失败（不静默通过） | ⬜ |
