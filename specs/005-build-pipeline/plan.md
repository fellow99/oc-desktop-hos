# 四阶段构建流水线（005-build-pipeline）—— 实现方案

> **Module:** 005-build-pipeline ｜ **Status:** Proposed ｜ **Last Updated:** 2026-10-11 ｜ **上游基线:** opencode v2.0.26（Branch_v2.0.26）
> 对应规格：[spec.md](./spec.md)

## 1. 技术上下文

### 1.1 运行环境（host 侧）

- 操作系统：Windows（构建机）；脚本在 Git-Bash / PowerShell 两种调用方式下都可用。
- 脚本运行时：Node（`.mjs` ESM）；构建期需要的 Node 22.17.0 用于门禁（来源 ⬜ 待验证）。
- 关键外部工具：`bun`（构建上游产物）、DevEco 自带 `ohpm.bat` / `hvigorw.bat` / JBR / Node、`hdc`（设备交互）、系统 `tar`（ustar 打包）。
- 目录约定：本工程 `oc-desktop-hos` 与上游 `../opencode`、`../harmonypc-electron`、`../harmonypc-electron-versions` 同级（`opencode-workspace` submodule 容器还原）。

### 1.2 依赖

| 依赖 | 版本/来源 | 用途 |
|------|-----------|------|
| `../opencode` | submodule，`Branch_v2.0.26`（`9b4ec5714d`） | 上游源码 + 补丁目标 + 构建产物来源 |
| `../harmonypc-electron` | submodule | `web_engine` 桥接层骨架来源（物理拷贝） |
| `../harmonypc-electron-versions/v37.2.3-20260825.1-release.zip` | 发行版归档 | SO + Chromium 资源 + `better_sqlite3.node` 材料 |
| DevEco SDK | 本机安装 | `libc++_shared.so`、`ohpm`、`hvigorw`、JBR、Node |
| `node:child_process` / `node:fs` | Node 内置 | 子进程调用与文件投放 |
| `004-request-hooks` | 本工程 | 门禁的凭据生成逻辑复用 |

## 2. 关键决策

| 决策 | 结论 | 依据 |
|------|------|------|
| 上游改动方式 | 幂等补丁（`git apply --reverse --check` 判据） | 可复核、可往返、不 fork |
| 产物形态 | `--bundle-only`（非 SEA） | ✅ 设备侧不可能执行自备 ELF |
| Node 目标 | 补丁 0001 设 `build.target=node22` + `resolve.conditions` 前置 `"ohos"` | 设备 Node 22.17.0 |
| 门禁 | `smoke-node22.mjs` 六项断言，失败即阻断 | 不把不确定产物推真机 |
| 打包 | 单文件 tar.gz（ustar，唯一前缀 `dist-node/`）+ SHA-256 marker | 🔶 小文件入 HAP 不可行 |
| 裁剪 | 删非 arm64 原生件 / `opencode-pty` ELF / `node_modules`；用补丁保证不加载 | 体积与加载安全 |
| 阶段③投放 | 只投 `src-main/**`，先清理陈旧副本 | 防「跑旧代码」幽灵现象 |
| 阶段④工具链 | DevEco JBR + 自带 Node + 清 `NODE_OPTIONS` + `cmd /c` 调 `.bat` | 🔶 换 JDK 报 `Invalid CEN header` |
| 幂等实现 | 每阶段「先校验后动作」：已满足判据即跳过 | 重跑不重复下载/拷贝/打补丁 |
| 签名 | 阶段④调用 `hvigorfile.ts` 的 `afterNodeEvaluate` 注入（细节见 006） | 材料不入库 |
| 日志 | 前缀 `[oc-desktop][build:<stage>]` + 摘要行 | 便于与真机日志区分与检索 |

## 3. 数据模型

### 3.1 阶段表

