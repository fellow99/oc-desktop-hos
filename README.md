# OC Desktop（oc-desktop-hos）

opencode 桌面端的**鸿蒙（HarmonyOS / OpenHarmony）移植**：用 `harmonypc-electron` 提供的
Electron-on-HarmonyOS 运行时承载 **opencode v2 的服务端**，渲染层以 **ArkWeb（目标）/ Chromium（回退）**
同源加载服务端内嵌的 v2 Web UI，打包为可签名分发的 HAP。

> **本工程非 opencode 团队构建**，与 [opencode](https://github.com/anomalyco/opencode) 无隶属关系；
> opencode 为上游开源项目，本工程仅是其桌面形态在 HarmonyOS 上的第三方移植。

| 项 | 值 |
|---|---|
| 应用名 / bundleName | **OC Desktop** / `org.fellow99.oc.OCDesktop` |
| 版本 | **`2.0.26`** / `versionCode` **20026**（规则 `major*10000 + minor*100 + patch`；版本规格见 `specs/101-version-2.0.26/`） |
| 目标设备 | `2in1` / `tablet`（不做 phone） |
| 上游基线 | opencode **v2.0.26**（tag `v2.0.26` / 提交 `9b4ec5714d` / 分支 `Branch_v2.0.26`） |
| 运行时 | Electron **37**（`v37.2.3-20260825.1` = Node **22.17.0** / Chromium 138 / ABI **v138**）；Electron 40（Node 24.11.1）为触发式备选 |
| 工程规划 | [`docs/工程规划-V2.md`](docs/工程规划-V2.md)（**唯一设计依据**；V1 为历史基线） |
| 骨架镜像源 | `dsh-desktop-hos`（只镜框架，不搬业务） |

## 目录一览

```
AppScope/            应用级配置（bundleName / 版本 / 图标 / 显示名）
electron/            entry 模块：运行时 SO + Chromium 资源 + Ability 装配  ← collect-runtime 投放
web_engine/          HAR：ArkTS 桥接层 + resfile 承载应用产物（含 opencode-dist.tar.gz）
src-main/            Electron 主进程源码（main.js / sidecar.js / tar-extract.js）
scripts/             构建流水线（见下）
patches/v2.0.26/     对上游的幂等补丁（0001–0004，含 README）
runtime-overlays/    copy 后回盖白名单（模块清单 / 显示名资源）
specs/               NNN-name/{spec.md,plan.md} 规格体系（索引见 specs/README.md）
docs/                工程规划 + 四件套（能力清单 / ACL 清单 / toybox 清单 / 真机验证记录）
plugins/ skills/     壳专用插件与技能（Phase 2）
```

## 构建流水线（host 侧 Windows；任一失败即中止，绝不静默降级）

```powershell
# 0) 前置：DevEco Studio（含 hvigor/ohpm/node/sdk）、bun、git；工程与 ../opencode、../harmonypc-electron-versions 同盘符
$env:DEVECO_SDK_HOME = "D:\oh-workspace\DevEco Studio\sdk"

# ① 收集运行时（发行版归档 → electron/ + web_engine/ + SO + Chromium 资源 + libc++_shared.so；应用 overlay；跑守卫）
node scripts\collect-runtime.mjs

# ② 构建 opencode Node 产物（幂等打补丁 → bun install → build-node --target=linux-arm64 --bundle-only
# ② 收集壳应用层（把 plugins/oc-plugin-* 投放进 resfile + sha256 校验 + node --check + 静态断言）
node scripts\collect-app.mjs

# ③ 构建 opencode Node 产物（幂等打补丁 → bun install → build-node --target=linux-arm64 --bundle-only
#    → collect-opencode（品牌化 Web UI + 物化 better-sqlite3 + tar.gz + 校验 + 投放）→ smoke-node22 host 门禁）
node scripts\build-opencode.mjs

# ④ 构建 + 签名（必须用 DevEco 自带 JBR；脚本要求 pwsh 7+）
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts\build-debug.ps1

# ⑤ 安装 + 启动（部署前建议先卸载，清掉 userData 里的旧产物与 marker）
hdc uninstall org.fellow99.oc.OCDesktop
hdc app install -r electron\build\default\outputs\default\electron-default-signed.hap
hdc shell aa start -a EntryAbility -b org.fellow99.oc.OCDesktop
hdc uninstall org.fellow99.oc.OCDesktop
hdc app install -r electron\build\default\outputs\default\electron-default-signed.hap
hdc shell aa start -a EntryAbility -b org.fellow99.oc.OCDesktop
```

常用参数：

| 脚本 | 说明 |
|---|---|
| `scripts/collect-runtime.mjs` | `--extract-only`（不覆盖 overlay、不跑守卫，用于首次导入/取材）、`--verify-only`（只跑守卫）、`--runtime-source <dir>`（用预解压的 ohos_hap） |
| `scripts/build-opencode.mjs` | `--skip-install`、`--no-smoke`、`--bun <path>` |
| `scripts/smoke-node22.mjs` | host 门禁（Node 22.17.0）：`--version/--help` → `serve` → `/api/info` → 内嵌 UI → SSE |
| `scripts/collect-opencode.mjs` | `--product <dir>`、`--no-app-copy` |
| `scripts/collect-app.mjs` | `--check-only`（只跑静态断言与 `node --check`，不投放）、`--self-test`（反向用例证明断言能失败） |
| `scripts/test-harmony-plugins.mjs` | 插件 host 侧语义测试（`grep`/`glob` 匹配、上限、跳过表、哨兵协议），全绿才允许打包 |
| `scripts/lib/branding.mjs` | `--generate-icons`（从父工程物料生成包内图标，幂等）、`--brand <in> --out <out>`、`--verify <bin>`、`--self-test` |
| `scripts/verify-branding.mjs` | 对任意 `app-archive.bin` 跑品牌化后置断言（30 项），非零退出即失败 |

## 关键约定（细节见工程规划）

- **服务端形态**：stock CLI bundle，宿主内 `process.argv = ["node","opencode.mjs","serve","--hostname","0.0.0.0","--port","<随机>"]`
  启动，密码走 `OPENCODE_PASSWORD`（v2 强制要求密码）；健康检查 `GET /api/info`。
- **宿主形态**：三候选（`OCR_HOST_MODE=inprocess|utility|worker`，默认 `inprocess`）——由 **Phase 0 P0-1 探针**定标
  （应用域 fork 出的 node 脚本存在 seccomp SIGSYS 风险，见规划 §3.2 的 ⚠️ 冲突登记）。
- **渲染通道**：`OCR_RENDER_MODE=chromium|arkweb`（默认 chromium 作为可用性回退；arkweb 为目标形态，上架合规要求）。
- **鉴权**：主进程走 v2 原生「配对码 → 会话 Cookie」通道（`POST /api/pair` → `/auth/connect/{code}`），
  把令牌写入渲染层 Cookie；配对不可用时回落到 Basic 头注入。凭据写入 `<userData>/ocr-connection.json`（0600）。
- **产物**：`opencode-dist.tar.gz`（ustar，顶层 `dist-node/`）+ **SHA-256 marker 强比对**，首次启动流式解压到
  `<userData>/opencode-dist/`；`better_sqlite3.node`（aarch64-ohos/ABI v138）随该产物分发（resfile 只读目录不能 dlopen）。
- **最小权限**：仅 `INTERNET`/`GET_NETWORK_INFO`/`READ_WRITE_DOCUMENTS_DIRECTORY`/`READ_WRITE_DOWNLOAD_DIRECTORY`/
  `FILE_ACCESS_PERSIST` + JIT（`kernel.ALLOW_WRITABLE_CODE_MEMORY`，须同时出现在 `requestPermissions` 与 `definePermissions`）；
  已移除 `READ_WRITE_DESKTOP_DIRECTORY`、`PRINT`、相机/麦克风/定位等（守卫会断言）。
- **上架合规**：EntryAbility 已去掉 `entity.system.browsable` / 深链入口（G1）；图标纯色不透明（当前为**占位图标**，发布前必须替换）；
  其余清单见 `docs/ACL申请清单.md` 与规划 §8.5。
- **签名**：本包名必须重新生成证书（不能复用 `com.huawei.ohos_electron`），并按本包名单独申请 ACL；
  `signing.{debug,release}.local.json`（gitignored，样例见 `*.sample`）。

## 当前状态

- ✅ 工程骨架、运行时收集（含结构化守卫全绿）、补丁集（`0001`–`0004`，往返校验通过）、构建流水线与
  host 侧 Node 22.17 冒烟门禁、规格与文档体系、上架合规守卫。
- ✅ **版本 2.0.26**（`versionName 2.0.26` / `versionCode 20026`）；在真机（HOS）完成构建 → 部署 → 启动就绪 →
  基本功能（DeepSeek API Key / 工作区 / 一次真实对话）验证。证据见 `docs/真机验证记录.md`。
- ✅ **鸿蒙环境能力清单（v2.0.26）**：`docs/鸿蒙环境能力清单-v2.0.26.md`（真机实测；v0.1 版作为历史基线保留）。
- ✅ **品牌化**：界面与元数据的 `OpenCode` 收敛为 `OC Desktop`，Logo/图标统一取父工程 `assets/` 物料
  （详见 `specs/103-branding/`）。
- ✅ **鸿蒙 JS 工具（插件）**：把设备上不可得的能力用纯 JS 插件替代（详见 `specs/102-harmony-js-tools/`）。
- ⬜ 能力缺口（v1 明确降级）：终端 PTY（平台级不可用）、`fff` FFI 内容搜索、LSP/formatter/MCP 外部进程、
  插件在线安装（默认关闭）、git/VCS。详见规划 §7 与 `docs/鸿蒙环境能力清单-v2.0.26.md`。

## 环境要求

- DevEco Studio（含 `tools/{hvigor,ohpm,node}` 与 `sdk`）、`bun`、`git`、`node`（脚本用）、**pwsh 7+**（构建脚本；Windows PowerShell 5.1 无法解析无 BOM 的 UTF-8 中文脚本）。
- 运行时归档与原生模块材料放在同级目录 `../harmonypc-electron-versions/`。
- 许可证：MIT（见 `LICENSE`）。
