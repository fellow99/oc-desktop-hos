---
name: harmony-runtime-capabilities
description: 鸿蒙 HAP 沙箱与本工程（OC Desktop / oc-desktop-hos）的能力缺口清单：可写目录、无 /tmp、symlink/hardlink/chmod 语义、应用域子进程 JIT 受限（SIGSYS）、PTY 不可用、无 git/rg/bash/curl、loopback 隔离、大文件数须 tar.gz、plugin 与 plugins 发现语义。当你要在设备上读写文件、执行命令、搜索代码、安装或加载插件、或解释失败原因时，先读本技能。
---

# 鸿蒙运行时能力边界（harmony-runtime-capabilities）

本技能描述 **OC Desktop 所在鸿蒙设备**（`2in1` / `tablet`）的运行时能力与缺口，以及每条事实
**对 agent 的实际含义**。目的是让 agent 在做决定前就知道「这条命令/这个工具在这里不会成功」，
而不是先失败再猜原因。

证据标注口径（与 `docs/工程规划-V2.md` §0.2 一致）：

| 标记 | 含义 |
|---|---|
| ✅ 实测 | 在真机或上游源码上直接验证过（本技能中带来源） |
| 🔶 沿用 | 沿用同型工程 `dsh-desktop-hos` / V1 的真机结论，可信但本工程未复现 |
| ⬜ 待验证 | 本工程必须自行实测后才能定稿；不要当结论用 |

对应规格：[`specs/202-skill-runtime-capabilities`](../../specs/202-skill-runtime-capabilities/)；
事实出处：`docs/工程规划-V2.md` §3.8、§5.3、§5.4、§7.3、§7.4、§7.5。

---

## 1. 文件系统：哪里能写、什么语义不成立

| 事实 | 标注 | 对 agent 的实际含义 |
|---|---|---|
| `userData` = `/data/storage/el2/base/files`（hmfs，可写）；缓存目录 `/data/storage/el2/base/cache` | 🔶 沿用 | **只把持久文件写在这里**（及 `<userData>/{data,cache,config,state,tmp}` 子目录）。这是应用沙箱内唯一的常规写区。 |
| `homedir()` = `/storage/Users/currentUser` **不可写** | 🔶 沿用 | 不要往 `~` 写文件、不要 `mkdir -p ~/.cache/...`；`HOME` 已被宿主重定向到 `userData`，但**不要假设**任何外部工具会遵守它。 |
| `/tmp` 存在但**不可写**；`os.tmpdir()` 指向不可写位置；设置 `TMPDIR` 环境变量**无效** | 🔶 沿用 | 不要用 `/tmp`、不要靠 `TMPDIR` 换临时目录。宿主把 `TMPDIR` 指向 `<userData>/tmp` **并 monkey-patch `os.tmpdir()`**；agent 侧生成临时文件请显式用 `<userData>/tmp`（或工程内目录）。 |
| `symlink` 报 `EACCES`；`hardlink` 报 `EPERM` | 🔶 沿用 | **禁止用链接「安装/共享」文件**（含 npm 缓存式的 `node_modules` 链接）：一律 **copy 物化**。写工具/插件时不要走 link 分支。 |
| `chmod` **静默失效**（不报错但不生效） | 🔶 沿用 | 不要用 `chmod 755` 让文件变成可执行；写入后**回读校验**内容与属性，不一致即报 `FS_IO_ERROR`，不要静默放过。 |
| `/data`、`/storage` 根目录 readdir 受限 | 🔶 沿用 | 不要用「全盘扫描」找文件；从已知根（项目目录 / userData）向下枚举。 |

## 2. 进程与执行：不要 spawn，不要等 exit 事件

