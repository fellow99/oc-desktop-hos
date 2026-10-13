# 102 — 鸿蒙 JS 工具（opencode 插件替代）功能规格

> **Module:** extensions ｜ **Status:** Implementing ｜ **Last Updated:** 2026-10-13
> **需求编号:** 102-harmony-js-tools ｜ **需求名称:** 用 JS 插件替代设备上不可得的工具能力
> **git 分支:** 不改动 ｜ **上游基线:** opencode `v2.0.26`（`9b4ec5714d`）
> **回引:** `docs/鸿蒙环境能力清单.md` §3（L1–L4 分层）、§5（待验证）、`docs/工程规划-V2.md` §7.4/§7.5
> **参考实现:** `pi-desktop-hos` 的 `specs/102-harmony-js-tools/`（同型工程的 JS 工具三件套）

## 1. 目的

`docs/鸿蒙环境能力清单.md` 把设备上的能力缺口分成 L1（平台硬约束）/ L2（原生产物缺失）/ L3（本工程配置）/
L4（上游接口缺口）。其中 **L4 与部分 L2 可以用「纯 JS」在服务端进程内补齐**，无需 PTY、无需执行外部 ELF、
无需原生模块。本规格回答两件事：

1. **可行性分析**：逐条判定哪些缺口可以用 JS 插件替代、哪些不能（§3）。
2. **落地**：把判定为「可替代」的三项做成 opencode 插件并接入构建/启动链（§4 起）。

## 2. 范围

**In scope**：`shell`（命令执行）、`grep`（内容搜索）、`glob`（文件名搜索）三个内置工具的 JS 替代；
插件在本工程的物化路径与启动链接入；host 侧与真机验证口径。

**Out of scope**：PTY/终端面板（L1）；`fff` FFI 绑定（L1/L2）；LSP / formatter / MCP 外部进程（L1）；
git/VCS（需 ELF 或巨量自研）；图片缩略图（可用但体积/收益不符）；后台常驻/开机自启/通知（L1）；
插件**在线安装**（registry 可达性与 hmdfs 语义未证）；不改上游、不改 git 分支。

## 3. 可行性分析（本规格的核心结论）

判定口径：**能否只在服务端进程内、用纯 JS/Node 内建能力实现，且不依赖 PTY、不 spawn 外部 ELF、不加载 `.node`**。

| # | 缺口（源自 v0.1 清单） | 根因层 | 可否 JS 替代 | 判定依据 |
|---|---|---|---|---|
| G1 | `shell` 命令执行（内置 `shell` 工具） | L1（子进程退出事件不可观测） | ✅ **可** | 上游 `shell` 走 `cross-spawn`（纯 JS → `node:child_process`），启动本身可用；但设备上**永不触发** `exit`/`close` 事件、`cp.exec` 永不回调，导致工具**挂死**。改为「常驻 `/system/bin/sh` + 哨兵行」协议，把「结束」判定从进程事件改为 **stdout 哨兵**，可在纯 JS 内完成 |
| G2 | `grep` 内容搜索 | L2（`rg` 是 ELF，且无 `ohos` 平台键） | ✅ **可** | 上游 `grep` **必然**调用 `Ripgrep.Service` → spawn `rg`；`core/src/ripgrep/binary.ts` 的 `PLATFORM` 表**没有** `arm64-ohos` 键 ⇒ 直接抛 `unsupported platform for ripgrep`。纯 JS 递归遍历 + `RegExp` 可覆盖绝大部分用法 |
| G3 | `glob` 文件名搜索 | L2（同上） | ✅ **可** | 同 G2（同一 `Ripgrep.Service`）。纯 JS 遍历 + 通配符转 `RegExp` 可实现 |
| G4 | `fff` 文件选择器（`#fff` FFI） | L1（FFI/ELF 不可执行） | ⚠️ 部分 | `@ff-labs/fff-node` 无 ohos 构件；`Fff.available()` 已能优雅降级，且 `OPENCODE_DISABLE_FFF=1` 可强制走 ripgrep。**但**降级目标 ripgrep 同样不可用（G2），因此必须先把 G2 修掉；`fff` 本身不另做 JS 版 |
| G5 | `read` / `write` / `edit` / `patch` | — | ✅ 无需替代 | 全部走 `node:fs`，设备可用（`chmod` 语义见 v0.1 清单 #7，本工程写入后回读校验） |
| G6 | `webfetch` / `websearch` | — | ✅ 无需替代 | 纯 HTTP（`fetch`）+ 服务端路由 |
| G7 | `LSP` / formatter / MCP 外部进程 | L1 | ❌ **不可** | 需要执行外部可执行文件；设备禁执行自有 ELF，无可用的语言服务器/格式化器/stdio MCP |
| G8 | 终端 PTY（`opencode-pty`、`@lydell/node-pty`） | L1 | ❌ **不可** | SELinux 拒 `forkpty/openpty/popen`；已由补丁 `0003` 打桩降级为「终端不可用」 |
| G9 | git / VCS | L1/L4 | ❌ **不可（本轮）** | 设备无 `git`；纯 JS 实现只读 git 读取可行但工作量与收益不符，且写操作（commit/push）不可行 |
| G10 | 插件通道（npm 在线安装） | L3/L4 | ⚠️ 部分 | 上游**没有** `OPENCODE_DISABLE_PLUGIN*` 硬开关；但插件发现走「配置目录下的 `plugin/` / `plugins/`」⇒ **构建期物化 + 启动期 copy** 即可用本地插件，无需联网安装 |
| G11 | 图片缩略图 | L4 | ⚠️ 可但不做 | 纯 JS 解码可行，但体积/性能代价与 v1 需求不符 |
| G12 | 后台常驻 / 开机自启 / 托盘 / 通知 | L1 | ❌ **不可** | 平台策略问题，与 JS 无关 |

