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

## 3. 物化路径（构建期投放，不手工拷贝）

opencode 只认**配置目录**下的 `plugin/`、`plugins/`。本工程 `plugins/` 是**源码与打包源**，
构建期由 `scripts/collect-app.mjs` 物化到随 `XDG_CONFIG_HOME` 映射的位置（工程规划 §3.9、§5.3）：

```
plugins/<oc-plugin-name>/**        （源码，本目录）
        ↓ 构建期物化（Phase 2）
<userData>/config/opencode/plugin/<oc-plugin-name>/     # <userData> = /data/storage/el2/base/files
```

规则：

- **禁止 symlink**：真机 `symlink` 报 `EACCES`（§7.3），一律 **copy 物化**；
- 插件依赖必须**构建期预置**（随包 copy 落盘），v1 不启用运行时安装；
- 直接放进 `web_engine/src/main/resources/resfile/` **不会生效**（那不在配置目录集合内）；
- 物化后由 `collect-app.mjs` 做存在性/形态校验（fail-visible）。

> ⬜ 待验证：`collect-app.mjs` 的插件投放与校验尚未实现（Phase 2）；本节给出的是契约，不是现状。

## 4. 命名约定

每个插件一个目录，目录名固定为 **`oc-plugin-<name>`**：

```
plugins/
└── oc-plugin-<name>/
    ├── package.json        # 可选；有依赖时依赖须构建期预置
    ├── <entry>.js|.ts      # 默认导出 { id, effect } 或 { id, setup }（插件模块契约）
    └── README.md           # 说明它做什么、依赖哪些设备能力、如何验证
```

`<name>` 用 `kebab-case`，且**不要**出现 `Harmony` / `DeepSeek` 等上架禁用词（工程规划 §8.5 G8）。

## 5. 插件准入条件（必须自证，缺一不合并）

在真机上能证明以下三条，才允许放进本目录（工程规划 §7.5）：

1. **不依赖 PTY**：不使用 `node-pty` / `forkpty` / `openpty` 等 —— PTY 是平台级不可用（SELinux `EACCES`，§7.2）；
2. **不依赖外部进程**：不 `spawn` / `exec` 任何东西。应用域子进程 JIT 受限（SIGSYS）、
   退出事件永不触发、`cp.exec` 永不回调、每 spawn 泄漏 1 个僵尸（§3.8、§7.3）；
   插件与服务端同进程同权限，spawn 还会旁路工具层路径围栏；
3. **不依赖原生模块**：无 `.node` / `.so` 依赖（glibc ELF 不可执行，自有 ELF 需二进制证书；§7.2、§7.3）。

另外两条现实约束：

- **无热重载**：本工程设 `OPENCODE_FILEWATCHER_DISABLE=1`，watcher 为空实现 → 改插件需重启服务端/应用（§7.5）；
- **同权限执行**：插件在**服务端进程内**执行任意第三方 JS，与服务端同等权限（文件读写 + 命令执行），
  因此 v1 默认不开放该通道（§7.5）。

## 6. 验证

插件落地时（Phase 2）的验证口径见 `specs/201-plugin-runtime`；至少包含：

- host 侧：插件入口能被 `import()` 且 `export default` 形态符合契约（不依赖真机能力）；
- 真机：`GET /api/plugin` inventory 中该插件为已加载；故意制造失败时 `status:"failed"` 可见；
- 反向用例：插件内出现 `spawn` / PTY / `.node` 依赖时必须在评审阶段被拒（不是运行时才发现）。
