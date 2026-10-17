# plugins/ —— 壳专用 opencode 插件源码（Phase 2）

本目录存放**仅供 OC Desktop 壳使用**的 opencode 插件源码。它**不是**运行时目录：
opencode 不会读这里，HAP 把它直接放进 `resfile` 也不会生效（见下文「物化路径」）。

对应规格：[`specs/201-plugin-runtime`](../specs/201-plugin-runtime/)（插件机制与三档降级）；
决策出处：`docs/工程规划-V2.md` §3.9（机制全貌与 v1 立场）、§7.5（真机风险矩阵与降级动作）、§4.1（目录结构）。

## 1. opencode v2 的插件发现语义（✅ 上游源码核实，v2.0.26）

| 环节 | 事实 | 上游位置 |
|---|---|---|
| 声明 | 配置里的 `plugins` 数组：`"<pkg>"` = 启用/安装；`{ package, options }` = 带选项启用；`"-<target>"` 前缀 = 移除；支持 `file://` 目标；相对目标按**所属配置文件所在目录**解析 | `packages/schema/src/config/plugin.ts`、`core/src/config/plugin/source.ts#parse` |
| 目录自动发现 | 对每个**配置目录**扫描其下 `plugin/` 与 `plugins/` 子目录，采纳其中的 `.ts` / `.js` 文件或目录（目录名集合为 `["plugin", "plugins"]`） | `core/src/plugin/source-directory.ts`、`config/plugin/source.ts#scan` |
| 配置目录集合 | 全局 `<XDG_CONFIG_HOME>/opencode`；各项目根目录；兼容目录 `<home>/.claude`、`<home>/.agents`（受 `global` 开关控制） | `core/src/config/discovery.ts` |
| 加载 | 绝对路径目标走插件 source runtime 读取入口文件（并对该文件做 fs 监听） | `core/src/plugin/module.ts#load` |
| npm 包 | 两趟：先 `install:false` 只解析（未装者记 `pending`）→ 再 `install:true` 真装后加载 | `core/src/plugin/supervisor.ts#activate` |
| 失败可见性 | 失败进 inventory（`status:"failed"` + `error` + `ref`），经 `GET /api/plugin` 暴露 | `packages/server/src/handlers/plugin.ts` |

要点：**没有** `OPENCODE_DISABLE_PLUGIN*` 之类的硬开关（已核对全部 `OPENCODE_*` 环境变量）；
「关闭插件」只能靠「不声明 + 不投放目录」，否则需要打补丁（候选 `0005-plugin-gate`，工程规划 §6.2）。

## 2. 本工程的 v1 立场：L0 关闭，本目录在 v1 不参与构建

| 档位 | 行为 | v1 采纳 |
|---|---|---|
| **L0 全关** | 不声明 `plugins`；不投放 `plugin/`、`plugins/` 目录 → 插件通道完全静默 | ✅ **v1 默认** |
| **L1 仅本地** | 只允许绝对路径 / 目录插件（壳专用插件随包投放），依赖在构建期预置（禁 symlink，copy 落盘） | ✅ v1 允许，**Phase 2** 落地（即本目录） |
| **L2 允许安装** | 打开第二趟 `Npm.add`（联网访问 registry + 写 `<XDG_CACHE_HOME>/opencode/npm/` + hmdfs 语义面） | Phase 2 起评估，须先过 §7.5 与开放问题 O8 |

推论（§3.9/§7.5）：v1 下 `GET /api/plugin` 返回**空清单属预期行为**，
UI 与验收脚本不得把空清单当故障；若出现 `pending` / `failed`，壳层必须有可见提示（禁止静默失败）。

## 3. 物化路径（构建期投放，启动期 copy；已落地）

opencode 只认**配置目录**下的 `plugin/`、`plugins/`。本工程 `plugins/` 是**源码与打包源**，
由 `scripts/collect-app.mjs` 在构建期投放，再由 `src-main/main.js` 在**每次启动**物化（工程规划 §3.9、§5.3）：