| id | 输入 | 输出 | 判据（gate） | 幂等跳过条件 |
|----|------|------|--------------|--------------|
| `collect-runtime` | v37 归档、DevEco SDK、`../harmonypc-electron`、`runtime-overlays/`、`better_sqlite3.node` | `electron/libs/arm64-v8a/*`、Chromium 资源、`web_engine/**` | SO md5 与 `runtime-manifest.json` 一致 + 关键文件存在 | 判据全绿则跳过拷贝 |
| `build-opencode` | `../opencode`、`patches/v2.0.26/` | `packages/cli/dist-node/**` | 补丁应用幂等 + 构建零退出 + `assertTextImportsInlined` 通过（上游自带） | 补丁已应用则只跑构建 |
| `collect-opencode` | `packages/cli/dist-node/**` | `resfile/resources/app/opencode-dist.tar.gz` + `.version` | 条目校验（前缀/链接/关键文件）+ SHA-256 写入 | tar 的 SHA-256 与现有 `.version` 一致则跳过 |
| `collect-app` | `src-main/**` | `resfile/resources/app/{main.js,sidecar.js,tar-extract.js,package.json}` | 陈旧副本清理完成 + 语法自检通过 | 文件哈希与投放副本一致则跳过 |
| `hvigor` | 上述 resfile + `oh_modules` | 签名 HAP | 构建零退出 + 产物存在 | 不跳过（构建时间可接受） |

### 3.2 产物清单（`ArtifactManifest`）

```js
{ tarPath, tarSha256, fileCount, bytes, opencodeMjsSha256, appArchiveBytes, buildAt, toolchain: { bun, node, hvigor } }
```

- 写入位置：`docs/真机验证记录.md` 的构建记录章节（人工/脚本追加）或构建日志文件（由脚本打印）。
- `.version` 文件内容严格等于 `tarSha256 + '\n'`。

### 3.3 补丁集状态

```js
{ tag: 'v2.0.26', applied: ['0001-...', '0002-...'], skipped: [], roundTripOk: true }
```

### 3.4 校验规则

- 补丁路径必须匹配 `patches/<tag>/NNNN-*.patch`；`tag` 必须与上游 `git describe` / 约定 tag 一致，否则中止。
- 补丁文件必须能被 `git apply --check`（未应用）或 `git apply --reverse --check`（已应用）之一判定通过；两者都不通过即冲突。
- tar 条目校验：名前缀唯一为 `dist-node/`、无链接条目、含 `opencode.mjs` 与 `assets/app-archive.bin`。
- 门禁断言必须逐条打印；任一条失败以非零退出码结束。

## 4. 接口契约

### 4.1 本模块提供

| 接口 | 说明 |
|------|------|
| `scripts/collect-runtime.mjs` | 阶段①入口：解压归档、投放、overlay 回盖、校验（零退出即通过） |
| `scripts/build-opencode.mjs` | 阶段②入口：补丁 + `bun install` + `build-node` + 调用 collect-opencode |
| `scripts/collect-opencode.mjs` | 阶段②b：裁剪 + 打包（ustar）+ `.version` 写入 + 投放 + 条目校验 |
| `scripts/collect-app.mjs` | 阶段③：`src-main` 投放 + 陈旧清理 + 语法自检 |
| `scripts/smoke-node22.mjs` | 门禁：六项断言（version/help/serve/info/spa/event），失败即阻断 |
| `scripts/build-{hap,debug,release}.ps1` | 端到端入口（组合四阶段 + 门禁 + 安装启动） |
| `scripts/lib/` | 共享工具集（日志前缀、路径解析、tar 读取断言、凭据生成复用） |
| `scripts/probes/` | 真机/环境探针（001/002/007 的探针脚本落点） |

### 4.2 本模块消费

