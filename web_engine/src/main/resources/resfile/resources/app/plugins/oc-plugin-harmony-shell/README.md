# oc-plugin-harmony-shell

用「**常驻 `/system/bin/sh` + 随机哨兵行**」替换设备上会挂死的内置工具 `shell`。

> 规格：[`specs/102-harmony-js-tools`](../../specs/102-harmony-js-tools/)（FR-tool-006…010、FR-tool-021）
> 目录约定与准入条件：[`plugins/README.md`](../README.md)

## 1. 为什么必须替换

| 缺口 | 根因 | 依据 |
|---|---|---|
| `shell` 工具挂死 | 上游 `shell` 走「跨平台子进程包装 → `node:child_process`」启动命令，并等待子进程 `exit` / `close` 事件或 `cp.exec` 回调。设备上**这两类事件永不触发**，工具因此永不返回 | specs §3 G1、§4 U6；`docs/鸿蒙环境能力清单.md` #10 |

因此结束判定必须从**进程事件**搬到**数据流**上：给每次调用生成唯一的哨兵行，读到它即认为命令结束。

## 2. ⚠️ 性质说明（FR-tool-010，如实披露）

**这是工具层围栏（tool-level fence），不是沙箱。** 命令以插件（服务端）同等权限执行，
内容完全由命令自身决定，**可以被绕过**。插件只负责三件事：结束判定确定、输出有上限、超时可中止。
不实现路径围栏、不做权限询问（插件 API 也没有 `permission.assert`，见 §6）。

## 3. 协议（每次调用写入常驻 shell 的 stdin；绝不等待 exit/close）

```sh
__oc_command=$(cat <<'__OCEOF_<nonce>__'   # 唯一 heredoc 标记原样读入命令文本
<command 原文>
__OCEOF_<nonce>__
)
( eval "$__oc_command" ) 2>&1              # 子 shell 隔离（cd/exit/变量不外泄）+ stderr 并入 stdout
echo "__OC_<nonce>_$?__"                   # 唯一哨兵行：随机 nonce + 退出码，单条 echo 打印 $?
```

要点：

- **命令走 stdin**，但用**唯一 heredoc 标记**包裹：命令里的引号/反斜杠/多行/自身 heredoc
  都不可能冲垮协议（若直接把命令文本拼进 stdin，`echo "unterminated` 这类命令会让 shell 继续等输入，
  从而吞掉哨兵行、每次调用都超时必须靠超时兜底）。
- **子 shell 隔离**：`cd`、`exit`、变量赋值都不外泄到后续调用（常驻 shell 的 cwd 保持工作区根）。
- **绝不监听 `exit` / `close`**：结束判定只看 stdout 上的哨兵（`findSentinel`）。
- **哨兵**：`__OC_<nonce>_<rc>__`，`nonce` = 每次调用 16 位十六进制随机数（`crypto.randomBytes(8)`）。
  匹配要求 nonce 完全一致 + 后面紧跟换行（行尾锚点），因此命令输出里的疑似哨兵文本不会误判；
  不要求行首锚点——命令的最后一行常常没有换行（`printf` / `echo -n`），此时哨兵紧跟其后。
  解析器同时兼容 `__OC_<nonce>_<rc>_<ms>__` 四字段形态。
- **`<ms>` 由宿主时钟测量**：设备 sh 没有可移植的毫秒时钟（`date +%s%3N` 是 GNU 扩展），
  把耗时放进哨兵会让协议依赖 `date`，一旦缺失就必然超时。因此 `execute()` 返回的 `ms` 是
  `Date.now()` 差值（四字段形态仍可解析）。
- **就绪判据**（R2）：spawn 后先写一条 `echo "__OC_<nonce>_0__"` 探测并等它的哨兵回显，
  超时（`READY_TIMEOUT_MS = 5000`）即丢弃该进程并返回明确错误；不依赖任何 spawn 事件。
- **串行化**：同一常驻 shell 上的调用排成队列（模型并发发起工具调用时不会串输出）。

## 4. 参数与上限

| 项 | 值 | 说明 |
|---|---|---|
| `input` | `{ command（必填，非空）, timeout? }` | `additionalProperties: false`，与规格一致 |
| `DEFAULT_TIMEOUT_MS` | 120000 | 与上游 `shell` 默认一致 |
| 超时行为 | kill + 惰性重启 | 超时后旧进程不可信：`child.kill()` 并丢弃，下次调用重新 spawn；本次返回明确错误（含已收集的部分输出） |
| `MAX_OUTPUT_BYTES` | 262144 | stdout+stderr 合并后按**字节**封顶，超出追加 `[output truncated at 262144 bytes]` |
| 返回内容 | 合并输出 + `[exit code: N] [+ 耗时]` | 退出码始终给出；`metadata` 另带 `exitCode`/`durationMs`/`truncated`/`timeout` |