**结论**：本轮实现 **G1、G2、G3** 三项（对应插件 `oc-plugin-harmony-shell`、`oc-plugin-harmony-search`）；
G4/G10 通过「降级 + 构建期物化」处置；其余明确不做并在 §7 登记。

## 4. 上游事实（本规格前提，均已核实）

| # | 事实 | 出处 |
|---|---|---|
| U1 | 插件默认导出契约（promise 口味）：`export default { id: string, setup(context) => Promise<Cleanup\|void>\|void }`；**没有**函数形态的默认导出，也**没有**具名导出插件 | `packages/plugin/src/promise/plugin.ts:56`、`packages/core/src/plugin/module.ts:78` 的 `Schema.Struct({ default: Schema.Union([...]) })` |
| U2 | 自定义工具 = `context.tool.transform(editor => editor.add(toolInfo))` | `packages/core/src/plugin/host.ts`、`packages/plugin/src/promise/tool.ts`（`ToolEditor`） |
| U3 | 工具定义：`{ name, input, description, execute(input, ctx) => Promise<Result>, output? }`；`input` 可用**纯 JSON Schema**（`ValueSchema = Schema.Codec \| StandardSchemaV1 \| JsonSchema`） | `packages/schema/src/tool.ts:44,92-99` |
| U4 | 工具编辑器可 `list()` / `get(id)` / `add()` / `update(id, cb)` / `remove(id)`；**内置工具 id**：`opencode.tool.shell`、`opencode.tool.grep`、`opencode.tool.glob` | `packages/plugin/src/promise/tool.ts`、`packages/core/src/plugin/internal.ts` |
| U5 | 内置工具名：`shell` / `grep` / `glob` / `read` / `write` / `edit` / `patch` / `webfetch` / …；**没有** `bash` 工具 | `packages/core/src/plugin/internal.ts`、`packages/core/src/tool/plugin/*.ts` |
| U6 | `shell` 用 `cross-spawn` spawn（**非 PTY**）；默认超时 120 s；子进程 env 含 `AGENT=1 OPENCODE=1 OPENCODE_SESSION_ID` | `packages/core/src/shell.ts:299`、`packages/util/src/cross-spawn-spawner.ts` |
| U7 | `grep`/`glob` 必然经 `Ripgrep.Service` spawn `rg`；`PLATFORM` 表无 `arm64-ohos` ⇒ 抛 `unsupported platform for ripgrep`；**没有**环境变量可重定向 `rg`（只认 PATH 与 `$XDG_CACHE_HOME/opencode/bin/rg`） | `packages/core/src/tool/plugin/grep.ts`、`glob.ts`、`packages/core/src/ripgrep/binary.ts:98-106` |
| U8 | 插件发现：每个**配置目录**下的 `plugin/` 与 `plugins/` 子目录；配置目录集合 = 全局 `$XDG_CONFIG_HOME/opencode`（或 `OPENCODE_CONFIG_DIR`）+ 各项目根 + `<home>/.claude`、`<home>/.agents`（受 `global` 开关） | `packages/core/src/plugin/source-directory.ts:7-32`、`packages/core/src/config/discovery.ts:27-70` |
| U9 | 无 `OPENCODE_DISABLE_PLUGIN*` 环境变量（仅文档存在、未实现）；`"plugins": ["-*"]` 可丢弃全部非受保护插件 | `packages/core/src/plugin/supervisor.ts:42-50` |
| U10 | 本工程 `src-main/main.js` 已把 `XDG_CONFIG_HOME` 指向 `<userData>/config`、`HOME` 指向 `<userData>` ⇒ 插件物化目标是 `<userData>/config/opencode/plugin/` | `src-main/main.js:96-101`、`plugins/README.md` §3 |
| U11 | 真机上 `symlink` 在**应用域**报 `EACCES` ⇒ 物化必须 **copy** | `docs/鸿蒙环境能力清单.md` #5 |
| U12 | 同型工程 `pi-desktop-hos` 已用同一策略落地三件套（`harmony-exec.js` / `harmony-search.js`），真机验证通过 | `pi-desktop-hos/specs/102-harmony-js-tools/` |

