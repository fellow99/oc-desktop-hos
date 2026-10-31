# 011 — 版本更新：2.2.5 任务清单（hos）

> **回引:** `spec.md` / `plan.md` ｜ **最后更新:** 2026-10-31
> M1–M5 顺序推进。日志目录：`logs/20261031-1/`。

## M1 静态收敛（T01–T03）

### T01 — 规格与日志目录落地
- 建立 `specs/011-version-2.2.5/`（四件套）与 `logs/20261031-1/`
- 完成判据：4 文件非空；`DEV_CHECKLIST.md` 存在

### T02 — 清理中间/临时文件
- 按 plan §3 清单逐条删除；删除前断言命中 `.gitignore`
- 完成判据：`git status --porcelain` 无 ` D ` 行；保留清单完好

### T03 — 版本号 2.2.5 / 20205 与守卫更新
- `AppScope/app.json5` → `2.2.5`/`20205`；`README.md` 版本行
- `scripts/build-opencode.mjs`：`PATCH_DIR`、`EXPECTED_BASELINE=9bbb8ce18c`、版本正则 `2\.2\.5`、`BUN_REQUIRED='1.4.4'`
- 完成判据：grep 无旧版本语义残留

## M2 补丁迁移（T04–T05）

### T04 — 补丁逐条评估与迁移
- `mkdir patches/v2.2.5`；对 8 条旧补丁逐条 `git -C ../opencode apply --check`
- 原样复制：0001/0002/0004/0005/0006；重生成：**0003/0007/0008**
- 完成判据：每条 `--check` 通过（未应用态），应用后 `--reverse --check` 通过

### T05 — 补丁目录 README 重写
- `patches/v2.2.5/README.md`：新基线表 + 补丁清单 + 生成命令
- 完成判据：README 与 `.patch` 一一对应

## M3 构建（T06–T08）

### T06 — opencode 产物构建
- `collect-runtime` → `collect-app` → `build-opencode`（幂等补丁 + bun 1.4.4 + bundle + 收集 + 冒烟）
- 完成判据：守卫全绿；`.stage/opencode-dist.tar.gz` 就绪

### T07 — HAP 构建 + 签名
- `pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/build-debug.ps1`
- 完成判据：`electron-default-signed.hap` 产出；versionName 2.2.5 / versionCode 20205

### T08 — host 门禁（替代真机）
- `smoke-node22`、`test-harmony-plugins`、`verify-branding`、`verify-git-plugin`
- 完成判据：全绿，输出入日志

## M4 测试与评审（T09–T11）

### T09 — 真机测试
- **跳过（无鸿蒙真机）**；test-cases 逐条标注 SKIP-无设备

### T10 — 代码评审
- `requesting-code-review` 派发 → `receiving-code-review` 处理 → `REVIEW_REPORT.md`
- 完成判据：无未处理 Critical/Important

### T11 — 敏感信息扫描
- 暂存区 diff 复查 + 全库敏感串扫描；`../opencode` 工作树恢复干净
- 完成判据：零命中

## M5 提交（T12）

### T12 — 规范提交 + 本地 tag
- 按 git-commit 技能 Conventional Commits 前缀分批提交；签名配置本地 diff 不提交
- `git tag v2.2.5`；**不 push**
- 完成判据：`git log` 前缀合规；tag 存在
