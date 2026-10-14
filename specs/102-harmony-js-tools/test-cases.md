# 102 — 鸿蒙 JS 工具 测试用例

> **回引:** `spec.md` §6 ｜ **执行落点:** `logs/20261013-1/TEST_CHECKLIST.md`

## 1. 静态用例（host）

| 用例 | 关联 | 步骤 | 期望 | 结果 |
|---|---|---|---|---|
| JT-01 | AC-01 | 两个插件目录存在，`package.json` 的 `name` 与目录名一致 | 一致 | ⬜ |
| JT-02 | AC-01 | `node --check` 每个 `.js` | 全部通过 | ⬜ |
| JT-03 | AC-01 | 默认导出含 `id`（string）与 `setup`（function） | 齐备 | ⬜ |
| JT-04 | AC-02 | 断言源码无 `node-pty` / `forkpty` / `openpty` | 0 命中 | ⬜ |
| JT-05 | AC-02 | 断言源码无 `.node` / `.so` 引用 | 0 命中 | ⬜ |
| JT-06 | AC-02 | 断言 `spawn` 仅出现 `/system/bin/sh`；无 `child_process.exec` | 通过 | ⬜ |
| JT-07 | AC-02 | 反向用例：临时注入 `require("node-pty")` → 断言必须失败 | 非零退出 | ⬜ |
| JT-08 | AC-02 | 反向用例：临时注入 `exec("rg")` → 断言必须失败 | 非零退出 | ⬜ |

## 2. 语义用例（host，`scripts/test-harmony-plugins.mjs`）

| 用例 | 关联 | 场景 | 期望 | 结果 |
|---|---|---|---|---|
| JT-10 | AC-03 | `grep` 命中：固定夹具下匹配 3 处 | 返回 3 条，含 path/line/text | ⬜ |
| JT-11 | AC-03 | `grep` 不命中 | 返回空结果与明确「无匹配」措辞 | ⬜ |
| JT-12 | AC-03 | `ignoreCase: true` 与 `false` 对照 | 大小写敏感/不敏感结果不同 | ⬜ |
| JT-13 | AC-03 | `literal: true`：模式含正则元字符 `.` `*` | 按字面量匹配（不解释为量词） | ⬜ |
| JT-14 | AC-03 | `glob: "*.md"` 过滤 | 只返回 md | ⬜ |
| JT-15 | AC-03 | `glob` 工具：`**/*.js` | 返回预期集合 | ⬜ |
| JT-16 | AC-03 | 跳过目录：夹具含 `node_modules/` / `.git/` 下的命中 | 结果中不出现 | ⬜ |
| JT-17 | AC-03 | 上限：超过 `MAX_FILES` 的夹具 | 结果标注截断（不可静默） | ⬜ |
| JT-18 | AC-03 | `limit` 生效 | 返回条数 ≤ limit | ⬜ |
| JT-19 | AC-03 | 不可读目录（权限/不存在） | 继续遍历不抛错 | ⬜ |
| JT-20 | AC-03 | 二进制文件 | 跳过不产出乱码 | ⬜ |
| JT-21 | AC-03 | 单行超长 | 截断到 `MAX_LINE_CHARS` | ⬜ |
| JT-22 | AC-03 | 遍历深度超限 | 不进入更深层 | ⬜ |
| JT-23 | AC-03 | 哨兵协议：`echo` 命令回显与哨兵行解析 | 正确解析 rc 与耗时 | ⬜ |
| JT-24 | AC-03 | 哨兵协议：输出中包含疑似哨兵文本 | 不误判（nonce 不匹配） | ⬜ |
| JT-25 | AC-03 | 输出超 `MAX_OUTPUT_BYTES` | 截断并标注 | ⬜ |
| JT-26 | AC-03 | 参数校验：缺失 `command` / `pattern` | 返回校验错误而非崩溃 | ⬜ |

## 3. 真机用例

| 用例 | 关联 | 步骤 | 期望 | 结果 |
|---|---|---|---|---|
| JT-30 | AC-04 | 部署后读应用域 `<userData>/config/opencode/plugin/` | 两个插件目录存在 | ✅ | trace `[插件物化] 完成：2/2`；`opencode.log` 两条 `loading plugin`（§11.3） |
| JT-31 | AC-04 | 比较包内与物化后文件 sha256 | 一致 | ✅ 构建期 7/7：`collect-app` → `投放后校验通过：7 个文件 sha256 与源一致`；**设备侧**（2026-10-14）两个 `index.js` `hdc file recv` 后 `md5sum` 与源一致（`254234df4c29…` / `b98e3245a585…`）；物化 = copy，非 symlink |
| JT-32 | AC-05 | 应用域 `GET /api/plugin` | 两插件在清单中，且 `status != "failed"` | ⚠️ 以日志替代：凭据文件 0600 ⇒ 主机侧 `/api/*` 一律 401；改用 `opencode.log` 的 `loading plugin ×2` + 三工具端到端可调用（§11.3） |
| JT-33 | AC-06 | 真实对话触发 `shell`：`pwd; uname -s` | 返回 stdout 且退出码 0 | ✅ `OC_SHELL_OK` / `20020217` / `aarch64` / `TMPDIR=…`，`[exit code: 0]`（§11.2） |
| JT-34 | AC-06 | `shell`：`ls /nonexistent; echo rc=$?` | 返回非零退出码且 stderr 可见 | ✅ `ls: /nonexistent: No such file or directory` + `rc=1`（§11.2） |
| JT-35 | AC-07 | 真实对话触发 `grep`：在沙箱工作区搜索已知串 | 命中且含行号 | ✅ `Found 1 matches` + `probe.txt:` + `  Line 1: harmony tool probe`（§11.2） |
| JT-36 | AC-07 | `glob`：列出工作区 `*.md` | 返回文件列表 | ✅ `glob *.txt` → `probe.txt`（§11.2） |
| JT-37 | AC-08 | `shell` 超时：`sleep 300` 且 `timeout` 设小值 | 明确超时错误；随后一次正常命令仍成功（shell 已重启） | ✅ 3 s 超时丢弃常驻 shell；随后 `echo after-restart` → `after-restart`，`[exit code: 0] [10 ms]`（§11.2） |
| JT-38 | AC-09 | 不回归：一次普通对话（不调用工具） | 正常回复 | ✅ 两轮（自我介绍、工具类提问）均正常（§11.2） |
| JT-39 | 并发 | 同一会话内连续两次工具调用 | 不串输出（哨兵隔离） | ✅ 同轮 `grep` + `glob` 并行、`shell`(工具) 与 `shell`(超时) 连续调用，输出各自独立（§11.2） |
| JT-40 | **契约（本轮新增）** | 工具层：`shellTool/grepTool/globTool` 的 `execute(input, ctx)` 返回值必须是 `Promise`（宿主 `Info.execute` 声明为 `Promise<Tool.Result>`，注册后直接 `.then(...)`） | 三个工具均「同步阶段不抛 + 返回 thenable + 结果含 `content`/`metadata`」 | ✅ 代码审查期发现的**真机缺陷 D3**（同步返回 → `internalCall(...).then is not a function`）；用例 `testToolContract()` 9 项 |
| JT-41 | **契约（本轮新增）** | 工具层：宿主**总是**传 `context.signal`；`execute` 在该形态下不得抛异常（清理钩子不得引用跨作用域标识符） | 带未中断 signal → 正常返回；已中断 signal → 返回 killed 结果而非抛异常；非法参数 → `errorResult` | ✅ **真机缺陷 D2**（`onAbort is not defined`）；用例 `testShellToolExecute()` 6 项；反例已复现 |