## 5. 需求条目

### 5.1 插件形态与契约

- **FR-tool-001**（MUST）：插件必须是 **ESM**，默认导出 `{ id, setup }`；`id` 全局唯一。
- **FR-tool-002**（MUST）：插件目录名必须符合本工程约定 `oc-plugin-<name>`（kebab-case），且不得含
  `Harmony` / `DeepSeek` 等上架禁用词。
- **FR-tool-003**（MUST NOT）：插件**不得**使用 `node-pty` / `forkpty` / `openpty`；
  **不得** spawn 外部 ELF（`rg`、`git`、`node`、`python3` 等）；**不得**加载任何 `.node`/`.so`。
- **FR-tool-004**（MUST）：插件必须 `export default` 一个 `setup(context)`，并在其中通过
  `context.tool.transform(editor => …)` 注册/覆盖工具。
- **FR-tool-005**（MUST）：插件必须在 `setup` 返回的 cleanup 中释放自身资源（常驻 shell 子进程、定时器）。

### 5.2 `shell` 替代（G1）

- **FR-tool-006**（MUST）：必须移除或覆盖内置 `opencode.tool.shell`，使模型调用 `shell` 时走**非 PTY 常驻
  shell**：一次性 `spawn('/system/bin/sh')` 常驻，通过 stdin 下发命令 + 唯一哨兵行，读取 stdout 直到哨兵出现。
- **FR-tool-007**（MUST）：结束判定**必须**基于**哨兵行**（含退出码与耗时），**不得**依赖 `exit` / `close` 事件
  （设备上永不触发），也**不得**依赖 `cp.exec` 回调。
- **FR-tool-008**（MUST）：必须支持参数 `{ command: string, timeout?: number }`，默认超时 **120000 ms**；
  超时必须**中止等待并返回明确错误**，且必须重启常驻 shell（旧进程已不可信）。
- **FR-tool-009**（MUST）：返回内容必须包含 stdout 与 stderr（合并或分列）与退出码；输出必须截断到上限
  （防爆内存），并在截断时明确标注。
- **FR-tool-010**（MUST NOT）：不得把该能力描述为「沙箱」；必须如实说明「工具层围栏、可被绕过」。

### 5.3 `grep` / `glob` 替代（G2/G3）

- **FR-tool-011**（MUST）：必须移除或覆盖内置 `opencode.tool.grep` 与 `opencode.tool.glob`，改为**纯 JS** 实现，
  不得调用 `Ripgrep.Service` 或 spawn `rg`。
- **FR-tool-012**（MUST）：`grep` 入参至少支持 `{ pattern, path?, glob?, ignoreCase?, literal?, limit? }`；
  返回匹配的 `path`、`line`、`text`。