| 来源 | 契约 |
|------|------|
| `../opencode` | `packages/cli/{script/build-node.ts,vite.node.config.ts}`、`packages/core/package.json#imports` |
| `../harmonypc-electron/ohos_hap/runtime-manifest.json` | `shellVersion`、`binaryVersion`、SO md5、`barrelFile` |
| `../harmonypc-electron-versions/` | v37 发行版归档与 `better_sqlite3.node` 材料 |
| DevEco SDK | `native/llvm/lib/aarch64-linux-ohos/libc++_shared.so`、`tools/{ohpm,hvigor}/bin/*.bat` |
| 环境变量 | `NODE_HOME`、`DEVECO_SDK_HOME`、`MSYS_NO_PATHCONV=1`、`PATH`（含 bun / DevEco JBR） |
| `006-signing-identity` | `hvigorfile.ts` 的签名注入与 `versionCode` 守卫入口 |

## 5. 实现策略

### 5.1 关键算法

- **子进程调用**：统一 `spawnSync('cmd', ['/c', '<tool>.bat', ...args], { stdio: 'inherit', env })`；环境先 `delete env.NODE_OPTIONS`。
- **补丁判定**：
  ```js
  const applied = spawnSync('git', ['apply', '--reverse', '--check', patch], { cwd: UPSTREAM }).status === 0
  if (!applied) {
    const ok = spawnSync('git', ['apply', '--check', patch], { cwd: UPSTREAM }).status === 0
    if (!ok) fail(`patch conflict: ${patch}`)
    spawnSync('git', ['apply', patch], { cwd: UPSTREAM })
  }
  ```
- **往返校验**（可选开关 `--verify-roundtrip`）：应用 → 记录受影响文件 SHA-256 → 反向应用 → 比对还原。
- **打包**：先对 `dist-node/**` 做裁剪到暂存目录，再 `tar -czf opencode-dist.tar.gz --format=ustar -C <staging> dist-node`，随后用 `scripts/lib/tar.mjs`（与 003 同一解析器逻辑）读回校验。
- **门禁**：`spawn('node', [bundle, 'serve', '--hostname', '127.0.0.1', '--port', '4096'], { env })`；轮询 `GET /api/info`（带凭据，200ms 起步、1s 上限指数退避，总超时 60s）→ `GET /` → `GET /api/event` 读首个事件 → 关闭子进程（`SIGTERM`，超时 `SIGKILL`）并断言端口释放。

### 5.2 错误处理

- 任一步非零退出 → 打印「阶段 / 命令 / 退出码 / stderr 首 20 行」并以该码退出。
- 补丁冲突 → 打印冲突补丁名与 `git apply --check` 原始输出，退出码专用（便于人工判断）。
- 归档 md5 不符 → 打印期望值与实际值，并提示归档版本必须与运行时严格匹配。
- 门禁失败 → 保留被启动进程的 stdout/stderr 全量（落 `$PI_SCRATCH_DIR` 或构建日志），退出非零。

### 5.3 降级

- **构建期不做能力降级**：任何校验失败一律中止（避免把「可能有问题」的产物推给真机）。
- 唯一允许的可选行为：`runtime-overlays/` 不存在时跳过回盖并打印提示（不是降级，而是本工程可能未启用 overlay）。

## 6. 测试与验证

### 6.1 host 侧

- **门禁即测试**：`node scripts/smoke-node22.mjs` 是流水线的唯一强制门禁，六项断言必须逐条可见（`version` / `help` / `serve` / `info` / `spa` / `event`）。
- **补丁幂等测试**：连续跑两次阶段②，断言第二次全部补丁走 `skipped` 分支且上游工作区 `git status --porcelain` 为空。
- **补丁往返测试**：`--verify-roundtrip` 断言受影响文件 SHA-256 还原。
- **tar 校验测试**：用 `scripts/lib/tar.mjs` 读回 tar，断言前缀唯一、无链接条目、关键文件存在；再构造坏包断言校验失败。
- **产物自检**：对 `src-main/**` 跑 `node --check`；对投放后的 `resfile` 断言 `opencode-dist.tar.gz` 与 `.version` 仍在（阶段③不越权删除）。

### 6.2 真机命令

