# 服务端与 UI 加载（008-server-ui-load）—— 实现方案

> **Module:** 008-server-ui-load ｜ **Status:** Proposed ｜ **Last Updated:** 2026-10-11 ｜ **上游基线:** opencode v2.0.26（Branch_v2.0.26）
> 对应规格：[spec.md](./spec.md)

## 1. 技术上下文

### 1.1 运行时环境

- 服务端运行在 007 定标的宿主体内（A utility 进程 / B 主进程进程内 / C worker），宿主 Node 版本为 Electron 37 内置的 **Node 22.17.0**。
- 产物来自 003 的解压目录：`<userData>/opencode-dist/{opencode.mjs, assets/**}`；`assets/app-archive.bin` 为内嵌 UI 归档。
- 绑定 `0.0.0.0` + 随机端口；渲染层用局域网 IP 访问（🔶 loopback 隔离）。
- 上游为本版本单文件 bundle（Vite SSR，`inlineDynamicImports: true`），因此「设置 `process.argv` 后 `import()`」即等价于执行 CLI。

### 1.2 依赖

| 依赖 | 版本/来源 | 用途 |
|------|-----------|------|
| `dist-node/opencode.mjs` | 上游 `--bundle-only` 产物（经 003 解压） | 服务端与内嵌 UI |
| `dist-node/assets/**` | 同上 | `app-archive.bin`、原生件、wasm |
| `node:http` / `node:https` | Node 22.17.0 内置 | 健康检查请求（带 Basic） |
| `003` / `004` / `007` / `002` | 本工程模块 | 路径契约、凭据、宿主、阶段 |
| `scripts/smoke-node22.mjs` | 本工程（005） | host 侧同断言门禁 |

## 2. 关键决策

| 决策 | 结论 | 依据 |
|------|------|------|
| 启动形态 | stock CLI bundle（`argv` + `import()`），不新增上游入口 | ✅ 工程规划 §3.5 |
| argv | `["node","opencode.mjs","serve","--hostname","0.0.0.0","--port","<随机>"]` 固定六元素 | ✅ `serve` 参数集 |
| 绑定地址 | `0.0.0.0` | 🔶 loopback 隔离 |
| 端口 | 随机高位端口 + **必须回读** | 避免冲突与白屏 |
| 密码 | `OPENCODE_PASSWORD`（004 单一来源） | ✅ 密码必填 |
| 健康检查 | `GET /api/info` 200；30s 上限；指数退避 | 工程规划 §5.2 |
| UI | 使用内嵌 UI（同源 SPA） | ✅ `web-ui.ts` 同源托管 |
| 前端工程 | 不自建、不关内嵌 UI、不用自定义协议/preload | 简化与合规 |
| CSP / CORS | 不改写 | 同源加载不需要；改 CSP 属禁止项 |
| 离线 | 三项 env 开关关闭对应能力 | ✅ 上游支持 |
| mDNS | 不启用 | ✅ v2 无 `--mdns` |
| 逃生口 | 不预设；仅在 stock 契约不足时启用（需先留对照记录） | 工程规划 §3.5 |
| 就绪判据 | 不用「端口可连接」代替 `/api/info` 200 | 服务端可能先监听后装配 |

## 3. 数据模型

### 3.1 实体定义

```js
bootSpec = {
  bundlePath: '<userData>/opencode-dist/opencode.mjs',
  argv: ['node', 'opencode.mjs', 'serve', '--hostname', '0.0.0.0', '--port', String(port)],
  env: {
    OPENCODE_PASSWORD,                 // 004 注入
    OPENCODE_NODE_ASSETS_DIR,          // <userData>/opencode-dist/assets
    OPENCODE_DISABLE_MODELS_FETCH: '1',
    OPENCODE_FILEWATCHER_DISABLE: '1',
    OPENCODE_DISABLE_FFF: '1',
    OPENCODE_CLIENT: 'desktop',        // 002 装配
    // 可选：OPENCODE_MODELS_PATH、OPENCODE_DB、XDG_*/HOME/TMPDIR（002 装配）
  },
  cwd: '<userData>',
}

endpoint = { host: '0.0.0.0', port, url: 'http://<局域网IP>:<port>/', passwordRef }

healthCheck = { path: '/api/info', timeoutMs: 30000, attempts: 0, lastError: null, readyAt: null }

bootDiagnostics = { bundleSha8, nodeVersion, assetsDir, port, startupMs }
```

### 3.2 状态转换

