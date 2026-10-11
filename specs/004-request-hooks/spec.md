# 请求头与凭据钩子（004-request-hooks）—— 规格

> **Module:** 004-request-hooks ｜ **Status:** Proposed ｜ **Last Updated:** 2026-10-11 ｜ **上游基线:** opencode v2.0.26（Branch_v2.0.26）

## 1. 模块概述

### 1.1 目的（Why this module exists）

让渲染进程发出的请求能被 opencode v2 服务端接受，并保证凭据不泄漏：

1. **凭据注入**：v2 服务端**密码必填**（✅ `packages/cli/src/server-process.ts`），本模块生成随机密码并经 `OPENCODE_PASSWORD` 注入宿主，同时向渲染层与健康检查提供同一份凭据；
2. **请求头改写**：渲染层用**局域网 IP** 访问服务端（🔶 loopback 隔离所迫），本模块对发往该 `host:port` 的请求把 `Host`/`Origin` 改写为 `127.0.0.1:<port>`（继承 dsh 的思路），使服务端的来源/主机判定通过；
3. **代理绕过**：`NO_PROXY`/`no_proxy` 与 `proxy-bypass-list` 保证同源请求不被代理劫持；
4. **R2 分支门控**：ArkWeb 通道是否需要头改写与凭据注入**不做预设**，由 P0-2 探针或源码结论裁决，并保留开关。

### 1.2 解决的问题（What pain points it addresses）

- **密码必填**：v2 无密码即失败或进程内随机生成（UI 无从得知）→ 必须由壳生成并注入，且渲染层要拿到它。
- **来源判定不确定**：服务端是否只信任 loopback 请求（Host/Origin 校验）在本工程**未验证**（⬜）；若不改写，真机可能表现为 401/403 或「界面能开、特权接口全挂」。
- **凭据泄漏面**：密码落入日志、诊断摘要、磁盘文件或 URL query 都是不可接受的；作用域写错还会把凭据发到外部域名。
- **代理干扰**：设备或运行时若存在系统代理，明文局域网请求可能被错误转发（⬜ 系统代理行为未验证，工程规划 O4）。
- **R2 能力未知**：ArkWeb 侧注入请求头的机制与必要性都未验证（⬜）→ 必须先留开关与结论记录点，避免「照抄 R1 方案」或「什么都不做」。

### 1.3 范围（Scope）

**包含**：

- 随机密码生成、注入路径与「不落盘、不落日志」纪律；
- 凭据读接口（供健康检查、渲染通道、验证脚本复用）；
- R1 请求头钩子：作用域精确匹配、`Authorization` 注入、`Host`/`Origin` 改写、业务头不干预；
- 代理绕过设置（`NO_PROXY`/`no_proxy`、`proxy-bypass-list`）与其值记录；
- R2 分支的开关、门控条件与结论记录点。

**不包含**：

- 服务端 `argv`/env 全量与健康检查接口定义（见 `008-server-ui-load`）；
- 渲染通道实现与八项探针执行（见 `001-render-channel`，本模块消费其结论）；
- 沙箱环境变量装配（见 `002-lifecycle`；本模块只负责「密码与代理」这两组变量的单一来源）；
- CORS 配置与 CSP 改写（本模块明确**不做**：同源加载不需要，且改 CSP 属禁止项）。

## 2. 用户故事

- 作为用户，我希望界面直接连上服务端，不需要我输入或粘贴密码。
- 作为用户/安全评审者，我希望密码只在内存里，不落盘、不出现在任何日志或界面文本中。
- 作为研发，我希望局域网访问被拦住时能立刻分辨是「缺凭据」还是「来源/主机判定」问题。
- 作为研发，我希望 R2 是否需要头改写有明确结论与开关，而不是靠猜。
- 作为研发，我希望代理相关问题（请求走错方向）能在启动日志里一眼看出来。

## 3. 功能需求

### 3.1 密码与凭据来源

- FR-004-001 系统 MUST 在启动时生成高熵随机密码（≥128 bit）并以 `OPENCODE_PASSWORD` 注入宿主环境（`OPENCODE_SERVER_PASSWORD` 为上游等价回退名；本工程 MUST 只选一个作为主注入名并在文档记录）。
- FR-004-002 密码 MUST 只存在于进程内存与宿主环境变量；MUST NOT 写入任何文件、MUST NOT 出现在日志/诊断摘要/界面文本中（统一脱敏）。
- FR-004-003 系统 MUST 提供单一凭据读接口，供健康检查（008）、渲染通道（001）与真机验证脚本复用同一份凭据。
- FR-004-004 系统 MUST 在每次应用启动时重新生成密码（不复用上次值），并保证旧值不再被任何请求携带。

