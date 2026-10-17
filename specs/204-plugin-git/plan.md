# Git 操作插件（204-plugin-git）—— 设计与实现方案

> **Module:** 204-plugin-git ｜ **Status:** Proposed ｜ **Last Updated:** 2026-10-17 ｜ **上游基线:** opencode v2.0.26（Branch_v2.0.26）
> 对应规格：[spec.md](./spec.md)
> 完整设计来源：[`docs/204-插件-GIT.md`](../../docs/204-插件-GIT.md)（已评审通过；§18 为待执行的操作清单）

## 1. 技术上下文

### 1.1 运行时与构建环境

| 项 | 值 |
|---|---|
| host 侧 | Windows + Node ≥ 22（脚本）+ `bun`（上游构建）+ `pwsh` 7+（构建脚本）+ DevEco Studio（`hvigorw` / `ohpm` / JBR / SDK） |
| 目标设备 | HarmonyOS 2-in-1（真机 `<设备 SN>`，本轮实测设备） |
| 运行时 | Electron 37（Node 22.17.0 / Chromium 138 / ABI v138） |
| 宿主形态 | `OCR_HOST_MODE=inprocess`（默认）⇒ 服务端与 Electron 主进程同进程 |
| 渲染通道 | `OCR_RENDER_MODE=chromium`（默认；ArkWeb 不在本模块范围） |
| 上游 | `../opencode` @ `9b4ec5714d`（tag `v2.0.26`）；补丁集 `patches/v2.0.26/0001–0008` |
| 部署链 | `collect-runtime` → `build-opencode`（补丁 ①–⑧ → bun install → vite build → collect-opencode → smoke） → `collect-app`（+ 依赖物化） → `build-debug.ps1` → `hdc app install -r` |

### 1.2 依赖

| 依赖 | 来源 | 用途 |
|---|---|---|
| `isomorphic-git@1.44.2`（含 `http/node`） | npm，**构建期物化进插件 `node_modules/`** | git 实现 + HTTPS 传输 |
| `diff@9.0.0` | npm，同上 | unified diff |
| `context.tool.transform` → `Editor.add/remove/get` | 上游 `packages/core/src/tool.ts` | 注册 21 个工具 |
| `context.vcs.transform` → `VcsEditor.add` | 上游 `packages/plugin/src/promise/vcs.ts` | 覆盖 `id:"git"` provider |
| `context.rpc.register` + `POST /api/rpc/:rpcID/:method` | 上游 `packages/plugin/src/promise/rpc.ts`、`packages/protocol/src/groups/rpc.ts` | 凭据 RPC（零 codegen） |
| `packages/schema/src/vcs.ts` | 上游 schema | `Info` / `Base` / `BranchList` / `FileStatus` / `Mode` |
| `sdk.api.rpc.call` | 上游生成客户端 | 页面调用 RPC |
| `scripts/collect-app.mjs` | 本工程 | 扩展 `collectPluginRuntime()` + 期望工具表 |
| `src-main/main.js materializePlugins()` | 本工程 | 已按目录 `cpSync`，**无需改动** |
| `node:fs` / `node:fs/promises` / `node:path` / `node:os` | Node 内建 | 适配器、凭据文件、诊断 |
| `patches/v2.0.26/0008-git-credentials-settings.patch` | 本工程 | 设置 → Git 页（自门控） |

## 2. 关键决策