cleanup：`setup` 返回的函数会 kill 常驻 shell（FR-tool-005）；工具执行被中断（`signal` abort）时
同样丢弃常驻 shell，避免下一次调用白等满超时。

`spawn` 只出现在**一处**，且目标是唯一的 `/system/bin/sh`（构建期 `scripts/collect-app.mjs` 会断言这一点）。
`createResidentShell({ createChild })` 仅用于 host 侧测试注入假 sh，生产路径不接受外部注入。

## 5. 文件

| 文件 | 作用 |
|---|---|
| `index.js` | 插件入口 + 协议纯函数 + 常驻 shell 会话（默认导出 `{ id: "oc-harmony-shell", setup }`；命名导出 `findSentinel`/`parseSentinelLine`/`sentinelLine`/`commandScript`/`createResidentShell`/`shellArguments`/`formatShellContent`/`shellTool` 供 host 测试） |
| `package.json` | `type: "module"`（上游按目录解析 `index.js`） |

## 6. 与上游的差异（如实登记）

- **无后台任务**：上游 `shell` 支持 `background: true` 与 `shellID` 流式读取；本插件只做前台命令
  （`input` 仅 `command`/`timeout`）。需要后台语义时用 `command &`，但注意后台进程的后续输出
  可能在下一次调用开始时被清掉（每次调用会重置本调用缓冲）。
- **无权限询问**：`context.permission` 只有 `list`/`get`/`reply`/`hook`，没有 `assert`，
  插件无法复现上游的逐命令询问；配置层 `deny`/`skip` 仍按有效工具名过滤可见性。
- **无 `workdir` 参数**：命令固定在工作区根（`setup` 时取自 `context.location.directory`）执行；
  需要换目录请在命令内 `cd`（子 shell 隔离，不影响后续调用）。
- **`timeout: 0`**（上游表示「不限时」）被拒绝：无上限超时正是本插件要消除的挂死风险。

## 7. 验证

host 侧：

```bash
node scripts/test-harmony-plugins.mjs     # 哨兵解析/抗碰撞/输出上限/超时重启/卸载等（假 sh 注入）
node scripts/collect-app.mjs --self-test   # 断言反向用例：node-pty / exec / .node / spawn 非 /system/bin/sh
```

真机（AC-06/AC-08，见 specs 的 JT-33…JT-37）：

1. `pwd; uname -s` → stdout + 退出码 0；
2. `ls /nonexistent; echo rc=$?` → 非零退出码且 stderr 可见（合并输出）；
3. `sleep 300` 且 `timeout` 设小值 → 明确超时错误；随后一次普通命令仍成功（常驻 shell 已重启）；
4. 同一会话连续两次调用 → 输出不串（哨兵隔离 + 串行化）。

## 已知限制（code review 后登记）

1. **只杀常驻 shell，杀不掉它留下的孙进程。** `dispose()` 对常驻 `/system/bin/sh` 发 SIGTERM 并摘掉
   stdout/stderr 监听；但**已经被命令放到后台且继承 fd 1 的孙进程**（例如 `yes &`、`sleep 300 &`）
   仍会存活并持有管道。应用域没有内核沙箱，而杀进程组会波及应用自身，因此本工程**不**做进程组清理。
   缓解：命令的 stdin 已隔离（`</dev/null`），所以读 stdin 的命令不会再挂到超时；
   跨调用的输出串扰已由「代际守卫 +  dispose 时摘监听」阻断。
2. **正则/输出仍是模型可控的输入面。** 本插件只负责把命令交给设备 shell；
   命令本身能做什么由平台的工具层围栏（best-effort，**不是**沙箱）决定。
3. **超时后常驻 shell 被丢弃并惰性重启**，因此超时调用的 shell 内状态（`cd`、变量、函数）会丢失。
   这是刻意的取舍：超时后旧进程状态不可信。
4. **并发调用串行化**（`chain`）：同一时刻只有一个命令在常驻 shell 上执行，避免哨兵交叉。
   代价是并发工具调用会排队（不会串输出，但会串时间）。