```
assembling（装配 argv/env）→ starting（宿主内 import + serve）
  → polling（GET /api/info，退避 200ms→1s，上限 30s）
      ├─ 200 → ready（记录 BootDiagnostics，交给 001 加载 UI）
      └─ 超时/持续失败 → failed（写 __hostError，驱动 health 阶段失败）
ready → serving（UI 与 /api/* 同源可用）→ quitting（由 002 触发关闭）
```

### 3.3 校验规则

- `argv` 必须精确匹配六元素（顺序与取值），否则视为装配缺陷（断言并中止启动）。
- `env` 必须包含 `OPENCODE_PASSWORD`（非空）、`OPENCODE_NODE_ASSETS_DIR`（指向存在的目录）、三项降级开关；缺一即失败，不得「靠默认值」。
- 端口必须是 1..65535 的整数且与实际监听端口一致（由回读值决定）。
- `/api/info` 判定必须带凭据；401/403 均视为未就绪（并记录具体状态码，便于区分「凭据不符」与「服务未装配完」）。

## 4. 接口契约

### 4.1 本模块提供

| 接口 | 说明 |
|------|------|
| `buildServerBootSpec({ assetsDir, port, passwordHandle })` | 生成 argv/env（单一来源） |
| `startServer(bootSpec)` | 在宿主内以 CLI 语义启动 bundle（委托 007 的宿主） |
| `waitHealthy({ timeoutMs, secretHandle })` | 退避轮询 `/api/info`，返回 `{ ok, status, attempts, lastError }` |
| `serverEndpoint()` | 返回 `{ host, port, url }` 供 001/004 使用 |
| `bootDiagnostics()` | 返回启动诊断（脱敏） |
| 内嵌 UI 断言 | `GET /` 含 v2 UI 标记；`/api/*` 走 API；未命中回落 `index.html` |

### 4.2 本模块消费

| 来源 | 契约 |
|------|------|
| 003-artifact-bootstrap | `artifactRoot()`、`assetsDir()` |
| 004-request-hooks | `secretHandle().getAuthHeader()`、`OPENCODE_PASSWORD` 注入事实 |
| 007-runtime-host | `startHost({ bundlePath, argv, env, cwd })` → `HostHandle` |
| 002-lifecycle | `health` 阶段的调用时机与失败展示；`TMPDIR`/`XDG_*`/`OPENCODE_CLIENT` 已装配 |
| 上游 env 契约 | `OPENCODE_NODE_ASSETS_DIR`、`OPENCODE_DISABLE_MODELS_FETCH`、`OPENCODE_FILEWATCHER_DISABLE`、`OPENCODE_DISABLE_FFF`、`OPENCODE_MODELS_PATH`、`OPENCODE_DB` |
| `scripts/smoke-node22.mjs` | host 侧同一组断言（六项） |

## 5. 实现策略

### 5.1 关键算法

- **启动**：装配 argv/env → 交由 007 的宿主执行（B：主进程内 `await import()`；A：sidecar 设 `process.argv` 后 import；C：worker 内同样设置）→ 宿主回传实际端口。
- **端口回读**（三选一，按实测可用性定；⬜ 待验证）：
  1. 宿主内直接调用路径：若宿主内以编程方式拿到服务端返回的 `address`，直接取其端口；
  2. 客户端路径（stock CLI）：`--port <自选高位随机>`，启动前用 `net.createServer().listen(port)` 探测占用，失败则重新抽号；
  3. `--port 0`：由 OS 分配，端口从服务端日志/输出解析（依赖输出格式，最不确定）。
  **决策规则**：优先 ①；否则 ②；仅当两者均不可行才评估 ③（并把结论写入 `docs/真机验证记录.md`）。
- **健康检查**：`GET http://127.0.0.1:<port>/api/info` 由**宿主同进程**发起（用于快速判就绪），与外部局域网校验（P0-1 第 ⑤ 项）区分；退避 200ms→1s；成功即记录耗时。
- **UI 断言**：`GET /` 取首屏 HTML，断言包含 v2 UI 标记（由 host 侧一次性确定具体标记串并固化到断言常量）。
- **诊断**：`process.versions.node`、bundle 文件 SHA-256 前 8 位（复用 003 已算的值）、`assets` 目录、端口、耗时——统一交给 002 的阶段轨迹记录。

### 5.2 错误处理

- 端口探测失败（多次抽号仍被占用）→ 记录并重试最多 N 次（N 由实现常量给出），耗尽即 `host` 阶段失败。
- `import()` 抛错 → 扁平化错误链（`AggregateError` 递归 + `cause`，深度 ≤ 6，截断 ≤ 2500）写 `__hostError`。
- `assets` 目录缺失或 `app-archive.bin` 缺失 → 启动前断言失败（避免「服务端起来了但 UI 404」）。
- 健康检查返回 401/403 → 单独标注「凭据不符」（与 004 联动排查），不混同为「未就绪」。
- 原生件加载失败（`#pty` 等）→ 若发生说明补丁 0003 未生效：记录为构建缺陷并阻断（不允许带病上真机）。

