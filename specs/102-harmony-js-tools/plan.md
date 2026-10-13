# 102 — 鸿蒙 JS 工具（opencode 插件替代）技术方案

> **回引:** `specs/102-harmony-js-tools/spec.md` ｜ **最后更新:** 2026-10-13

## 1. 决策

| # | 决策 | 依据 | 回引 |
|---|---|---|---|
| D1 | 工具替代走 **opencode 插件**（`{ id, setup }` 默认导出 + `context.tool.transform`)，**不走上游补丁** | U1–U4：插件是唯一「不改上游」的工具注入通道；`plugins/README.md` 的 L1 档位已规划该路径 | FR-tool-001/004/026 |
| D2 | 覆盖方式用 `editor.remove("opencode.tool.grep")` + `editor.add(...)`（而非 `update`） | U4：内置 id 明确，`remove` 语义干净；`update` 会保留上游 `execute` 的部分行为，对 rg 依赖无法去除 | FR-tool-011 |
| D3 | `shell` 用**常驻 `/system/bin/sh` + 哨兵行**，结束判定在 stdout 上做 | U6 + v0.1 清单 #10：设备永不触发子进程 `exit`/`close` | FR-tool-006/007 |
| D4 | 哨兵用**每次调用随机生成**的唯一标记（含 nonce），避免与命令输出碰撞 | 误判代价是「命令提前结束」，必须做到统计上不可能 | FR-tool-007 |
| D5 | `grep`/`glob` 用**共享一次遍历**的纯 JS 实现（同一文件内两个工具，复用 walker） | 与 `pi-desktop-hos` 的 `harmony-search.js` 同策略；避免两次遍历 | FR-tool-011/012/013 |
| D6 | 所有遍历设**硬上限**并在结果里显式标注 | 设备 2in1 大目录下无上限会 OOM/超时 | FR-tool-014 |
| D7 | 物化在**启动期**由 `src-main/main.js` 从包内资源 copy 到 `<userData>/config/opencode/plugin/` | U10 + U11：配置目录由 `XDG_CONFIG_HOME` 决定；symlink 在应用域被拒 | FR-tool-016/017 |
| D8 | 构建期新增 `scripts/collect-app.mjs`（本工程自有的「应用层收集」阶段）负责把 `plugins/` 投放到 resfile，并跑插件静态断言 | 保持流水线四阶段语义：`collect-runtime`（外壳）→ `build-opencode`（服务端）→ **`collect-app`（壳应用层）** → `build-debug` | FR-tool-016/020 |
| D9 | host 侧测试脚本 `scripts/test-harmony-plugins.mjs` 只测**纯函数语义**（walker / 匹配 / 上限），不依赖真机 | 真机每轮迭代成本高；语义可在 host 上穷举 | FR-tool-021 |

## 2. 插件契约（落地形态）

```
plugins/
├── oc-plugin-harmony-shell/
│   ├── package.json      { name, private: true, type: "module", main: "index.js" }
│   ├── index.js          export default { id: "oc-harmony-shell", setup }
│   └── README.md
└── oc-plugin-harmony-search/
    ├── package.json
    ├── index.js          export default { id: "oc-harmony-search", setup }
    ├── lib/walk.js       共享遍历器（纯函数，host 可测）
    └── README.md
```

`setup(context)` 的形状（promise 口味）：

```js
export default {
  id: "oc-harmony-shell",
  setup(context) {
    context.tool.transform((editor) => {
      editor.remove("opencode.tool.shell")
      editor.add({ name: "shell", description, input: { /* 纯 JSON Schema */ }, execute })
    })
    return () => shutdownResidentShell()   // cleanup：释放常驻 shell
  },
}
```

> ⚠️ `setup` 返回的 cleanup 由宿主在插件卸载时调用（U1）；常驻 shell 必须在此关闭，否则泄漏。
> `add()` 的 `input` 用**纯 JSON Schema**（U3），不要依赖 `@opencode/*` 的类型导入（插件是独立 ESM 文件，
> 随包投放、不参与上游 tsconfig）。

## 3. 步骤

| 步 | 动作 | 落点 | 出口判据 |
|---|---|---|---|
| S0 | 抄写上游契约与 id 常量（`opencode.tool.{shell,grep,glob}`） | 本规格 §4 | 与本规格一致 |
| S1 | 实现 `oc-plugin-harmony-search`（walker + 两个工具） | `plugins/oc-plugin-harmony-search/` | `node --check` + host 测试全绿 |
| S2 | 实现 `oc-plugin-harmony-shell`（常驻 shell + 哨兵） | `plugins/oc-plugin-harmony-shell/` | `node --check` + host 侧协议自测 |
| S3 | host 侧测试脚本 | `scripts/test-harmony-plugins.mjs` | ≥ 20 条断言全绿 |
| S4 | 构建期收集与静态断言 | `scripts/collect-app.mjs` | 断言输出 + resfile 内出现插件目录 |
| S5 | 启动期物化 | `src-main/main.js` | 日志出现「插件物化」条目；应用域目录存在 |
| S6 | 接入流水线 | `scripts/build-opencode.mjs`（或 README 流水线小节）与 `README.md` | 一条命令跑完并产出 HAP |
| S7 | 真机验证 | 会话 `toolCall`/`toolResult` | AC-04…AC-09 |