```
plugins/<oc-plugin-name>/**                        （源码，本目录）
        ↓ 构建期 scripts/collect-app.mjs（copy + sha256 校验 + node --check + 静态断言）
web_engine/src/main/resources/resfile/resources/app/plugins/<oc-plugin-name>/   （包内只读）
        ↓ 启动期 src-main/main.js 的 materializePlugins()（copy + 清理同名，禁 symlink）
<userData>/config/opencode/plugin/<oc-plugin-name>/       # <userData> = /data/storage/el2/base/files
```

规则：

- **禁止 symlink**：真机 `symlink` 报 `EACCES`（§7.3），一律 **copy 物化**；
- 插件依赖必须**构建期预置**（随包 copy 落盘），v1 不启用运行时安装；
- 直接放进 `web_engine/src/main/resources/resfile/` 的**其他**位置不会生效（必须经 `collect-app.mjs`
  投放到 `resfile/resources/app/plugins/`，并由启动期物化进配置目录）；
- 物化失败由 `main.js` 的 `fail()` 路径可见（`__ocError` + 日志），**不静默**；
- **构建顺序**：`collect-runtime` → `build-opencode` → **`collect-app`** → `build-debug`。
  `collect-runtime` 的 `APP_KEEP` 白名单已包含 `plugins`，重跑它不会误删插件投放物。

**现状（2.0.26）**：本目录下已落地 2 个插件 —— `oc-plugin-harmony-shell`、`oc-plugin-harmony-search`
（见 §7）。`docs/鸿蒙环境能力清单-v2.0.26.md` 记录真机验收结论。

## 4. 命名约定

每个插件一个目录，目录名固定为 **`oc-plugin-<name>`**：

```
plugins/
└── oc-plugin-<name>/
    ├── package.json        # 可选；有依赖时依赖须构建期预置
    ├── <entry>.js|.ts      # 默认导出 { id, effect } 或 { id, setup }（插件模块契约）
    └── README.md           # 说明它做什么、依赖哪些设备能力、如何验证
```

`<name>` 用 `kebab-case`。

**上架禁用词的作用域（code review 后澄清）**：`Harmony` / `DeepSeek` 等禁用词（工程规划 §8.5 G8）约束的是
**用户可见文案** —— 即工具的 `name` 与 `description`（会显示在界面上），由 `scripts/collect-app.mjs` 的
「导入式工具元数据检查」在构建期拦截。**内部标识符不受此限**：目录名（`oc-plugin-harmony-*`）、插件 `id`
（`oc-harmony-*`）、规格路径里的 `harmony` 都不会呈现给用户，且与兄弟工程
（`dsh-desktop-hos` 的 `harmony-plugin-XXX`、`pi-desktop-hos` 的 `extensions/`）保持一致。
早期版本此处写成「目录名不得含 Harmony」并配了一个**大小写敏感**的检查 —— 那对本工程的小写目录名
永远不会命中，等于没有约束；现已改为对用户可见文案做大小写不敏感检查。

## 5. 插件准入条件（必须自证，缺一不合并）

在真机上能证明以下三条，才允许放进本目录（工程规划 §7.5）：

1. **不依赖 PTY**：不使用 `node-pty` / `forkpty` / `openpty` 等 —— PTY 是平台级不可用（SELinux `EACCES`，§7.2）；
2. **不依赖外部进程**：不 `spawn` / `exec` 任何东西。应用域子进程 JIT 受限（SIGSYS）、
   退出事件永不触发、`cp.exec` 永不回调、每 spawn 泄漏 1 个僵尸（§3.8、§7.3）；
   插件与服务端同进程同权限，spawn 还会旁路工具层路径围栏；
3. **不依赖原生模块**：无 `.node` / `.so` 依赖（glibc ELF 不可执行，自有 ELF 需二进制证书；§7.2、§7.3）。

