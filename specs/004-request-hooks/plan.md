# 请求头与凭据钩子（004-request-hooks）—— 实现方案

> **Module:** 004-request-hooks ｜ **Status:** Proposed ｜ **Last Updated:** 2026-10-11 ｜ **上游基线:** opencode v2.0.26（Branch_v2.0.26）
> 对应规格：[spec.md](./spec.md)

## 1. 技术上下文

### 1.1 运行时环境

- 主进程运行在 ArkTS UIAbility 进程内（Electron 37 / Node 22.17.0 / Chromium 138 / ABI v138）；钩子安装在 Electron `session` 上，因此只对 **R1（Chromium）** 通道生效。
- **R2（ArkWeb）** 的请求由应用进程内的 ArkWeb 引擎发出，不经过 Electron `session` → 本模块为 R2 只保留开关与结论记录点。
- 目标 origin 由 007 提供的宿主实际端口与 001 的可达地址共同决定。
- 设备侧 loopback 隔离使渲染层必须用局域网地址（🔶），这正是需要 `Host`/`Origin` 改写的原因。

### 1.2 依赖

| 依赖 | 版本/来源 | 用途 |
|------|-----------|------|
| Electron `session.webRequest.onBeforeSendHeaders` | 运行时内置 | 请求头改写与凭据注入 |
| Electron `app.commandLine.appendSwitch` | 运行时内置 | `proxy-bypass-list` |
| `node:crypto` `randomBytes` | Node 22.17.0 内置 | 密码生成与 base64 |
| `node:process.env` | 内置 | `OPENCODE_PASSWORD` 注入与 `NO_PROXY` 追加 |
| `007` / `008` / `001` | 本工程模块 | 端口、健康检查凭据、通道门控 |

## 2. 关键决策

| 决策 | 结论 | 依据 |
|------|------|------|
| 密码来源 | 壳进程内随机生成（≥128 bit），经 `OPENCODE_PASSWORD` 注入宿主 | ✅ 上游密码必填 |
| 密码持久化 | 不落盘、不复用 | 安全要求；重启即换 |
| 凭据形式 | `Authorization: Basic`（用户名口径 ⬜ 待核实） | 上游桌面端同思路；具体口径以源码为准 |
| 凭据读接口 | 单一 `SecretHandle.getAuthHeader()` | 避免多处拼接与泄漏 |
| 作用域 | 严格等于 `http://<host>:<port>`（含端口） | 防凭据外泄 |
| 头改写 | `Host` → `127.0.0.1:<port>`；`Origin`（若存在）→ `http://127.0.0.1:<port>` | 继承 dsh `installLoopbackHeaderRewrite` 思路 |
| 业务头 | 不改写 | 避免破坏 SSE/上传 |
| 顶层导航的 `extraHeaders` | 不作为唯一手段（覆盖不到 `fetch`/SSE） | 必须用 session 级钩子 |
| 代理 | `NO_PROXY`/`no_proxy` 追加 + `proxy-bypass-list=<-loopback>` | 工程规划 §5.4 |
| R2 分支 | 开关默认关闭，结论驱动 | 未验证项，禁止预设 |
| CSP / CORS | 一律不改 | 同源加载不需要；改 CSP 属禁止项 |

## 3. 数据模型

### 3.1 实体定义

```js
secret      = { value, source: 'generated', bornAt, injected: true, header: 'Basic <base64>' }
targetOrigin= { scheme: 'http', host: '<局域网IPv4|127.0.0.1>', port: <实际端口> }
rule        = { scope: '<host>:<port>', name: 'Authorization'|'Host'|'Origin', value }
proxyConfig = { noProxy: '<追加后的值>', bypassSwitch: '<-loopback>', appliedAt }
```

### 3.2 状态转换

```
init → secretGenerated → injectedToHostEnv → hooksInstalling → hooksInstalled
                        └─ 安装失败 → failed（写 __hookError；R1 通道标记不可用）
hooksInstalled → 请求路径：match(scope) ? rewrite : pass-through
R2 分支：pending-probe →（探针结论）→ disabled（记录依据）| enabled-via-ArkWeb（机制待验证）
```

### 3.3 校验规则

- 作用域匹配：`new URL(details.url)` 的 `hostname` 与 `port` 必须与 `targetOrigin` **完全相等**，否则不改写、不注入。
- 注入前断言 `secret.value` 非空且长度 ≥ 16 字节；断言同一次请求只注入一个 `Authorization`（幂等）。
- 日志与诊断：所有涉及密文的输出必须过脱敏函数（正则匹配密码值替换为 `***`）。
- `NO_PROXY` 追加必须去重且保持原有条目顺序（不改写既有值语义）。

## 4. 接口契约

### 4.1 本模块提供

| 接口 | 说明 |
|------|------|
| `createServerSecret()` | 生成会话级密码与 `Authorization` 头值（仅内存） |
| `installRequestHooks({ session, targetOrigin, secret, enable })` | 安装/更新 R1 请求头钩子（幂等） |
| `ensureNoProxy(targetOrigin)` | 追加 `NO_PROXY`/`no_proxy` 并应用 `proxy-bypass-list` |
| `secretHandle()` | 凭据读接口：`getAuthHeader()`、`redact(text)` |
| `setR2HookPolicy(policy)` | R2 分支开关与依据记录（`policy = { rewrite, credential, basis }`） |
| `globalThis.__hookError` | 钩子安装失败摘要（供 002 汇总展示） |

### 4.2 本模块消费