```bash
# 依赖解析与构建（PowerShell/DevEco 路径按本机调整）
& "<DevEco>/tools/ohpm/bin/ohpm.bat" install
$env:NODE_HOME       = "<DevEco>/tools/node"
$env:DEVECO_SDK_HOME = "<DevEco>/sdk"
Remove-Item Env:NODE_OPTIONS -ErrorAction SilentlyContinue
& "<DevEco>/tools/hvigor/bin/hvigorw.bat" assembleHap --mode module -p product=default -p buildMode=debug --no-daemon

# 安装与启动 / 取证
hdc app install -r electron/build/default/outputs/default/electron-default-signed.hap
hdc shell aa start -a EntryAbility -b org.fellow99.oc.OCDesktop
hdc shell "hilog -x | grep oc-desktop"
hdc uninstall org.fellow99.oc.OCDesktop     # 仅在需要清空 userData 对照时使用
```

- 真机 MUST 记录：设备型号与系统版本、`tarSha256`、HAP 体积、首启耗时、是否命中 003 的解压跳过分支，落 `docs/真机验证记录.md`。

### 6.3 验收口径

- spec §5 七个场景全绿；两次完整构建的 `opencode.mjs` 与 tar 哈希一致；门禁失败注入能真实阻断流水线（人为破坏产物验证一次）。

## 7. 文件清单

| 文件（相对工程根） | 用途 |
|--------------------|------|
| `scripts/collect-runtime.mjs` | 阶段①：运行时与原生资源投放、overlay 回盖、md5 校验 |
| `scripts/build-opencode.mjs` | 阶段②：补丁、`bun install`、`build-node --bundle-only` |
| `scripts/collect-opencode.mjs` | 阶段②b：裁剪、ustar 打包、`.version`、投放与条目校验 |
| `scripts/collect-app.mjs` | 阶段③：`src-main` 投放、陈旧清理、语法自检 |
| `scripts/smoke-node22.mjs` | 门禁：Node 22.17 六项断言 |
| `scripts/build-hap.ps1` / `scripts/build-debug.ps1` / `scripts/build-release.ps1` | 端到端入口 |
| `scripts/lib/` | 共享工具（日志、路径、tar 断言、凭据生成） |
| `scripts/probes/` | 探针脚本落点（001/002/007） |
| `patches/v2.0.26/0001-node-target-ohos.patch` / `0002-sqlite-ohos.patch` / `0003-runtime-stubs-ohos.patch` | 上游幂等补丁 |
| `runtime-overlays/` | copy 后回盖白名单 |
| `src-main/{main.js,sidecar.js,tar-extract.js,package.json}` | 阶段③投放源 |
| `web_engine/src/main/resources/resfile/resources/app/` | 产物投放目标 |
| `electron/libs/arm64-v8a/` | 原生 SO 与 `better_sqlite3.node` 投放目标 |
| `docs/真机验证记录.md` | 构建基线与真机留证 |

## 8. 与规格的交叉引用

| 规格需求 | 落点 |
|----------|------|
| FR-005-001 ~ 006（总则） | `scripts/build-{hap,debug,release}.ps1`、`scripts/lib/` |
| FR-005-007 ~ 012（阶段①） | `scripts/collect-runtime.mjs`、`runtime-overlays/` |
| FR-005-013 ~ 020（阶段②补丁与构建） | `scripts/build-opencode.mjs`、`patches/v2.0.26/000{1,2,3}-*.patch` |
| FR-005-021 ~ 026（裁剪与打包） | `scripts/collect-opencode.mjs`、`scripts/lib/tar.mjs`、`resfile/.../opencode-dist.{tar.gz,version}` |
| FR-005-027 ~ 030（阶段③） | `scripts/collect-app.mjs` |
| FR-005-031 ~ 036（阶段④） | `scripts/build-*.ps1`、`hvigorfile.ts`（见 006） |
| FR-005-037 ~ 041（门禁） | `scripts/smoke-node22.mjs`、`scripts/lib/credentials.mjs` |
| FR-005-042 ~ 044（可复现性） | 各阶段摘要输出、`docs/真机验证记录.md` |