### 3.2 R1 请求头钩子

- FR-004-005 系统 MUST 为 R1 安装请求钩子，且只对目标 origin（`http://<host>:<port>`）生效；MUST NOT 影响其它域名或端口的请求。
- FR-004-006 钩子 MUST 对匹配请求注入 `Authorization: Basic <base64>`；⬜ 待验证：上游服务端接受的 Basic 用户名口径（验证方式：读 `packages/server/src/**` 鉴权实现，并在真机用两种用户名各请求一次 `GET /api/info`）。
- FR-004-007 钩子 MUST 把 `Host` 头改写为 `127.0.0.1:<port>`，并把 `Origin` 头（若存在）改写为 `http://127.0.0.1:<port>`。
- FR-004-008 钩子 MUST NOT 改写 `Cookie`、`Content-Length`、`Content-Type`、`Accept-Encoding`、`Accept` 等业务头；SSE（`/api/event`）长连接 MUST NOT 被破坏。
- FR-004-009 钩子 MUST 覆盖渲染层的页面导航、`fetch`/XHR、SSE 与（若上游使用）WebSocket 升级请求，以及主进程发起的同源请求。
- FR-004-010 钩子安装 MUST 幂等：重复安装不产生重复改写或重复凭据头。

### 3.3 代理绕过

- FR-004-011 系统 MUST 在 `NO_PROXY` 与 `no_proxy` 中追加 loopback（`127.0.0.1`、`localhost`）与本次使用的局域网地址。
- FR-004-012 R1 MUST 设置 `app.commandLine.appendSwitch("proxy-bypass-list", "<-loopback>")`。
- FR-004-013 系统 MUST 在启动日志中记录代理相关变量的最终值（脱敏后）与开关应用结果，便于排查「请求走错方向」。

### 3.4 R2 分支与门控

- FR-004-014 R2 是否需要头改写与凭据注入 MUST 由 P0-2 探针结论（001 的 ③/⑦ 项）或源码级结论裁决；本规格 MUST NOT 预设结论。
- FR-004-015 系统 MUST 提供独立开关，使 R2 分支的「头改写」与「凭据注入」可分别启用/禁用；关闭时必须记录依据（探针记录 ID 或源码位置）。
- FR-004-016 若结论是「R2 需要注入请求头」，实现 MUST 使用 ArkWeb 提供的受支持机制（如请求拦截/自定义响应），MUST NOT 使用「放宽 CSP 或改写页面内容（如注入脚本内嵌凭据）」的方式；⬜ 具体机制待 P0-2 第 ③ 项的最小 PoC 验证。
- FR-004-017 系统 MUST NOT 通过本模块修改服务端下发的 CSP，也 MUST NOT 新增 CORS 例外（✅ 上游 `packages/server/src/cors.ts#isAllowedCorsOrigin` 只回写头、不拒绝来源；同源加载无需配置）。
- FR-004-018 R2 分支若判定为「不需要头改写」，系统 MUST 保留 R1 的完整实现（回退通道必须仍可用），并在 `docs/真机验证记录.md` 记录该结论。

## 4. 关键实体

| 实体 | 说明 | 关键属性 |
|------|------|----------|
| 服务端密码（ServerSecret） | 会话级随机密码 | `value`（仅内存）、`source`(`generated`)、`bornAt`、`injected`（是否已注入宿主 env） |
| 目标来源（TargetOrigin） | 钩子作用域 | `scheme`(`http`)、`host`（局域网 IPv4 或 `127.0.0.1`）、`port`（宿主实际端口） |
| 改写规则（HeaderRewriteRule） | 单条头改写 | `scope`(`host:port`)、`name`(`Authorization`/`Host`/`Origin`)、`value`（日志中脱敏） |
| 代理配置（ProxyConfig） | 绕过设置 | `noProxy`、`bypassSwitch`(`<-loopback>`)、`appliedAt` |
| 凭据句柄（SecretHandle） | 供其它模块取用 | `getAuthHeader()`、`assertNotLogged()`（自检脱敏） |

## 5. 验收场景

### 场景 1：凭据注入生效（R1）

- Given 钩子已安装、密码已注入宿主
- When 渲染层请求 `GET /api/info`（不带自定义头）
- Then 请求被注入 `Authorization`，返回 200；若强制关闭钩子，同一请求返回 401（对照实验）

### 场景 2：Host/Origin 改写生效

- Given 钩子已安装
- When 渲染层用 `http://<局域网IP>:<port>/` 访问一个依赖来源判定的接口
- Then 服务端看到的是 `127.0.0.1:<port>`（由宿主日志或服务端行为区分），请求成功

