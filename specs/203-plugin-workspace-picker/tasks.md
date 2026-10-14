# 203-plugin-workspace-picker 任务清单

> **Module:** 203-plugin-workspace-picker ｜ **Last Updated:** 2026-10-14
> 对应规格：[spec.md](./spec.md) ｜ 对应方案：[plan.md](./plan.md)

## 1. 规格任务

| ID | 任务 | 落点 | 依赖 | 验收 |
|---|---|---|---|---|
| T1 | 设计文档 | `docs/203-插件-选择工作区目录.md` | — | 现状/关键事实带证据标注；含根围栏与验收标准 |
| T2 | 规格四件套 | `specs/203-plugin-workspace-picker/{spec,plan,tasks,test-cases}.md` | T1 | 符合 `specs/README.md` §2 固定章节与 FR 编号 |
| T3 | 编号登记 | `specs/README.md` §1 | T2 | 203 行存在且与目录名一致 |

## 2. 开发任务

| ID | 任务 | 落点 | 依赖 | 验收 |
|---|---|---|---|---|
| T4 | 插件包骨架 | `plugins/oc-plugin-workspace-roots/package.json` | T2 | 目录名 = `name`；`type: module`；`main: index.js` |
| T5 | 插件 RPC 定义与注册 | `…/index.js` | T4 | `export default { id, setup }`；`context.rpc.register` 5 方法 |
| T6 | 主目录解析（含沙箱根自动创建） | `…/index.js` | T5 | FR-203-003/004/005/006 |
| T7 | `mkdir`（段名校验 + 根包含性 + 判重） | `…/index.js` | T5 | FR-203-012–017 |
| T8 | 权限桥（check / request / openAppInfo） | `…/index.js` | T5 | FR-203-021–024；桥不可用有结构化降级 |
| T9 | 插件 README | `…/README.md` | T8 | 含 RPC 契约、四主目录表、Known Limitations |
| T10 | 宿主注入 `OCR_USER_ROOTS` | `src-main/main.js` | T2 | FR-203-004/006；不改 `build-profile.json5` |
| T11 | 客户端纯函数与类型 | 补丁 `packages/app/src/workspaces/selection/roots.ts` | T2 | §3.2 全部函数 + RPC 封装 + 探测函数 |
| T12 | 纯函数用例 | 补丁 `…/roots.test.ts` | T11 | 围栏/根识别/裁剪/去重/面包屑各有用例 |
| T13 | 对话框四主目录模式 | 补丁 `…/dialog.tsx` | T11 | FR-203-001/002/008/009/012/018/020/030 |
| T14 | 文案键 | 补丁 `…/i18n/{en,zh}.ts` | T13 | 无禁用词；非 en 语言回退成立 |
| T15 | 生成补丁文件 | `patches/v2.0.26/0007-workspace-roots-picker.patch` | T11–T14 | `git apply --check` 与 `--reverse --check` 均通过 |
| T16 | 补丁说明登记 | `patches/v2.0.26/README.md` | T15 | 0007 条目与内容一致 |
| T17 | 工程 README 同步 | `README.md` | T15 | 补丁区间/插件列表表述准确 |

## 3. 构建与部署

| ID | 任务 | 命令 / 落点 | 验收 |
|---|---|---|---|
| T18 | 运行时收集 | `node scripts/collect-runtime.mjs` | 守卫全绿；overlay md5 断言通过 |
| T19 | 上游构建（含补丁与 UI 重建） | `node scripts/build-opencode.mjs` | 补丁幂等；`vite build` 成功；`smoke-node22` 通过 |
| T20 | 壳应用层投放 | `node scripts/collect-app.mjs` | 3 个插件投放；sha256 与静态断言通过 |
| T21 | HAP 编译签名 | `pwsh -File scripts/build-debug.ps1` | `electron-default-signed.hap` 产出；签名断言通过 |
| T22 | 真机安装与启动 | `hdc app install -r` + `aa start` | 安装成功；应用启动无 SIGTRAP |

## 4. 测试任务

| ID | 任务 | 覆盖 |
|---|---|---|
| T23 | `--inspect` 通道与插件在役检查 | AC-10、FR-203-026/027 |
| T24 | 四主目录切换 / 沙箱自建 / 用户目录列举 | AC-1、AC-2、AC-3、AC-13（建目录部分） |
| T25 | 根围栏 / 入口精简检查 | AC-4、AC-5 |
| T26 | 新建文件夹（含去重、越界、同名） | AC-7 |
| T27 | 授权流程（清除授权后） | AC-6 |
| T28 | 采纳工作区 + 主目录记忆 | AC-8、AC-9 |
| T29 | 回退行为与品牌化断言 | AC-11、AC-12 |
| T30 | 四个位置各建一个工作区并各完成一次对话 | AC-13 |

## 5. 评审与收尾

| ID | 任务 | 验收 |
|---|---|---|
| T31 | 代码评审（requesting-code-review + receiving-code-review） | `logs/<date>-N/REVIEW_REPORT.md`；Critical 清零 |
| T32 | 缺陷修复与回归 | `TEST_REPORT.md` 中缺陷标注修复状态并回归通过 |
| T33 | 结论回写 | `docs/真机验证记录.md`、`docs/鸿蒙环境能力清单-v2.0.26.md` 相应条目标注 |
| T34 | 提交 | 按 `git-commit` 技能规范提交（Conventional Commits，无 AI 署名） |

## 6. 执行顺序

1. T1 → T2 → T3
2. T4 → T5 →（T6、T7、T8 可并行）→ T9
3. T10
4. T11 → T12 → T13 → T14 → T15 → T16 → T17
5. T18 → T19 → T20 → T21 → T22
6. T23 → T24 → T25 → T26 → T27 → T28 → T29 → T30
7. T31 → T32 → T33 → T34
