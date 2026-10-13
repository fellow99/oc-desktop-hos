# 101 — 版本更新：2.0.26 任务清单

> **回引:** `spec.md` / `plan.md` ｜ **最后更新:** 2026-10-13
> 每条任务一张表：**回引 | 动作 | 完成判据 | 产出 | 风险**。里程碑 M1–M4 顺序推进，未完成不得进入下一里程碑。

## M1 静态收敛（T01–T04）

### T01 — 规格与日志目录落地
| 项 | 内容 |
|---|---|
| 回引 | FR-ver-022 |
| 动作 | 建立 `specs/101-version-2.0.26/`（spec/plan/tasks/test-cases）与 `logs/20261013-1/` |
| 完成判据 | 4 个规格文件存在且非空；日志目录存在 |
| 产出 | 本目录 + `logs/20261013-1/` |
| 风险 | 无 |

### T02 — 版本号提升为 2.0.26 / 20026
| 项 | 内容 |
|---|---|
| 回引 | FR-ver-003、FR-ver-004 |
| 动作 | 改 `AppScope/app.json5`；同步 `README.md`；`grep -rn "0\.1\.0"` 逐条解释 |
| 完成判据 | `versionName=2.0.26`、`versionCode=20026`；无「当前版本 0.1.0」残留 |
| 产出 | `AppScope/app.json5`、`README.md` |
| 风险 | 文档中历史引用需区分 |

### T03 — 中间/临时文件清理
| 项 | 内容 |
|---|---|
| 回引 | FR-ver-001、FR-ver-002 |
| 动作 | 按 `plan.md` §3 删除清单逐条删除，删除前断言路径命中 `.gitignore`；保留清单不触碰 |
| 完成判据 | `git status --porcelain` 无 ` D ` 行；`electron/libs/`、`.stage/`、`app/opencode-dist.tar.gz` 已移除 |
| 产出 | 清理记录（`logs/20261013-1/DEV_CHECKLIST.md`） |
| 风险 | R2 误删签名材料——清单显式排除 |

### T04 — 补丁集往返校验
| 项 | 内容 |
|---|---|
| 回引 | FR-ver-005、FR-ver-006、FR-ver-007、FR-ver-008 |
| 动作 | 逐条 `git -C ../opencode apply --check` / `--reverse --check`；核对 `patches/v2.0.26/README.md` 清单与文件一致 |
| 完成判据 | 4 条补丁各自「未应用可正向」或「已应用可反向」；README 清单一致 |
| 产出 | 校验输出记录 |
| 风险 | 0002 与 0003 同改 `packages/core/package.json`，顺序敏感 |

## M2 构建可用（T05–T07）

### T05 — 收集运行时并过守卫
| 项 | 内容 |
|---|---|
| 回引 | FR-ver-009、FR-ver-010 |
| 动作 | `node scripts/collect-runtime.mjs` |
| 完成判据 | 阶段 10 守卫全绿；`electron/libs/arm64-v8a/{libc++_shared.so,better_sqlite3.node}` 就位 |
| 产出 | `electron/`、`web_engine/` 外壳树 + 守卫输出 |
| 风险 | R2：`.cache/runtime` 被清理后需重新解压（耗时） |

### T06 — 构建 opencode Node 产物并过 host 门禁
| 项 | 内容 |
|---|---|
| 回引 | FR-ver-009、FR-ver-011 |
| 动作 | `node scripts/build-opencode.mjs` |
| 完成判据 | `dist-node/opencode.mjs` + `assets/app-archive.bin` 就绪；`smoke-node22.mjs` 8 项全绿；`--version`/`--help` 正常 |
| 产出 | `.stage/opencode-dist.tar.gz`（+ SHA-256 marker） |
| 风险 | R1：app 重新构建可能改变 UI 归档指纹 |

### T07 — 构建并签名 HAP
| 项 | 内容 |
|---|---|
| 回引 | FR-ver-012 |
| 动作 | `pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/build-debug.ps1` |
| 完成判据 | 产出 `electron-default-signed.hap`；签名校验通过；包内版本为 2.0.26 |
| 产出 | HAP |
| 风险 | 签名材料缺失则硬失败（不静默） |

## M3 功能可用（T08–T10）

### T08 — 真机部署与启动就绪
| 项 | 内容 |
|---|---|
| 回引 | FR-ver-013、FR-ver-021 |
| 动作 | `hdc uninstall` → `hdc app install -r` → `aa start`；取 `hilog` 与 `ocr-trace.log` |
| 完成判据 | 阶段日志推进到「界面已加载」；无白屏、无失败页 |
| 产出 | 日志摘录 + 截图 |
| 风险 | R3：日志缺失则用落盘 trace |

### T09 — 基本功能三项
| 项 | 内容 |
|---|---|
| 回引 | FR-ver-014、FR-ver-015、FR-ver-016 |
| 动作 | 设置 DeepSeek Key → 沙箱建测试目录并选为工作区 → 发「介绍一下你自己」 |
| 完成判据 | Key 持久化；工作区被接受为项目根；取得模型回复 |
| 产出 | 会话消息摘录 |
| 风险 | R6：先用 `/api/*` 锁定服务端，再走 UI |

### T10 — 鸿蒙环境能力复验
| 项 | 内容 |
|---|---|
| 回引 | FR-ver-017、FR-ver-018、FR-ver-020 |
| 动作 | 按 `docs/鸿蒙环境能力清单.md` §5 的 ⬜-1…⬜-12 逐条取证（应用域为准） |
| 完成判据 | 每条有结论 + 证据 + 日期 + 设备；未实测者保留 ⬜ |
| 产出 | 原始证据（`logs/20261013-1/`）+ 报告素材 |
| 风险 | 平台差异；证据域混淆 |

## M4 交付完成（T11–T13）

### T11 — 报告落盘
| 项 | 内容 |
|---|---|
| 回引 | FR-ver-019 |
| 动作 | 产出 `docs/鸿蒙环境能力清单-v2.0.26.md`；v0.1 文件原地保留 |
| 完成判据 | 新文件存在；v0.1 未被修改 |
| 产出 | 报告 |
| 风险 | 与 v0.1 结论冲突须显式标注 |

### T12 — 代码评审
| 项 | 内容 |
|---|---|
| 回引 | FR-ver-022 |
| 动作 | `requesting-code-review` 派评审 → `receiving-code-review` 处理 → 落 `REVIEW_REPORT.md` |
| 完成判据 | 无未决 Critical/Important |
| 产出 | `logs/20261013-1/REVIEW_REPORT.md` |
| 风险 | 评审范围过大导致噪声——按 Critical/Important/Minor 分级收敛 |

### T13 — 提交
| 项 | 内容 |
|---|---|
| 回引 | FR-ver-023 |
| 动作 | 按 `git-commit` 技能的 Conventional Commits 前缀分阶段提交 |
| 完成判据 | `git log --format=%s` 全部前缀在允许集合内 |
| 产出 | 提交记录 |
| 风险 | 不得写 AI 署名脚注 |