| 事实 | 标注 | 对 agent 的实际含义 |
|---|---|---|
| 应用域子进程 **JIT 被拦（SIGSYS）**（seccomp 层） | 🔶 沿用 | **不要 spawn `node` / `npm` / `bun` / 任何需要 JIT 的运行时**。宿主形态由 P0-1 探针定标（⬜ 定标后复核本行）。 |
| 子进程**退出事件永不触发**；`child_process.exec` **永不回调** | 🔶 沿用 | 不要用 `exec` / `execFile`，不要 `await` 退出或 `exit` 事件；改用**常驻单 shell + 哨兵行**：`sh -c '<cmd>; echo "__RC=$?"'`，从 stdout 解析 `__RC=`。 |
| 每次 spawn 泄漏 1 个僵尸进程 | 🔶 沿用 | 控制 spawn 次数：能在一个会话里连续执行就不要每次新起进程。 |
| PTY 不可用：SELinux 拒绝 `forkpty` / `openpty` / `popen`（`EACCES`），无官方应用级 API | 🔶 沿用 | 没有终端面板，也不要做「伪 PTY」：**不要尝试 `script` / `expect` / `tmux` / `node-pty`**；需要交互式命令请拆成非交互调用。 |
| 无 root、无 faultlog | 🔶 沿用 | 无法提权、看不到系统级崩溃日志；自建结构化日志（前缀 `[oc-desktop]`）并用 `hdc shell "hilog -x \| grep oc-desktop"` 取证。 |
| CDP 调试（`hdc fport tcp:19229 tcp:9229`）仅在 debug 构建门控 | 🔶 沿用 | 生产/上架包没有调试端口；不要假设 `--inspect` 可用。 |

## 3. 命令与工具：只有 toybox，没有常用 CLI

| 事实 | 标注 | 对 agent 的实际含义 |
|---|---|---|
| 设备**没有** `git` / `rg` / `bash` / `curl` | 🔶 沿用 | 不要下这些命令。shell 命令走 **toybox `sh`**（约 178 个 applet）。 |
| 不能用 PATH 查找外部命令（`/usr/local/bin`、`/usr/bin`、`/data/app/bin` 不存在） | 🔶 沿用 | **用绝对路径**：`/system/bin/sh`、`/system/bin/toybox`；不要依赖 `which` 或裸命令名。 |
| 随包分发自有 ELF **不可执行**（用户目录不可 exec，自有 ELF 需二进制证书） | 🔶 沿用 | 不要规划「随包带 grep/rg/工具二进制」路线；能力要用**纯 JS / 既有 Node 实现**补齐。 |
| 内容搜索降级：`fff` 需 Node FFI（`--experimental-ffi`，Node 26 特性）；`rg` 需要「系统 rg → 缓存目录 rg → 从 GitHub 下载并 `chmod 755`」三条路 | ✅ 实测（上游源码：`search.ts` 选择逻辑 / `ripgrepLayer` 获取顺序） | **搜索用文件枚举 + 逐文件过滤**（Glob/Grep 这类走 Node 实现的能力），不要试图 `rg`。降级时必须**明示空结果的原因**，禁止静默失败（工程规划 §7.4a）。 |
| 无 LSP / formatter / MCP 外部进程能力 | 🔶 沿用 | 语言服务器、格式化器、MCP 服务端这些「要起进程」的集成在本设备上按不可用处理，不要承诺。 |
| 无 OAuth 回环登录（回调需 `127.0.0.1` 回环，与 loopback 隔离冲突） | 🔶 沿用 | 引导用户用 **API Key** 方式登录；不要走浏览器回环回调流程。 |

## 4. 网络与安全

| 事实 | 标注 | 对 agent 的实际含义 |
|---|---|---|
| **loopback 隔离**：服务端必须绑 `0.0.0.0` + 随机高位端口，UI 访问 `http://<局域网IP>:<port>/`（回退 `127.0.0.1`） | 🔶 沿用 | 不要假设 `127.0.0.1:<port>` 从应用内一定可达；用宿主给出的 URL。 |
| 鉴权：`OPENCODE_PASSWORD` 必须是强随机密码（v2 强制） | ✅ 实测（上游源码：v2 强制密码） | 不要为了调试把密码置空/写死；凭据来自宿主注入。 |
| `http://<局域网IP>:<port>` 不是安全上下文 → `crypto.subtle` / Service Worker / 通知可能受限 | ⬜ 待验证（R2 ArkWeb 侧由 P0-2 探针定论） | 涉及 Web Crypto / SW / 通知的功能先当作「可能不可用」，不要在降级前静默失败。 |
| 系统 CA / 代理行为未验证 | ⬜ 待验证（开放问题 O4） | 不要承诺自签证书或企业代理可用；相关失败要报出具体错误。 |
| 服务具备文件读写 + 命令执行能力，却绑在局域网可见地址 | 🔶 沿用 | 密码 + 随机端口是硬要求；不要为了方便关闭鉴权或固定端口。 |

## 5. 产物与打包