| # | 决策 | 备选 | 理由 |
|---|---|---|---|
| D1 | **21 个一动词一工具** | 单工具 + `command` 枚举 / 核心 12 个 | 按名选工具 + 精确 schema，模型可靠性最高；便于逐操作验收；与 dsh 已验证形态一致 |
| D2 | **能力走插件 RPC、UI 走最小补丁**（同 203 D1） | 纯插件 / 纯补丁 | 上游插件无 UI 钩子（✅ `packages/app/src/runtime/extension/settings-pages.ts` 只认 builtins） |
| D3 | **构建期物化依赖到插件自己的 `node_modules/`** | 插件目录外运行时目录 / 单文件 vendored | 只有插件目录会被 `materializePlugins()` 的 `cpSync` 带走，且 Node 裸包解析优先查它；生成物不入库 |
| D4 | **第三方模块懒加载** | 顶层 import | 构建期「工具元数据检查」会 import 插件并跑 `setup()`，顶层 import 第三方包会让门禁因缺依赖而假失败 |
| D5 | **适配器全 `async`** | 同步实现 + try/catch | isomorphic-git 用 `isPromiseFs()` 无参探测方言，同步抛错 ⇒ 判成 callback 风格 ⇒ 全部调用永久挂起（dsh 真机事故） |
| D6 | **仓库根 chroot，不走上游 fs API** | 走上游 `fs/list` / `experimental/fs/write` | 上游协议无 `mkdir` / `rename` / `chmod`，git 索引与对象写入不可实现 |
| D7 | **凭据单一真值 = `~/.git-credentials`** | 凭据库 + 镜像（dsh 形态）/ 仅内存 | 本工程无 git 维度凭据库；单真值消除镜像时序；格式与 `git credential-store` 同形 |
| D8 | **口令永不回传页面** | 页面回显/复制 | `credentials.list` 只给 `passwordLength`；页面 `type=password` 且不缓存 |
| D9 | **覆盖内置 VCS provider（`id:"git"`）** | 只交付工具 | `VcsEditor.add` 是 `Map.set`，插件激活晚于 `internal.pre` ⇒ 覆盖成立；让自带 diff/分支 UI 复活 |
| D10 | **无提权通道** | 复用 dsh 式审批 | 本壳无审批面；越界只拒绝并提示换项目根 |
| D11 | **`diff` 用 jsdiff（物化 `diff@9.0.0`）** | 自研 Myers | 零依赖 +0.9 MB；与上游 UI 的 unified diff 语义一致 |
| D12 | **回退点**：注释 VCS 注册调用即回到「仅工具」 | 无回退 | 覆盖语义依赖上游 `Map.set`，需可单点降级（FR-204-033） |

## 3. 数据模型

### 3.1 凭据文件（git 原生，`~/.git-credentials`）

```
# 注释行被忽略
http://<用户名>:<口令>@<内网 GIT 主机>:<端口>
https://<用户名>:<口令>@git.example.com
https://<用户名>:<口令>@git.example.com/team/repo.git      ← 带路径行优先匹配前缀
```

| 规则 | 语义 |
|---|---|
| 编码 | userinfo 两段百分号编码（`%3A` / `%40` / `%2F` 可原样往返） |
| 权限 | 写入后强制 `0600`（临时文件 + `rename` 原子替换） |
| 匹配键 | `protocol` + `host[:port]`（大小写不敏感） |
| 优先级 | 带路径行（前缀匹配）> 裸主机行；同分时文件靠后 > 靠前 |
| 写入 | 同 `协议 + host + 用户名` 视为同一条（替换），其它行与注释原样保留 |
| 删除 | 只删匹配行；删空则删除文件本身 |
| 容忍 | 空行 / `#` 注释 / 非 URL / 无 userinfo 一律跳过，不抛错 |

### 3.2 RPC 契约（`rpcID = "oc-harmony-git"`）

| 方法 | 输入 | 输出 |
|---|---|---|
| `credentials.describe` | `{}` | `{ path, exists, mode, count, message }` |
| `credentials.list` | `{}` | `{ path, entries: [{ protocol, host, username, passwordLength, hasPath }] }` |
| `credentials.save` | `{ protocol?, host, username, password }` | `{ ok, code, message, path }` |
| `credentials.remove` | `{ protocol?, host, username }` | `{ ok, code, message }` |

`code ∈ ok | invalid-host | invalid-username | invalid-password | invalid-protocol | write-failed | not-found`；所有 handler **async**（同步返回值在真机上报 `rpc.internal`）。

