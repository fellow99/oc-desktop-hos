# oc-plugin-harmony-search

用**纯 JS** 替换设备上不可用的内置工具 `grep` / `glob`。

> 规格：[`specs/102-harmony-js-tools`](../../specs/102-harmony-js-tools/)（FR-tool-011…015、FR-tool-021）
> 目录约定与准入条件：[`plugins/README.md`](../README.md)

## 1. 为什么必须替换

| 缺口 | 根因 | 依据 |
|---|---|---|
| `grep` / `glob` 必然不可用 | 上游两个工具**必然**经 `Ripgrep.Service` spawn `rg` 二进制；`core/src/ripgrep/binary.ts` 的 `PLATFORM` 表没有 `arm64-ohos` 键 ⇒ 直接抛 `unsupported platform for ripgrep` | specs §3 G2/G3、§4 U7 |

因此不能走「换一份 rg」的路线（设备禁执行自有 ELF），只能在服务端进程内用 `node:fs` 遍历 + `RegExp` 匹配。

## 2. 文件

| 文件 | 作用 |
|---|---|
| `index.js` | 插件入口（默认导出 `{ id: "oc-harmony-search", setup }`）：`remove` 内置 `grep`/`glob`，`add` 纯 JS 版；并导出可测的命名函数（`grepArguments`/`globArguments`/`formatGrepContent`/`formatGlobContent`/`grepTool`/`globTool`） |
| `lib/walk.js` | 共享遍历器与匹配器（纯函数、无依赖、无子进程、无原生模块）：`walk`/`readTextFile`/`createMatcher`/`compileGlob`/`searchTree`/`findTree` + 全部上限常量 |
| `package.json` | `type: "module"`（必需：上游按目录解析 `index.js`；ESM 声明也让 `node --check` 真正生效） |

两个工具共用**同一次遍历实现**（不做两套）。

## 3. 工具契约

```js
export default {
  id: "oc-harmony-search",
  async setup(context) {
    await context.tool.transform((editor) => {
      editor.remove("opencode.tool.grep")   // 上游内置插件 id 形态
      editor.remove("grep")                 // 编辑器实际索引键（有效工具名）
      editor.remove("opencode.tool.glob")
      editor.remove("glob")
      editor.add(grepTool(root))            // 同名注册以最后一个为准
      editor.add(globTool(root))
    })
  },
}
```

⚠️ 两点容易踩：

1. **不要** `return context.tool.transform(...)`：宿主期望 cleanup 是函数或 `undefined`，返回
   `Registration` 对象会在卸载时报 `cleanup is not a function`。本插件的 `setup` 是 async，
   `await` 注册后不返回值。
2. 编辑器按**有效工具名**索引（`core/src/tool.ts`：`add/update/remove` 面对 `effectiveName`，
   未声明 namespace 时就是裸名 `grep`/`glob`），因此两处 id 都清一次；`add` 同名覆盖。
3. **`execute` 必须返回 Promise**：宿主契约是 `Promise<Tool.Result>`
   （`packages/plugin/src/promise/tool.ts` 的 `Info.execute`），注册后宿主直接 `.then(...)`。
   写成同步函数返回普通对象会在**每次调用**都变成
   `{"error":{"type":"unknown","message":"internalCall(...).then is not a function"}}`
   —— 2026-10-14 真机实测踩到过（当时 `grep`/`glob` 两个调用都失败，而 host 用例全绿，
   因为用例只测了下层 `searchTree`/`findTree`，没测工具层）。因此两个 `execute` 都是 `async`，
   并由 `scripts/test-harmony-plugins.mjs` 的 `testToolContract()` 断言「thenable + 结果形状」。

`input` 是**纯 JSON Schema**（插件是随包投放的独立 ESM，不参与上游 tsconfig）：

- `grep`：`{ pattern（必填，非空）, path?, glob?, ignoreCase?, literal?, limit? }`，
  `additionalProperties: false`；返回匹配的 `path` / `line` / `text`（同时放在 `metadata.matches` 里）。
- `glob`：`{ pattern（必填，非空）, path?, limit? }`。
- `path` 相对**工作区根**解析（工作区根在 `setup` 时取自 `context.location.directory`）；
  结果路径同样相对工作区根，越界时回落为绝对路径。
- `glob` 模式含 `/` 时匹配整条相对路径，否则按**基名**匹配（`*.md` 命中任意层级，与 ripgrep `--glob` 一致）。
- `options: { codemode: false }`：与上游内置工具一致，工具直接出现在模型的工具表里。

## 4. 硬上限（命中即显式标注，绝不静默截断）

| 常量 | 值 | 说明 |
|---|---|---|
| `MAX_FILES` | 2000 | 单次遍历的文件数上限 |
| `MAX_FILE_BYTES` | 524288 | 单文件读取上限（超出部分不参与匹配） |
| `MAX_DEPTH` | 8 | 深度口径：条目相对搜索根的段数（目录计入）；不进入 `depth = MAX_DEPTH` 的子目录 |
| `MAX_LINE_CHARS` | 300 | 单行显示上限 |
| `MAX_RESULTS` | 200 | 结果条数上限（可用 `limit` 覆盖） |
| `BINARY_PROBE_BYTES` | 8000 | 前 8000 字节内出现 NUL 即判为二进制并跳过 |
| `SKIP_DIRS` | `.git`、`node_modules`、`oh_modules`、`.cache`、`build`、`.hvigor` | 噪声与规模控制 |

