# oc-plugin-git

在**没有 `git` 的设备**上提供 git 能力：21 个 `git_*` 工具 + VCS provider 覆盖 + 凭据 RPC。

对应规格：[`specs/204-plugin-git/`](../../specs/204-plugin-git/)；完整设计：[`docs/204-插件-GIT.md`](../../docs/204-插件-GIT.md)。

## 1. 为什么是插件

设备上没有 `git` 二进制（toybox 不提供，`PATH` 里也没有等价物），而上游 `opencode.vcs.git` 必然
走 `gitExecutable` + 子进程。本插件把纯 JS 的 `isomorphic-git` 嵌进服务端进程，用三条接缝交付能力：

| 交付物 | 接缝 | 为什么 |
|---|---|---|
| 21 个 git 工具 | `context.tool.transform` → `editor.add` | 模型需要能按名调用、按参数精确控制 |
| 自带 diff / 分支 / 状态界面 | `context.vcs.transform` → `editor.add({ id: "git" })` | `VcsEditor.add` 是 `Map.set`，插件激活晚于内置 ⇒ 覆盖内置 provider |
| 凭据管理 | `context.rpc.register`（`rpcID = "oc-harmony-git"`） | 上游插件**没有 UI 钩子**，页面由最小补丁提供 |

## 2. 工具面（21 个，一动词一工具）

`git_init` `git_clone` `git_status` `git_diff` `git_log` `git_show` `git_add` `git_commit` `git_branch`
`git_checkout` `git_reset` `git_merge` `git_cherry_pick` `git_revert` `git_stash` `git_tag` `git_remote`
`git_fetch` `git_pull` `git_push` `git_config`

所有工具都接受可选 `dir`（相对会话目录解析，缺省 = 会话目录），并**必须落在项目根内**。

## 3. 围栏（安全属性）

- 根 = `context.location.project.directory`；`dir` 越界即拒绝（`..` 逃逸、绝对路径、根外软链都不放行）。
- 插件内 `node:fs/promises` 适配器把仓库根当 **chroot**：每个路径 `resolve → relative → 前缀校验`。
- **没有提权通道**：本壳无审批面，越界只能拒绝并提示把目标目录作为工作区打开。
- 如实披露：git 仓库**内部**写入（`.git/objects`、索引、检出）不逐次经过上游文件校验，围栏收窄为「仓库根」单点。

## 4. 凭据

- 文件：`~/.git-credentials`（设备上 `HOME` 已被宿主改写到应用私有目录，`0600`）。
- 格式：与 `git credential-store` 同形 —— 一行一条 `协议://用户名:口令@主机[:端口][/路径]`，userinfo 百分号编码。
- 匹配：协议 + `host[:port]` 必须一致；带路径行按前缀匹配且优先；同分时文件靠后者胜。
- 明文**不进**对话 / 日志 / 配置：工具参数里没有凭据字段；日志只打印 host 与口令长度。
- 缺凭据时工具返回可照抄的指引（点名主机、设置入口、文件路径与占位行），不把裸 401/404 丢给模型。

RPC（`POST /api/rpc/oc-harmony-git/<method>`，handler 全部 async）：

| 方法 | 输入 | 输出 |
|---|---|---|
| `credentials.describe` | `{}` | `{ path, exists, mode, count, message }` |
| `credentials.list` | `{}` | `{ path, entries: [{ protocol, host, username, passwordLength, hasPath }] }` |
| `credentials.save` | `{ protocol?, host, username, password }` | `{ ok, code, message, path }` |
| `credentials.remove` | `{ protocol?, host, username }` | `{ ok, code, message }` |

## 5. 依赖（构建期物化）

`isomorphic-git@1.44.2` + `diff@9.0.0`（共 56 包 / 8,005,075 B ≈ 8.0 MB）由 `scripts/collect-app.mjs` 的
`collectPluginRuntime()` 物化到**插件自己的** `node_modules/`（resfile 目的地，不入库）。
物化结果会同时回写到工程内 `.cache/git-plugin-runtime/`（已 `.gitignore`），后续 `collect-app` 直接复制缓存、
不再联网 `npm install`；版本不符或 `--force-plugin-runtime` 才重新安装。
运行时**不安装任何依赖**（`plugins/README.md` §2 的 `L1 仅本地`）。

第三方模块一律**懒加载**（首次工具调用才 `import()`）：构建期的「导入式工具元数据检查」会跑
`setup()`，顶层 import 会让那道门禁因依赖未物化而假失败。

## 6. Known Limitations

- **`rebase` 不交付**：上游库没有该原语，被请求时明确说明，不用 merge 冒充。
- **SSH 不可用**：只有 HTTPS 用户名/口令；`git@host:path` / `ssh://` 会被库改写为 `https://host/path`，丢掉的是 scp 里的 SSH 账号名，HTTPS 用户名得靠凭据文件或 `username` 参数。
- **仅 SHA-1 仓库**；二进制文件只报 `Binary files … differ`。
- **纯 JS 性能**：大仓库 clone 明显慢于原生 git，用 `depth` / `singleBranch` / `noTags` 缓解。
- **软链不支持**：设备 `symlink` 不可用，适配器对 `symlink` / `readlink` 明确报错。
- **VCS 覆盖依赖 `Map.set` 语义**：上游若改成「禁止同 id 覆盖」，覆盖会静默失效；启动诊断行与界面验收用于发现。

## 7. 验证

```bash
node --test plugins/oc-plugin-git/tests/       # 纯函数 + 适配器契约（不依赖第三方包）
node scripts/verify-git-plugin.mjs             # 含集成用例：复制到临时目录 + 物化依赖后跑真实 git 链
node scripts/collect-app.mjs --check-only      # 静态断言 + 21 项工具元数据
```