### 3.3 工具输入/输出约定

| 项 | 约定 |
|---|---|
| 公共输入 | `dir?: string`（相对会话目录；缺省会话目录；必须落在项目根内） |
| 输出 | `{ content: string, metadata?: object }`；`content` 是模型可读文本（status 分组 / 提交摘要 / diff 文本 / 冲突列表） |
| 可归因失败 | 以 `{ content: "<工具名>: <原因 + 下一步>" }` 返回（不终结步骤） |
| 意外异常 | `throw`（上游包成 `Tool.Error`） |
| 凭据字段 | **任何工具都不得有**（FR-204-004） |
| 依赖 | `runtime.js` 首次调用时装载并缓存 |

### 3.4 VCS provider 数据结构

| 项 | 结构 |
|---|---|
| `VcsScope` | `{ directory, worktree, canonical, store? }`（由插件从 `context.location` 推导） |
| `info()` | `{ branch: { current?, default? } }` |
| `base()` | `{ name, ref, source: "default" } \| null` |
| `branches()` | `string[]` |
| `status()` | `[{ file, additions, deletions, status: added|deleted|modified }]` |
| `diff(mode)` | `[{ file, patch, additions, deletions, status, binary? }]` |

## 4. 接口契约

### 4.1 本模块提供

| 契约 | 消费方 | 说明 |
|---|---|---|
| 21 个 `git_*` 工具 | 模型（会话） | §10 表格；工具名即有效名 |
| `oc-harmony-git` 的 4 个 RPC 方法 | 渲染层设置页（补丁 0008） | §3.2 |
| VCS provider `id:"git"` | 上游 `Vcs` 服务 / 自带 UI | §3.4；覆盖内置 |
| 诊断日志行 | hilog / 测试脚本 | `[oc-desktop] plugin oc-harmony-git: tools=21 vcsProvider=git(override) credentials=<path>` |

### 4.2 本模块消费

| 消费项 | 来源 | 说明 |
|---|---|---|
| `context.location.{directory, project.directory}` | 上游 | 围栏根与会话目录 |
| `context.tool.transform` | 上游 | 工具注册 |
| `context.vcs.transform` | 上游 | VCS 覆盖 |
| `context.rpc.register` | 上游 | 凭据 RPC |
| `process.env.HOME` | 宿主 | 凭据文件路径（`<userData>`） |
| `signal`（工具执行上下文） | 上游 | 透传给 isomorphic-git 的取消 |

## 5. 实现策略（含错误处理与降级）

### 5.1 插件装配（`plugins/oc-plugin-git/index.js`）

1. 读取 `context.location` → 计算 `root`（项目根）与 `cwd`（会话目录）。
2. `context.tool.transform(editor => { for (t of tools) editor.add(t); 复查 editor.get(name) })`；任一缺失 → `throw`。
3. `context.vcs.transform(editor => editor.add(makeVcsProvider({root, cwd})))`（try/catch，失败只记日志不连带工具）。
4. `context.rpc.register(definition, handlers)`（try/catch 同上）。
5. 打印诊断行；返回 cleanup（释放 RPC 注册）。

### 5.2 适配器契约（`lib/fs-adapter.js`）

- 方法集：`readFile` `writeFile` `unlink` `readdir` `mkdir` `rmdir` `stat` `lstat` `chmod` `readlink` `symlink` `rm`。
- **全部 `async`**；非法路径 → `Promise.reject(Object.assign(new Error('OutsideRepository'), { code: 'EPERM' }))`（不得同步抛）。
- 路径：`join(root, rel)` → `normalize` → 前缀包含校验 → `node:fs/promises`。
- `symlink` / `readlink` 直接拒绝（设备无软链，FR 与 A5 一致）并给出明确错误码。

### 5.3 上游补丁（`patches/v2.0.26/0008-git-credentials-settings.patch`）