## 4. 数据流

```
plugins/oc-plugin-*          （源码，入库）
   │  collect-app.mjs 阶段：copy + 静态断言
   ▼
web_engine/.../resfile/resources/app/plugins/oc-plugin-*/   （包内只读）
   │  启动期 main.js：copy（禁 symlink）+ 清理同名
   ▼
<userData>/config/opencode/plugin/oc-plugin-*/              （可写，发现点）
   │  opencode 插件发现（配置目录下的 plugin/）
   ▼
GET /api/plugin inventory  →  工具表被移除/新增
```

## 5. 关键参数（两侧硬编码，host 测试与真机一致）

| 参数 | 值 | 理由 |
|---|---|---|
| `DEFAULT_TIMEOUT_MS` | 120000 | 与上游 `shell` 默认一致（U6） |
| `MAX_OUTPUT_BYTES` | 262144（256 KiB） | 防 stdout 爆内存 |
| `MAX_FILES` | 2000 | 遍历上限（grep/glob 共用） |
| `MAX_LIMIT` | 1000 | **结果条数硬上限**：入参 `limit` 只能收紧，超过即钳制并显式标注（FR-tool-014） |
| `MAX_MATCH_CHARS` | 4096 | 正则**匹配窗口**：只作用于每行前 N 字符，压缩不可信正则的最坏输入规模（见 §6 残余风险） |
| `MAX_FILE_BYTES` | 524288（512 KiB） | 单文件读取上限 |
| `MAX_DEPTH` | 8 | 递归深度上限 |
| `MAX_LINE_CHARS` | 300 | 单行显示上限 |
| `SKIP_DIRS` | `.git`、`node_modules`、`oh_modules`、`.cache`、`build`、`.hvigor` | 噪声与规模控制 |
| 哨兵模板 | `__OC_<nonce>_<rc>_<ms>__` | 随机 nonce |

## 6. 风险

| # | 风险 | 处置 |
|---|---|---|
| R1 | 命令输出恰好包含哨兵 → 提前结束 | 随机 nonce；命中后仍在 prompt 上校验 `echo` 回显行完整（两行协议） |
| R2 | 常驻 shell 在设备上同样不返回 `spawn` 事件 | 不等待任何 spawn 事件；以「首条哨兵回显」为就绪判据，带超时 |
| R3 | 纯 JS `grep` 在超大目录超时 | 硬上限 + 显式截断标注（FR-tool-014） |
| R4 | 插件加载失败导致启动不可用 | 插件失败必须可见（`GET /api/plugin` 的 `failed`），且**不得**阻塞服务端启动 |
| R5 | 物化 copy 在应用域失败（权限/空间） | 物化失败写日志 + 进入失败可见路径；不静默 |
| R6 | 上游未来把 `shell`/`grep`/`glob` 的工具 id 改名 | `collect-app` 的静态断言 + `GET /api/plugin` 真机核对；改名即失败可见 |

## 7. 代码评审后的残余风险（登记，不隐藏）

| # | 残余风险 | 现有缓解 | 彻底修法（后续工作） |
|---|---|---|---|
| CR-1 | **不可信正则的灾难性回溯**：JS 正则不可中断，病态图案（`(a+)+$`）会冻结服务端唯一线程；在默认 `inprocess` 宿主形态下就是冻结 Electron 主进程。上游 `rg`（Rust 正则，线性时间）无此问题，故这是纯 JS 替代**新引入**的失败面 | 匹配窗口 `MAX_MATCH_CHARS=4096` + 遍历与结果双硬上限 + 上限命中显式标注 | 把匹配放进 `worker_threads` 并设截止时间，超时即放弃该文件并把「正则过慢」反馈给模型 |
| CR-2 | **只杀常驻 shell，杀不掉继承 fd 1 的孙进程**（应用域无内核沙箱，杀进程组会波及应用自身） | 命令 stdin 隔离 `</dev/null`（读 stdin 的命令不再挂到超时）；代际守卫 + dispose 时摘监听（跨调用输出串扰已阻断） | 平台级方案（进程组/命名空间）或禁止后台进程的围栏 |
| CR-3 | **语义与 `rg` 不完全等价**（匹配窗口、`.gitignore`、多行、PCRE、`--type`） | 在插件 README 的「已知限制」逐条登记，并在结果中以 `truncated.lines` 标注 | 按需补齐 `rg` 的常用开关 |
