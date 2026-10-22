# 101 — 版本更新：2.1.2 任务清单

> **回引:** `spec.md` / `plan.md` ｜ **最后更新:** 2026-10-22
> 里程碑 M1–M5 顺序推进，未完成不得进入下一里程碑。日志目录：`logs/20261022-1/`。

## M1 静态收敛（T01–T03）

### T01 — 规格与日志目录落地
| 项 | 内容 |
|---|---|
| 回引 | FR-ver-109 |
| 动作 | 建立 `specs/101-version-2.1.2/`（本四件套）与 `logs/20261022-1/` |
| 完成判据 | 4 个规格文件存在且非空；日志目录存在 |
| 产出 | 本目录 + `logs/20261022-1/DEV_CHECKLIST.md` |

### T02 — 清理中间/临时文件
| 项 | 内容 |
|---|---|
| 回引 | FR-ver-101 |
| 动作 | 按 `plan.md` §3 清单逐条删除；删除前断言命中 `.gitignore` |
| 完成判据 | `git status --porcelain` 无 ` D ` 行；删除清单目标不存在；保留清单完好 |
| 风险 | R3 误删签名材料——清单显式排除 |

### T03 — 版本号 2.1.2 / 20102 与守卫更新
| 项 | 内容 |
|---|---|
| 回引 | FR-ver-102/103 |
| 动作 | `AppScope/app.json5` → `2.1.2`/`20102`；`README.md` 版本行同步；`scripts/build-opencode.mjs` 三处基线引用（plan D4） |
| 完成判据 | `grep` 复查无「当前版本 2.0.26」语义残留（历史锚点除外） |

## M2 补丁迁移（T04–T05）

### T04 — 补丁逐条评估与迁移
| 项 | 内容 |
|---|---|
| 回引 | FR-ver-104、plan D3 |
| 动作 | `mkdir patches/v2.1.2`；对 8 条旧补丁逐条 `git -C ../opencode apply --check`；通过→复制；失败→按 v2.1.2 源码重生成 |
| 完成判据 | `patches/v2.1.2/` 每条补丁 `--check` 通过（未应用态）、应用后 `--reverse --check` 通过 |

### T05 — 补丁目录 README 重写
| 项 | 内容 |
|---|---|
| 回引 | FR-ver-104 |
| 动作 | `patches/v2.1.2/README.md`：新基线表 + 补丁清单（编号/落点/作用）+ 生成命令 |
| 完成判据 | README 与实际 `.patch` 文件一一对应 |

## M3 构建与部署（T06–T08）

### T06 — opencode 产物构建
| 项 | 内容 |
|---|---|
| 回引 | FR-ver-105 |
| 动作 | `collect-runtime` → `collect-app` → `build-opencode`（幂等打补丁 + bun + bundle + 收集 + 冒烟） |
| 完成判据 | 守卫全绿；冒烟 8 项全绿；`.stage/opencode-dist.tar.gz` 就绪 |

### T07 — HAP 构建 + 签名
| 项 | 内容 |
|---|---|
| 回引 | FR-ver-105 |
| 动作 | `pwsh -File scripts\build-debug.ps1` |
| 完成判据 | `electron-default-signed.hap` 产出；`versionName 2.1.2` / `versionCode 20102` |

### T08 — 真机部署
| 项 | 内容 |
|---|---|
| 回引 | FR-ver-106 |
| 动作 | `hdc uninstall org.fellow99.oc.OCDesktop` → `hdc app install -r ...` → `hdc shell aa start -a EntryAbility -b org.fellow99.oc.OCDesktop` |
| 完成判据 | 安装成功 + 界面加载非白屏 |

## M4 测试与报告（T09–T11）

### T09 — 真机测试执行
| 项 | 内容 |
|---|---|
| 回引 | FR-ver-107/108 |
| 动作 | `test-cases.md` §3（基本功能）+ §4（GIT 操作）+ §5（能力抽查）；凭证运行时输入，文档占位 |
| 完成判据 | 每条用例有结论；`TEST_REPORT.md` 产出 |

### T10 — 代码评审
| 项 | 内容 |
|---|---|
| 回引 | FR-ver-109 |
| 动作 | `requesting-code-review` 派发评审 → `receiving-code-review` 处理反馈 → `REVIEW_REPORT.md` |
| 完成判据 | 无未处理 Critical/Important 项 |

### T11 — 敏感信息扫描
| 项 | 内容 |
|---|---|
| 回引 | FR-ver-108 |
| 动作 | 暂存区 diff 复查 + 全库敏感串扫描；设备侧 GIT 凭据条目删除确认 |
| 完成判据 | 扫描零命中；记录入 `logs/20261022-1/` |

## M5 提交（T12）

### T12 — 规范提交
| 项 | 内容 |
|---|---|
| 回引 | FR-ver-109 |
| 动作 | 按 `git-commit` 技能前缀分批提交；`build-profile.json5` 本地签名 diff **不提交** |
| 完成判据 | `git log` 前缀合规；`git status` 仅剩签名配置本地 diff |