| 文件 | 改动 |
|---|---|
| `packages/app/src/settings/route.ts` | `SettingsRootTab` 增加 `"git"`；`rootTabs` 同步 |
| `packages/app/src/settings/pages.ts` | `pageIcons.git = "branch"`；`pageLabels.git = "settings.git.title"` |
| `packages/app/src/settings/git/git.tsx`（新增） | 页面：路径展示 + 表单（协议/主机/用户名/口令）+ 列表 + 删除；**自门控** |
| `packages/app/src/settings/git/git.css`（新增） | 与既有设置页一致的排版 |
| `packages/app/src/settings/surface.tsx` | 渲染分支接入新页 |
| `packages/app/src/runtime/i18n/en.ts` / `zh.ts` | 文案键（无上架禁用词） |

自门控：挂载时先 `credentials.describe`；`rpc.unavailable` / 异常 → 该 Tab 从导航中剔除（不弹错）。

### 5.4 构建期物化（`scripts/collect-app.mjs`）

```
discoverPlugins() → assertPluginTree/Source（源目录） → assertToolMetadata（+21 项）
  → collectPlugins()（源码 → resfile/…/plugins/oc-plugin-git/）
  → collectPluginRuntime()（新增：npm 物化 → 同目录 node_modules/ → 断言）
```

`collectPluginRuntime()` 要点：常量 pin、临时 staging、`cpSync` 到目的地、断言（版本 / `http/node` 入口 / 包数 56 / 体积 ≤ 12 MB / 无 `.node`·`.so`）、幂等快路径、`--force-plugin-runtime`、`--check-only` 跳过、失败抛错（不 `process.exit`）。

### 5.5 错误处理与降级矩阵

| 场景 | 插件行为 | 降级 |
|---|---|---|
| 依赖未物化 / 版本不符 | 工具调用返回「git 运行时缺失（期望 1.44.2）」；启动诊断行标 `runtime=missing` | 其它插件不受影响 |
| 依赖装载失败（require 错误） | 同上 + `console.log` 原因 | 21 工具变为「统一报错」而非崩溃 |
| `context.vcs.transform` 缺失 | 记日志，不抛（工具仍交付） | 回到「仅工具」 |
| VCS provider 运行期异常 | catch 内 `console.log` 归因，返回保守值（空 status / 空 diff） | 上游 `protect` 也会兜底 |
| RPC 注册失败 | 记日志；设置页经 describe 失败自行隐藏 | 凭据功能不可用但工具可用 |
| 凭据文件只读 / 写失败 | `credentials.save` 返回 `write-failed` + 原因 | 页面显示可读错误 |
| 越界 / 缺凭据 / 冲突 | §3.3「可归因失败」返回文本 | 不重试、不静默 |

## 6. 测试与验证

### 6.1 host 侧

```bash
node --test plugins/oc-plugin-git/tests/                # 纯函数 + 适配器契约
node scripts/verify-git-plugin.mjs                      # 门禁：单测 + 临时目录真实 init/add/commit/status/log/diff
node scripts/collect-app.mjs --check-only               # 静态断言 + 21 项工具元数据
node scripts/collect-app.mjs                            # 含 collectPluginRuntime() 物化断言
```

### 6.2 真机命令

```bash
hdc uninstall org.fellow99.oc.OCDesktop
hdc app install -r electron/build/default/outputs/default/electron-default-signed.hap
hdc shell aa start -a EntryAbility -b org.fellow99.oc.OCDesktop
hdc fport tcp:19229 tcp:9229                            # CDP：主进程 = 服务端进程
hdc shell "hilog -x | grep oc-desktop"                  # 诊断行 / 归因行
```

> 装机前建议先卸载或清 `<userData>` 旧产物，避免旧插件 / 旧 marker 干扰。

### 6.3 验收口径