- **FR-tool-013**（MUST）：`glob` 入参至少支持 `{ pattern, path?, limit? }`；返回文件路径列表。
- **FR-tool-014**（MUST）：遍历必须有**硬上限**：最大文件数、单文件最大字节、最大深度、单行最大字符数、
  结果条数上限；命中上限必须**在结果中显式标注**（不得静默截断）。
- **FR-tool-015**（MUST）：必须跳过 `.git`、`node_modules`、二进制/超大文件；必须容忍不可读目录（继续而非失败）。

### 5.4 物化与启动链

- **FR-tool-016**（MUST）：插件源码随 HAP 投放（构建期收集），启动时 **copy**（禁 symlink）到
  `<userData>/config/opencode/plugin/<oc-plugin-name>/`。
- **FR-tool-017**（MUST）：物化必须**幂等**且**可重复**：同名目录先清理再写入，避免旧版本残留。
- **FR-tool-018**（MUST）：物化失败必须**可见**（日志 + 启动状态），不得静默继续。
- **FR-tool-019**（MUST）：必须能通过 `GET /api/plugin` 观测到插件已加载；失败插件必须暴露 `status: "failed"`。

### 5.5 验证与不回归

- **FR-tool-020**（MUST）：每个插件必须通过 `node --check` 语法门禁；构建期必须做静态断言：
  源码中**不得**出现 `node-pty` / `child_process.exec` / `.node` 引用（`shell` 插件允许 `spawn`，但只能是
  `/system/bin/sh`，且必须集中在一处并注明理由）。
- **FR-tool-021**（MUST）：必须提供 host 侧测试脚本，在**不依赖真机**的前提下验证 `grep`/`glob` 的语义
  （命中/不命中/忽略大小写/字面量/上限/跳过目录），并产出 PASS/FAIL 计数。
- **FR-tool-022**（MUST）：真机必须完成两次以上真实对话，取证到 `shell` 与 `grep`/`glob` 的
  `toolCall` / `toolResult`（含 `rc≠0`、stderr 合并、超时、并发调用）。
- **FR-tool-023**（MUST NOT）：不得回归既有能力：应用启动就绪、会话可建、真实对话可完成。

### 5.6 非目标（显式不做）

- **FR-tool-024**（MUST NOT）：不实现 `rm` / `mv` / `cp` / `mkdir` 等文件变更工具（上游 `write`/`edit`/`patch` 已够用）。
- **FR-tool-025**（MUST NOT）：不实现工具层路径围栏的强隔离（如实披露「可被绕过」，不得描述为沙箱）。
- **FR-tool-026**（MUST NOT）：不新增任何上游补丁；插件只落在本工程的 `plugins/` 与物化链上。

## 6. 验收标准

| 编号 | 验收条件 | 判定方式 |
|---|---|---|
| AC-01 | 两个插件目录存在且默认导出 `{ id, setup }` | 目录核对 + `node --check` |
| AC-02 | 静态断言通过：无 PTY / 无外部 ELF spawn（除 `/system/bin/sh`）/ 无 `.node` | 构建期断言输出 |
| AC-03 | host 侧测试脚本全绿（≥ 20 条断言，含负向与上限用例） | 脚本输出 PASS 计数 |
| AC-04 | HAP 内含插件源码；启动后 `<userData>/config/opencode/plugin/` 下出现同名目录 | 包内清单 + 应用域 `ls` |
| AC-05 | `GET /api/plugin` 返回两个插件且非 `failed` | 应用域接口取证 |
| AC-06 | 真机 `shell` 调用成功返回 stdout 与退出码（含 `rc≠0` 用例） | 会话 `toolCall`/`toolResult` |
| AC-07 | 真机 `grep` / `glob` 调用成功返回结果（覆盖命中与不命中） | 同上 |
| AC-08 | 超时用例返回明确错误且常驻 shell 已重启 | 同上 |
| AC-09 | 不回归：应用启动就绪、会话可建、一次真实对话完成 | hilog + 会话记录 |

## 7. 不做

PTY 终端、`fff` FFI、LSP/formatter/MCP 外部进程、git/VCS、图片缩略图、后台常驻/开机自启/托盘/通知、
插件在线安装、工具层强隔离（§3 的 G7–G12）。