**纯 JS 第三方依赖例外（需求 204 起）**：允许插件在 `package.json` 的 `dependencies` 里声明**纯 JS** 第三方包
（无 `.node`、无 `.so`、无 spawn、无平台二进制），由 `scripts/collect-app.mjs` 的 `collectPluginRuntime()`
在构建期物化到**插件自己的** `node_modules/`（resfile 目的地，不入库、运行时仍不联网安装）。
已登记：`oc-plugin-git` → `isomorphic-git@1.44.2` + `diff@9.0.0`（56 包 / 8,005,075 B ≈ 8.0 MB）。
物化目录必须落在插件目录内：启动期 `materializePlugins()` 只整目录复制插件，裸包名解析也优先查它。

另外两条现实约束：

- **无热重载**：本工程设 `OPENCODE_FILEWATCHER_DISABLE=1`，watcher 为空实现 → 改插件需重启服务端/应用（§7.5）；
- **同权限执行**：插件在**服务端进程内**执行任意第三方 JS，与服务端同等权限（文件读写 + 命令执行），
  因此 v1 默认不开放该通道（§7.5）。

## 6. 验证

插件落地时（Phase 2）的验证口径见 `specs/201-plugin-runtime`；至少包含：

- host 侧：插件入口能被 `import()` 且 `export default` 形态符合契约（不依赖真机能力）；
- 真机：`GET /api/plugin` inventory 中该插件为已加载；故意制造失败时 `status:"failed"` 可见；
- 反向用例：插件内出现 `spawn` / PTY / `.node` 依赖时必须在评审阶段被拒（不是运行时才发现）。

## 7. 现有插件（2.0.26）

| 插件 | 覆盖/新增的工具 | 为什么需要 | 上游契约落点 |
|---|---|---|---|
| [`oc-plugin-harmony-shell`](./oc-plugin-harmony-shell/) | 覆盖 `shell` | 上游 `shell` 走 cross-spawn 并等待子进程 `exit`/`close` 事件；本设备**永不触发**这些事件 ⇒ 工具挂死。改为「常驻 `/system/bin/sh` + 随机哨兵行」，结束判定回到 stdout | `context.tool.transform(e => (e.remove("shell"), e.add(...)))` |
| [`oc-plugin-harmony-search`](./oc-plugin-harmony-search/) | 覆盖 `grep`、`glob` | 上游两者**必然**经 `Ripgrep.Service` spawn `rg`，而平台表无 `arm64-ohos` 键 ⇒ 抛 `unsupported platform for ripgrep`。改为纯 JS 遍历 + 正则 | 同上 |
| [`oc-plugin-git`](./oc-plugin-git/) | 新增 21 个 `git_*` 工具；覆盖 VCS provider（`id: "git"`）；注册 4 个凭据 RPC | 设备上没有 `git` 二进制，上游 `opencode.vcs.git` 必然 spawn 失败；本插件把纯 JS 的 `isomorphic-git` 嵌入服务端进程，并让「设置 → Git」页（补丁 0008）管理 `~/.git-credentials` | `context.tool.transform` / `context.vcs.transform` / `context.rpc.register` |

规格与验收：`specs/102-harmony-js-tools/{spec,plan,tasks,test-cases}.md`；
host 侧测试：`node scripts/test-harmony-plugins.mjs`；
静态断言（含反向用例）：`node scripts/collect-app.mjs --self-test`。

> ⚠️ **工具覆盖键是「有效名」**：opencode v2 的 `editor.add/update/remove` 按**有效工具名**
> （`shell` / `grep` / `glob`，即模型可见的名字）索引，而 `opencode.tool.*` 是**插件 id**。
> 本工程两个插件同时 `remove` 有效名与 `opencode.tool.*` 两种写法，避免上游语义漂移导致覆盖静默失效。