- 构建期：AC-11 / AC-12（物化断言 + 工具元数据 + 静态断言）。
- 单元：AC-13（凭据 9+ 例、chroot、diff、status、revert、适配器 async 契约）。
- 真机：AC-1 / AC-2 / AC-3 / AC-4 / AC-5 / AC-6 / AC-7 / AC-9 / AC-10 / AC-14。
- 合规：AC-8（三处检索）/ AC-15（品牌化断言）。

## 7. 文件清单

### 7.1 新增

| 路径 | 说明 |
|---|---|
| `plugins/oc-plugin-git/package.json` | 包清单（`type: module`，两个 dependencies） |
| `plugins/oc-plugin-git/index.js` | 装配（工具 21 + VCS + RPC + 诊断） |
| `plugins/oc-plugin-git/lib/runtime.js` | 懒加载 + 版本断言 |
| `plugins/oc-plugin-git/lib/fence.js` | 仓库根解析 + chroot |
| `plugins/oc-plugin-git/lib/fs-adapter.js` | isomorphic-git FileSystem（全 async） |
| `plugins/oc-plugin-git/lib/credentials.js` | 凭据文件解析 / 匹配 / 写入 / 删除 |
| `plugins/oc-plugin-git/lib/auth.js` | `onAuth` / `onAuthFailure` + 指引文案 |
| `plugins/oc-plugin-git/lib/diff.js` | unified diff / stat / 二进制 |
| `plugins/oc-plugin-git/lib/report.js` | 输出渲染 |
| `plugins/oc-plugin-git/lib/vcs.js` | VCS provider |
| `plugins/oc-plugin-git/lib/tools/*.js` | 21 个工具（一文件一工具） |
| `plugins/oc-plugin-git/tests/*.test.mjs` | 单测 |
| `plugins/oc-plugin-git/README.md` | 插件说明（含 Known Limitations） |
| `scripts/verify-git-plugin.mjs` | 宿主门禁 |
| `patches/v2.0.26/0008-git-credentials-settings.patch` | 设置 → Git 页 |
| `specs/204-plugin-git/{spec,plan,tasks,test-cases}.md` | 规格四件套 |

### 7.2 修改

| 路径 | 改动 |
|---|---|
| `scripts/collect-app.mjs` | `collectPluginRuntime()`、期望工具表、`--force-plugin-runtime` |
| `patches/v2.0.26/README.md` | 登记 0008 |
| `plugins/README.md` | §5 登记「纯 JS 第三方依赖可构建期物化」；§7 加 `oc-plugin-git` 行 |
| `README.md` | 能力缺口中 git/VCS 状态更新；插件列表 |
| `docs/鸿蒙环境能力清单-v2.0.26.md` | G9 行标注「本轮已交付（插件方案）」 |
| `docs/工程规划-V2.md` | §7 能力缺口表述同步（仅文字） |
| `specs/README.md` | §1 编号表新增 204 行 |
| `.gitignore`（如需） | 物化目录不在工作树内，通常无需改动（核对后决定） |


### 7.3 明确不改

- `src-main/main.js`（`materializePlugins()` 已够用）。
- ArkTS（`web_engine/**`、`electron/src/main/ets/**`）。
- `build-profile.json5` 权限声明面。
- 上游 `packages/protocol` / `packages/server` / `packages/core`。
- 父工程任何文件；Git 分支。

## 8. 与规格的交叉引用

| 规格 | 本方案落点 |
|---|---|
| FR-204-001/002/003/004/005/006/007 | §2 D1/D4、§3.3、§5.1 |
| FR-204-010/011/012/013 | §2 D5/D6/D10、§5.2 |
| FR-204-020/021/022/023/024/025 | §2 D7/D8、§3.1、§3.2、§5.3 |
| FR-204-030/031/032/033 | §2 D9/D12、§3.4 |
| FR-204-040/041/042/043/044/045 | §2 D3/D4、§5.4、§7.1–7.3 |
| NFR-204-001…006 | §5.2、§5.5 |
| 场景 1–12 | §6.1–6.3 + [`test-cases.md`](./test-cases.md) |