截断会以 `(Results are truncated: …)`、`(The walk stopped after 2000 files: …)` 等文本出现在结果末尾，
同时写进 `metadata.truncated`（`results`/`files`/`depth`/`bytes`/`lines`）。不可读/缺失路径**不失败**：
记入 `errors`/`unreadable` 并继续遍历。

## 5. 与上游的差异（如实登记）

- **不触发权限询问**：上游 `grep`/`glob` 在执行前 `permission.assert`，而插件 API（`context.permission`）
  只暴露 `list`/`get`/`reply`/`hook`，没有 `assert`。因此本插件不做逐次询问；
  配置层的 `deny`/`skip` 仍通过「工具可见性过滤」（按有效工具名匹配）生效。
- **入参命名**：上游用 `include` / `caseSensitive`，本插件按规格用 `glob` / `ignoreCase`
  （`additionalProperties: false`，未知键会得到明确的参数校验错误而不是被静默忽略）。
- **不声明 `output` 结构**：只返回 `content` + `metadata`。上游另带 `output` 数组；
  无 `output` 声明时上游运行时会拒绝结果里出现 `output` 键，故本插件不返回它。
- **失败以结果文本返回**（`Error: …`），不抛异常：promise 执行器被包在 `Effect.promise` 里
  （`packages/plugin/src/promise/adapter.ts`），抛出的错误会变成 defect 而非 `Tool.Error`。

## 6. 验证

host 侧（不依赖真机）：

```bash
node scripts/test-harmony-plugins.mjs     # JT-10…JT-22 等语义用例，输出 PASS/FAIL 计数
node scripts/collect-app.mjs              # 静态门禁 + node --check + 投放 resfile
node scripts/collect-app.mjs --self-test  # 反向用例：证明断言能失败
```

真机：

1. 部署后读 `<userData>/config/opencode/plugin/`（应有 `oc-plugin-harmony-search/`，与包内 sha256 一致）；
2. `GET /api/plugin` 应出现 `oc-harmony-search` 且 `status != "failed"`；
3. 真实对话触发 `grep`（命中/不命中）与 `glob`（`*.md`），核对 `toolCall`/`toolResult` 含行号与路径；
4. 反向用例：把 `patterns` 写成非法正则，应得到 `Invalid regular expression` 的可读错误而非崩溃。

## 已知限制（code review 后登记）

1. **正则回溯风险未根治（最重要的一条）。** 模型给出的 `pattern` 会被直接编译成 JS `RegExp`。
   `(a+)+$` 这类灾难性回溯的图案**没有可靠的运行期超时手段**（JS 正则不可中断），
   而服务端在默认 `inprocess` 宿主形态下就是 Electron 主进程 ⇒ 单个病态图案会冻结应用。
   上游 `rg` 用 Rust 正则（线性时间）不存在该问题，所以这是本次「纯 JS 替代」**新引入**的失败面。
   现有缓解：
   - 匹配窗口限制在每行前 `MAX_MATCH_CHARS`（4096）字符，压缩最坏输入规模；
   - 遍历设硬上限（文件数 / 单文件字节 / 深度 / 结果条数），到达上限即停；
   - 上限命中一律在结果与 metadata 中显式标注。
   彻底修法（未做，登记为后续工作）：把匹配放进 `worker_threads` 并设截止时间，
   超时即放弃该文件并把「正则过慢」作为结果反馈给模型。
2. **语义与 `rg` 不完全等价。** 已知差异：
   - 匹配只在每行前 4096 字符内进行（长压缩行/单行大文件上会漏匹配；此时 `truncated.lines` 为真）；
   - 不读取 `.gitignore`，改用固定跳过表（`.git` / `node_modules` / `oh_modules` / `.cache` / `build` / `.hvigor`）；
   - 不支持 `rg` 的多行模式、PCRE、`--type` 等；
   - 二进制判定 = 头部 8000 字节含 NUL，或严格 UTF-8 解码失败；
   - glob 支持 `*` / `**` / `?` / `[...]`（含 `[!...]` 取反）/ `{a,b}`，不支持转义 `\`。
3. **`limit` 只能收紧上限。** 入参 `limit` 超过 `MAX_LIMIT`（1000）会被钳制，
   并在结果中显式写出「已被钳制」；默认 `MAX_RESULTS`（200）。
4. **遍历是同步的。** 大目录会在服务端唯一线程上占用事件循环（硬上限把最坏时长压在可接受范围，
   但没有让出时间片的机制）。
5. **`os.tmpdir()` 等宿主补丁不由本插件负责**，而由壳侧 `src-main/main.js` 承担。