### 场景 3：作用域精确（不外泄凭据）

- Given 客户端从 UI 打开一个外部链接或请求第三方域
- When 该请求经由渲染层发出
- Then 请求 MUST NOT 携带 `Authorization`，且 `Host`/`Origin` MUST NOT 被改写

### 场景 4：SSE 不被破坏

- Given UI 已加载并订阅 `/api/event`
- When 持续观察事件流
- Then 能收到首个事件 `server.connected` 与后续事件；连接不因头改写被截断

### 场景 5：密码不落盘、不落日志

- Given 应用已启动并完成若干请求
- When 在 `<userData>` 内检索密码明文、并检查 `hilog -x | grep oc-desktop` 输出
 - Then 均无明文出现（诊断摘要与日志中只出现脱敏后的固定掩码，如 `***`）

### 场景 6：R2 门控

- Given R2 通道启用、钩子开关处于关闭状态（依据：探针结论）
- When 打开 R2 并请求 `/api/info`
- Then 请求成功且不依赖 R1 钩子；结论与开关状态已记录到 `docs/真机验证记录.md`

### 场景 7：代理绕过

- Given 环境中存在一个不可达的代理设置
- When 渲染层请求目标 origin
- Then 请求仍直连成功（`NO_PROXY`/`no_proxy` 与 `<-loopback>` 生效），启动日志可读到代理变量的最终值

## 6. 非功能需求

- **性能**：钩子为每请求常量开销，MUST NOT 缓冲或重写请求体。
- **可靠性**：钩子安装失败 MUST 被记录并 fail-visible（症状是界面加载但接口未授权）；MUST NOT 静默继续。
- **可维护性**：作用域、头名、开关、代理变量集中在少数常量；凭据读接口唯一。
- **安全性**：密码不落盘不落日志；作用域精确避免凭据外泄；不改 CSP、不加 CORS、不把凭据放入 URL；明文 HTTP 仅在「随机端口 + 密码 + 局域网地址」组合下使用。
- **幂等性**：重复安装钩子、重复设置代理变量、重复读取凭据均无副作用。

## 7. 假设与约束

- 假设 ✅：v2 服务端密码必填（`OPENCODE_PASSWORD` / `OPENCODE_SERVER_PASSWORD`；两者皆无则失败或进程内随机生成）。
- 假设 ✅：上游 CORS 白名单只回写响应头、不拒绝来源 → 同源加载无需额外配置。
- 假设 🔶：渲染进程访问 `127.0.0.1` 被 loopback 隔离拦截 → 必须绑 `0.0.0.0` + 局域网地址，头改写是配套手段。
- ⬜ 待验证：服务端是否真的以 `Host`/`Origin` 判定来源（dsh 的经验来自其自身围栏，本工程 MUST 实测；验证方式：真机分别「改写/不改写」各请求一次 `GET /api/info` 与一个需要授权的接口）。
- ⬜ 待验证：Basic 用户名口径（服务端是否接受任意用户名）。
- ⬜ 待验证：ArkWeb 侧注入请求头的受支持机制与必要性（P0-2 第 ③ 项）。
- ⬜ 待验证：系统代理行为与系统 CA（工程规划 O4；验证方式：真机设置代理与自签 CA 场景各跑一次请求）。
- 约束：R2 即使判定「不需要头改写」，本模块仍 MUST 保留 R1 实现（回退通道）。
- 约束：MUST NOT 把凭据写入 URL query、页面脚本或任何可被页面读取的位置。

## 8. 依赖

**上游（被本模块消费）**：

- `packages/cli/src/server-process.ts`（密码与 env 契约，✅ 源码）；
- `packages/server/src/**` 鉴权实现（⬜ 待核实的文件位置与用户名口径）；
- `packages/server/src/cors.ts#isAllowedCorsOrigin`（✅ 只回写头、不拒绝来源）。

**本工程（被本模块消费）**：

- `007-runtime-host`：宿主就绪后提供实际端口（作用域由端口决定）；
- `008-server-ui-load`：健康检查请求也需携带同一凭据；
- `002-lifecycle`：环境变量单一来源纪律（代理变量归属本模块）；
- `001-render-channel`：R1 通道必须已安装钩子才允许打开；R2 分支由本模块开关门控。

**下游（消费本模块）**：

- `001-render-channel`：R1 的请求必须被注入凭据与改写头；
- `008-server-ui-load`：`GET /api/info` 的凭据来源；
- 真机验证脚本 / `scripts/smoke-node22.mjs`（host 侧用同一凭据生成逻辑）。