| 事实 | 标注 | 对 agent 的实际含义 |
|---|---|---|
| **数万小文件不能直接进 HAP**：会卡死 hvigor 或让 Electron 启动 CHECK 崩溃 | 🔶 沿用 | 大批文件必须打成 **`tar.gz`（`--format=ustar`）**，运行时流式解压到 `/data/storage/el2/base/files/opencode-dist/`。 |
| 幂等 marker `opencode-dist.version` 内容 = tar 包 **SHA-256** | ✅ 实测（本工程要求；dsh 只比存在性的做法已废弃） | 升级产物要重新解压；只比「存在性」会导致就地升级不生效，必须 `hdc uninstall`。 |
| 后端常驻语义弱（2in1 最小化不算后台） | 🔶 沿用 | 不做后台常驻假设：应用退出即全部退出。 |
| 构建必须用 DevEco 自带 JBR（系统 Temurin 会报 `Invalid CEN header`），且需 `NODE_HOME` / `DEVECO_SDK_HOME`、构建前清空 `NODE_OPTIONS` | 🔶 沿用 | 构建走 `scripts/build-{hap,debug,release}.ps1`（用 **pwsh 7** 运行），不要自己拼 `hvigorw` 命令并用系统 JDK。 |

## 6. 插件与技能的发现语义（`plugin/` 与 `plugins/`）

| 事实 | 标注 | 对 agent 的实际含义 |
|---|---|---|
| opencode v2 从**配置目录**下的 `plugin/` 与 `plugins/` 两个目录**自动发现**插件（`.ts` / `.js` 文件或目录） | ✅ 实测（上游源码：`core/src/plugin/source-directory.ts`，`names = ["plugin","plugins"]`） | 两个目录名都有效、都要看；本工程的源码目录 `plugins/` 只是打包源，**放进 HAP 的 `resfile` 不生效**，构建期要物化到 `<userData>/config/opencode/plugin/<name>/`。 |
| 配置目录集合 = 全局 `<XDG_CONFIG_HOME>/opencode` + 各项目根 + 兼容目录 `<home>/.claude`、`<home>/.agents` | ✅ 实测（上游源码：`core/src/config/discovery.ts`） | 想知道「插件为什么没加载」，先确认它落在**配置目录集合内**。 |
| 没有 `OPENCODE_DISABLE_PLUGIN*` 硬开关；v1 采 **L0 全关**（不声明 + 不投放） | ✅ 实测（已核对全部 `OPENCODE_*` 环境变量） | v1 下 `GET /api/plugin` 返回空清单**是预期**，不是故障；不要报「插件系统坏了」。 |
| 热重载被关（`OPENCODE_FILEWATCHER_DISABLE=1` → watcher 空实现） | ✅ 实测（上游源码：`core/src/filesystem/watcher.ts`） | 改插件/配置需**重启服务端或应用**，不要等热重载。 |
| 插件在**服务端进程内**执行任意第三方 JS，与服务端同权限；npm 安装为进程内 Arborist（`ignoreScripts: true`，不 spawn 包管理器） | ✅ 实测（上游源码：`packages/util/src/npm.ts`） | 写入插件前先自证：**不依赖 PTY、不 spawn 外部进程、不用原生模块**；否则它比 shell 工具更容易旁路路径围栏。 |

## 7. agent 行动速查（违反即失败）

- ❌ 不要 `spawn node` / `npm` / `bun` / 任何 JIT 运行时；不要 `exec` + 等退出事件。
- ❌ 不要用 `rg` / `git` / `bash` / `curl`；也不要随包带自有 ELF 去替代它们。
- ✅ 搜索用**文件枚举 + 过滤**（Node 侧实现），靠绝对路径调用 `/system/bin/sh`。
- ❌ 不要写 `/tmp` 或 `~`；写 `<userData>`（及其 `data/cache/config/state/tmp` 子目录）。
- ❌ 不要用 symlink / hardlink / chmod 实现「安装、共享、赋可执行」；copy 物化 + 写后回读校验。
- ❌ 不要 `chmod` 后指望生效，不要等 PTY / 终端交互，不要依赖 `127.0.0.1` 回环。
- ✅ 大批文件走 tar.gz + SHA-256 marker；失败一律**可见**（日志前缀 `[oc-desktop]`），禁止静默降级。
- ⬜ 本技能中标 ⬜ 的条目（安全上下文、系统 CA/代理、JIT 与宿主形态）**必须**由本工程探针实测后再引用其结论。