| 来源 | 契约 |
|------|------|
| 007-runtime-host | 宿主实际端口（作用域的唯一来源） |
| 001-render-channel | `pickReachableHost()` 的可达地址；通道选择与打开时序 |
| 008-server-ui-load | 健康检查的请求方式（消费本模块凭据） |
| 上游 env 契约 | `OPENCODE_PASSWORD` / `OPENCODE_SERVER_PASSWORD`（✅ `packages/cli/src/server-process.ts`） |
| 构建期开关 | R2 钩子策略默认值（随骨架落地对齐命名） |

## 5. 实现策略

### 5.1 关键算法

- **密码与注入**：`randomBytes(32).toString('base64url')` → `process.env.OPENCODE_PASSWORD = value`（宿主启动前完成）→ 派生 `Authorization: Basic base64(<用户名>:<密码>)`（用户名口径 ⬜ 待核实后固化）。
- **钩子安装**：
  ```js
  session.webRequest.onBeforeSendHeaders({ urls: ['http://*/*'] }, (details, cb) => {
    const u = new URL(details.url)
    if (u.hostname !== host || u.port !== String(port)) return cb({ requestHeaders: details.requestHeaders })
    const h = { ...details.requestHeaders, Authorization: authHeader, Host: `127.0.0.1:${port}` }
    if (h.Origin) h.Origin = `http://127.0.0.1:${port}`
    cb({ requestHeaders: h })
  })
  ```
  说明：用 `http://*/*` 宽过滤器 + 自行精确匹配，避免 Electron 的 URL 模式语法在端口/主机匹配上的歧义；匹配失败原样放行。
- **代理**：`NO_PROXY` 追加 `127.0.0.1,localhost,<局域网IP>`；`no_proxy` 同步设置（设备侧变量名大小写敏感度 ⬜ 待验证，故两者都设）。
- **R2 策略**：默认 `{ rewrite: false, credential: false, basis: 'pending-p0-2' }`；探针结论落地后更新 `basis` 并写入 `docs/真机验证记录.md`。

### 5.2 错误处理

- 钩子安装抛错 → 写 `__hookError` + 日志；R1 通道标记不可用（001 据此 fallback 或提示），MUST NOT 让界面停在「能开但全 401」的静默态。
- 密码注入失败（宿主 env 未生效）→ 记为 `host` 阶段失败（002），因为服务端会自行随机生成密码，UI 将无法复用。
- 请求改写异常（头对象只读等）→ 记日志并原样放行（不阻断请求），同时在首次发生时报错一次。

### 5.3 降级

- 钩子不可用 → R1 通道降级为不可用，按 001 的通道策略回到 R2（若可用）；两侧都不可用则 fail-visible。
- 不改写 `Host`/`Origin` 的「裸访问」不作为降级路径（会表现为部分接口失败，属静默故障）。

## 6. 测试与验证

### 6.1 host 侧

- 用与运行时相同的凭据生成与头拼接逻辑，对 `scripts/smoke-node22.mjs` 启动的服务端发 `GET /api/info`：带 `Authorization` → 200；不带 → 401（对照）。
- 作用域断言（离线纯函数测试）：`http://192.168.1.9:49152/api/info` 命中；`https://example.com/`、`http://127.0.0.1:49153/`、`http://192.168.1.9:49151/` 均不命中。
- 脱敏断言：把密码拼进日志文本后过 `redact()`，断言输出不含明文。
- 用户名口径核实：以两种用户名（例：`opencode:pass` 与 `:pass`）各请求一次，记录哪一种返回 200，并回写工程规划与本文档。

### 6.2 真机命令

```bash
hdc app install -r electron/build/default/outputs/default/electron-default-signed.hap
hdc shell aa start -a EntryAbility -b rg.fellow99.oc.OCDesktop

hdc shell "hilog -x | grep oc-desktop"        # 钩子安装结果、代理变量值（脱敏）、__hookError
# 渲染侧取证（R1，debug 构建）
hdc fport tcp:19229 tcp:9229
# 在 CDP 中执行：await fetch('/api/info').then(r => r.status)  → 期望 200
# 对照实验：临时关闭钩子后再执行一次 → 期望 401（据此判定「来源判定」是否真的存在）
```

- 真机 MUST 记录：控制器/接口对照结果（200 vs 401）、是否真的需要 `Host`/`Origin` 改写、代理变量最终值，落 `docs/真机验证记录.md`。

### 6.3 验收口径

- spec §5 七个场景全绿；两份对照实验（带/不带凭据、改写/不改写）结论明确；密码在磁盘与日志中均无明文。

## 7. 文件清单

| 文件（相对工程根） | 用途 |
|--------------------|------|
| `src-main/main.js` | 密码生成与注入、`installRequestHooks`、`ensureNoProxy`、`secretHandle`、`__hookError` |
| `src-main/sidecar.js` | 候选 A 宿主入口：`OPENCODE_PASSWORD` 随宿主 env 传入（不落盘） |
| `scripts/smoke-node22.mjs` | host 侧凭据对照实验（200/401）与用户名口径核实 |
| `docs/真机验证记录.md` | 对照实验结果、R2 策略依据、代理变量留证 |

## 8. 与规格的交叉引用

| 规格需求 | 落点 |
|----------|------|
| FR-004-001 ~ 004（密码与凭据来源） | `src-main/main.js`（`createServerSecret` / `secretHandle`）、`src-main/sidecar.js` |
| FR-004-005 ~ 010（R1 请求头钩子） | `src-main/main.js`（`installRequestHooks`） |
| FR-004-011 ~ 013（代理绕过） | `src-main/main.js`（`ensureNoProxy` + `appendSwitch`） |
| FR-004-014 ~ 018（R2 分支与门控） | `src-main/main.js`（`setR2HookPolicy`）、`docs/真机验证记录.md`、001 的探针结论 |