### 5.3 降级

- **能力降级**（明示）：搜索（`fff`/`rg` 均不可用）返回空并提示；插件默认 L0 关闭；热重载不可用（watcher 关闭）。
- **不降级**：不改 CSP、不改 CORS、不自建前端、不用固定端口、不启用 mDNS、不用调试开关。
- 逃生口（新增 Vite 入口调用 `ServerProcess.start`）**不是降级**，而是契约不足时的受控替代路径，启用前必须有对照记录。

## 6. 测试与验证

### 6.1 host 侧

- `node scripts/smoke-node22.mjs`（Node 22.17.0）六项断言：`--version`、`--help`、`serve` 启动、`GET /api/info` 200、`GET /` 含 v2 UI 标记、`GET /api/event` 首事件。失败即阻断流水线（005 的门禁）。
- 离线模拟：把 `OPENCODE_MODELS_URL` 指向不可达地址（或断网）后启动，断言仍能就绪（证明 `OPENCODE_DISABLE_MODELS_FETCH=1` 生效）。
- 端口策略验证：以不同随机端口连续启动两次 host 侧服务，断言都成功且端口不同；再造一次「端口被占用」场景，断言按规则换号。
- 断言 `argv` 与 `env` 装配的单一来源（`buildServerBootSpec`）输出，防止其它模块重复拼接。
- 无外网与无 `XDG_*` 环境下的失败模式验证：断言错误信息可读（便于真机排障）。

### 6.2 真机命令

```bash
hdc app install -r electron/build/default/outputs/default/electron-default-signed.hap
hdc shell aa start -a EntryAbility -b org.fellow99.oc.OCDesktop
hdc shell "hilog -x | grep oc-desktop"        # 端口、耗时、健康检查尝试次数与状态码

# 外部（局域网）就绪校验：必须带凭据
curl -u "<user>:<pass>" http://<设备局域网IP>:<port>/api/info
curl -u "<user>:<pass>" http://<设备局域网IP>:<port>/ | head -n 5   # SPA index.html
# SSE 首事件（真机侧观察 UI 行为；命令行侧可用 -N 长连接观察）
curl -N -u "<user>:<pass>" http://<设备局域网IP>:<port>/api/event

# 端口占用与僵尸核查（applet 可用性 ⬜ 待验证）
hdc shell "netstat -anp | grep <port>"
hdc shell "ps -A | grep oc-desktop"
```

- 真机 MUST 记录：实际端口、`/api/info` 首次成功耗时、首屏耗时、断网启动结果、降级提示可见性，落 `docs/真机验证记录.md`。

### 6.3 验收口径

- spec §5 七个场景全绿；host 门禁与真机就绪一致；三项降级在文档与 UI 均有明示；端口与就绪判据均有可复核证据。

## 7. 文件清单

| 文件（相对工程根） | 用途 |
|--------------------|------|
| `src-main/main.js` | `buildServerBootSpec`、`waitHealthy`、启动诊断、`__hostError` |
| `src-main/sidecar.js` | 候选 A/C 宿主入口：设置 `process.argv` 后 import bundle 并回传端口 |
| `scripts/smoke-node22.mjs` | host 侧六项门禁（与 005 共用） |
| `scripts/lib/credentials.mjs` | 门禁与健康检查共用的凭据生成/头拼接（与 004 同源） |
| `web_engine/src/main/resources/resfile/resources/app/opencode-dist.tar.gz` | 产物来源（含 `assets/app-archive.bin`） |
| `docs/真机验证记录.md` | 端口策略结论、离线启动、SSE、耗时留证 |

## 8. 与规格的交叉引用

| 规格需求 | 落点 |
|----------|------|
| FR-008-001 ~ 009（启动契约） | `src-main/main.js`（`buildServerBootSpec`）、`src-main/sidecar.js` |
| FR-008-010 ~ 014（健康检查与就绪） | `src-main/main.js`（`waitHealthy` / `bootDiagnostics`） |
| FR-008-015 ~ 020（内嵌 UI） | 上游 `web-ui.ts` 同源托管 + `src-main/main.js` 的 UI 断言；不改 CSP/CORS |
| FR-008-021 ~ 027（降级与边界） | env 开关集合（`buildServerBootSpec`）、`docs/鸿蒙环境能力清单.md`、`docs/真机验证记录.md` |
