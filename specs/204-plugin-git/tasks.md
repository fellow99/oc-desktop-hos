# 204-plugin-git 任务清单

> **Module:** 204-plugin-git ｜ **Last Updated:** 2026-10-17
> 对应规格：[spec.md](./spec.md) ｜ 对应方案：[plan.md](./plan.md) ｜ 完整设计：[`docs/204-插件-GIT.md`](../../docs/204-插件-GIT.md)

## 1. 规格任务

| ID | 任务 | 落点 | 依赖 | 验收 |
|---|---|---|---|---|
| T1 | 设计文档（含操作清单） | `docs/204-插件-GIT.md` | — | 现状/事实带证据；含围栏、凭据、VCS 覆盖、验收标准与脱敏操作清单；**已评审通过** |
| T2 | 规格四件套 | `specs/204-plugin-git/{spec,plan,tasks,test-cases}.md` | T1 | 符合 `specs/README.md` §2 固定章节与 `FR-204-NNN` 编号 |
| T3 | 编号登记 | `specs/README.md` §1 | T2 | 204 行存在且与目录名一致（`204 | plugin-git`） |

## 2. 开发任务

### 2.1 插件骨架与运行时

| ID | 任务 | 落点 | 依赖 | 验收 |
|---|---|---|---|---|
| T4 | 插件包骨架 | `plugins/oc-plugin-git/package.json` | T2 | 目录名 = `name`；`type: module`；`main: index.js`；dependencies 仅 `isomorphic-git` / `diff` |
| T5 | 运行时懒加载 + 版本断言 | `…/lib/runtime.js` | T4 | FR-204-045；`import()` 首次调用才发生；版本不符抛错 |
| T6 | 围栏（根解析 + chroot） | `…/lib/fence.js` | T4 | FR-204-003/010/011/013 |
| T7 | fs 适配器（全 async） | `…/lib/fs-adapter.js` | T6 | FR-204-012；方法集完整；越界 `Promise.reject` |
| T8 | 输出渲染 | `…/lib/report.js` | T4 | status 分组 / 提交摘要 / 冲突列表 / 截断标注 |
| T9 | diff 能力 | `…/lib/diff.js` | T5 | FR-204-005；二进制判定；单文件 / 总量上限（NFR-204-006） |

### 2.2 工具（21 个）

| ID | 任务 | 落点 | 依赖 | 验收 |
|---|---|---|---|---|
| T10 | 本地读写工具 | `…/lib/tools/{init,add,commit,status,log,config}.js` | T6–T9 | FR-204-002/004 |
| T11 | 历史与展示工具 | `…/lib/tools/{show,diff}.js` | T9 | FR-204-005；`show` 自建 |
| T12 | 分支与切检工具 | `…/lib/tools/{branch,checkout,reset}.js` | T7 | 语义与 git 一致；`reset` 三模式 |
| T13 | 合并与摘取工具 | `…/lib/tools/{merge,cherry_pick,revert}.js` | T7 | `revert` fail-closed（§11.3） |
| T14 | 储藏与标签工具 | `…/lib/tools/{stash,tag}.js` | T7 | push/pop/apply/drop/list/clear；轻量与附注标签 |
| T15 | 远端工具 | `…/lib/tools/{remote,clone,fetch,pull,push}.js` | T16（凭据） | FR-204-022；无凭据 push 报可读错误 |
| T16 | 凭据文件能力 | `…/lib/credentials.js` + `…/lib/auth.js` | T4 | FR-204-020/021/022；`0600`；百分号编码往返 |

### 2.3 装配与 VCS

| ID | 任务 | 落点 | 依赖 | 验收 |
|---|---|---|---|---|
| T17 | 插件装配 | `…/index.js` | T10–T16 | FR-204-002/007/032；工具复查 + 诊断行 + cleanup |
| T18 | 凭据 RPC | `…/index.js`（RPC 定义 + 4 个 async handler） | T16 | FR-204-023；不回传口令 |
| T19 | VCS provider | `…/lib/vcs.js` + 装配点 | T7/T9 | FR-204-030/031/033；可单点回退 |
| T20 | 插件 README | `…/README.md` | T17–T19 | 工具面 / 凭据规则 / 围栏 / Known Limitations |
| T21 | 单测 | `…/tests/*.test.mjs` | T7–T16 | 凭据 ≥9 例、chroot、diff、status、revert、适配器 async 契约 |
| T22 | 宿主门禁脚本 | `scripts/verify-git-plugin.mjs` | T21 | 单测 + 临时目录真实 `init/add/commit/status/log/diff` |

### 2.4 构建与 UI

| ID | 任务 | 落点 | 依赖 | 验收 |
|---|---|---|---|---|
| T23 | 依赖物化 | `scripts/collect-app.mjs` `collectPluginRuntime()` | T4 | FR-204-040；断言 / 幂等 / `--force-plugin-runtime` |
| T24 | 期望工具表同步 | `scripts/collect-app.mjs` | T17 | FR-204-041（21 项） |
| T25 | 静态断言复核 | `scripts/collect-app.mjs` | T17 | FR-204-042；`--check-only` 全绿 |
| T26 | 设置页补丁 | `patches/v2.0.26/0008-git-credentials-settings.patch` | T18 | FR-204-024；`apply --check` 与 `--reverse --check` 均通过 |
| T27 | 补丁登记与文案 | `patches/v2.0.26/README.md` + i18n | T26 | 文案无上架禁用词 |
| T28 | 文档同步 | `plugins/README.md`、`README.md`、`docs/鸿蒙环境能力清单-v2.0.26.md`、`docs/工程规划-V2.md` | T26 | FR-204-044 |

## 3. 构建与部署

| ID | 任务 | 命令 / 落点 | 验收 |
|---|---|---|---|
| T29 | 运行时收集（如需要） | `node scripts/collect-runtime.mjs` | 守卫全绿；`APP_KEEP` 含 `plugins` |
| T30 | 上游构建（含补丁 ①–⑧ 与 UI 重建） | `node scripts/build-opencode.mjs` | 补丁幂等；`vite build` 成功；`smoke-node22` 通过 |
| T31 | 壳应用层投放 + 依赖物化 | `node scripts/collect-app.mjs` | 4 个插件投放；21 项工具元数据；`node_modules/` 物化断言通过 |
| T32 | HAP 编译签名 | `pwsh -File scripts/build-debug.ps1` | `electron-default-signed.hap` 产出；签名自检一致 |
| T33 | 真机安装与启动 | `hdc app install -r` + `aa start` | 安装成功；启动无 SIGTRAP / 无 `__ocError` |

## 4. 测试任务

| ID | 任务 | 覆盖 |
|---|---|---|
| T34 | `--inspect` 通道 + 插件在役 + 诊断行 | AC-1、AC-2、FR-204-032 |
| T35 | 凭据页走查（保存 / 回显长度 / 删除 / 门控） | AC-3、AC-8、FR-204-023/024/025 |
| T36 | 无账号仓库全链（AN-1…AN-22） | AC-4、AC-6 |
| T37 | 带账号仓库只读链（AR-1…AR-6） | AC-5 |
| T38 | 带账号仓库写链（AW-1…AW-6，含 AW-5 默认分支推送） | AC-5（副作用如实记录） |
| T39 | 缺凭据 / 凭据被拒（负例） | AC-7 |
| T40 | 围栏负例（`..` 逃逸 / 绝对路径 / 项目根外） | FR-204-010/013 |
| T41 | `revert` fail-closed 与 `rebase` 明确不支持 | AC-9、AC-10 |
| T42 | VCS 覆盖生效（会话 diff / 分支） | AC-6 |
| T43 | 基本功能回归（API Key / 工作区 / 一次对话） | AC-14 |
| T44 | 品牌化断言 + 明文四类载体检索 | AC-8、AC-15 |

## 5. 评审与收尾

| ID | 任务 | 验收 |
|---|---|---|
| T45 | 代码评审（`requesting-code-review` → `receiving-code-review`） | `logs/<YYYYMMDD>-N/REVIEW_REPORT.md`；Critical 清零；Important 已修 |
| T46 | 缺陷修复与回归 | `TEST_REPORT.md` 中逐条标注修复状态并回归通过 |
| T47 | 结论回写 | `docs/真机验证记录.md`、`docs/鸿蒙环境能力清单-v2.0.26.md` 相应条目更新 |
| T48 | 提交 | 按 `git-commit` 技能（Conventional Commits 前缀 `specification:` / `development:` / `code-review-fix:` / `testing:`；**无 AI 署名**） |

## 6. 执行顺序

1. T1 → T2 → T3
2. T4 → T5 → T6 → T7 →（T8、T9 可并行）
3. T16 →（T10、T11、T12、T13、T14、T15 可并行，T15 依赖 T16）
4. T17 → T18 → T19 → T20 → T21 → T22
5. T23 → T24 → T25
6. T26 → T27 → T28
7. T29 → T30 → T31 → T32 → T33
8. T34 → T35 → T36 → T37 → T38 → T39 → T40 → T41 → T42 → T43 → T44
9. T45 → T46 → T47 → T48
