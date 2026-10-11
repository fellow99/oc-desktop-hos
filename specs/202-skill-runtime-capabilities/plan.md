# 202-skill-runtime-capabilities 技术方案（plan）

> 模块：202-skill-runtime-capabilities ｜ 对应规格：[spec.md](./spec.md) ｜ Last Updated: 2026-10-11
> 上游基线：opencode `v2.0.26`（`Branch_v2.0.26` / `9b4ec5714d`）｜ 证据口径：✅ 实测 ／ 🔶 沿用 ／ ⬜ 待验证

## 1. 技术上下文

| 项 | 值 | 来源 |
|---|---|---|
| 技能载体 | 本工程 `skills/<name>/SKILL.md`（随包投放，构建期进入产物投放区） | `docs/工程规划-V2.md` §4.1、§4.3 |
| 与上游的关系 | 技能格式按 opencode v2 的 `SKILL.md` 约定；发现路径与加载时机 ⬜ 待与上游源码核对 | 同上 §4.3；⬜ |
| 权威规范源 | `docs/鸿蒙环境能力清单.md`（能力 × 状态 × 根因层 × 证据）、`docs/toybox命令清单.md`（命令可达性）、`docs/ACL申请清单.md`（权限边界） | 本次创建 |
| 能力契约源 | `specs/010-tool-shell/`、`specs/011-workspace-auth/`、`specs/012-data-dirs-sqlite/`、`specs/201-plugin-runtime/` | 本次创建 |
| 状态判定来源 | `docs/真机验证记录.md`（⬜ → ✅ 的唯一依据） | 本次创建 |
| 同类先例 | 🔶 同型工程：技能未随能力同步 → 模型拒绝使用已交付工具；该先例使「同步治理」成为硬需求 | `docs/工程规划-V2.md` §4.3、§9.2 |

**依赖**

| 依赖 | 来源 | 用途 |
|---|---|---|
| 技能文件的发现与加载契约 | `../opencode`（⬜ 待定位） | 决定技能投放位置与文件形态 |
| 构建期投放流程 | 本工程 `scripts/collect-app.mjs`（计划） | 把 `skills/` 投放到运行时可见位置 |
| 能力清单与命令清单 | 本工程 `docs/` | 漂移检查的判定集合 |

## 2. 关键决策

| # | 决策 | 备选与理由 | 状态 |
|---|---|---|---|
| D1 | 规范源与技能**单向派生**（先改规范源） | 备选「双份维护」被否：漂移不可避免，且漂移代价已由先例证明 | 已决策 |
| D2 | 技能只做**一页摘要**（结论 + 操作要点），证据链留在规范源 | 备选「技能带证据」被否：技能进模型上下文，体积敏感 | 已决策 |
| D3 | 漂移检查做成**构建期断言**（命令名集合 + 必备能力域 + 版本绑定） | 备选「评审时人工看」被否：人工检查在迭代中退化为零 | 已决策 |
| D4 | 技能内容不得承诺未获批权限带来的能力 | 备选「先写上、以后再说」被否：使用者按提示操作会失败，属可避免的体验缺陷 | 已决策 |
| D5 | 未实测能力在技能中保持「待验证 / 不可用」，不提前写成可用 | 与「⬜ 不得伪造成 ✅」的全局纪律一致 | 已决策 |
| D6 | 技能的具体投放位置与文件形态**等上游契约核对后再定**（本模块不预设） | 备选「先按猜测定路径」被否：错路径 = 技能静默不生效，恰是本模块要防的失败模式 | ⬜ 待验证 |

## 3. 数据模型

| 类型 | 字段 | 说明 |
|---|---|---|
| `SkillDocument` | `name` / `path` / `specVersion` / `sections[]` / `updatedAt` | `specVersion` 绑定能力清单版本与日期 |
| `CapabilitySnapshot` | `capabilities[]` / `commands{direct,toyboxOnly,absent,dangerous}` / `permissions{granted,notRequested}` | 从规范源机械抽取的最小集合 |
| `DriftCheck` | `unknownCommands[]` / `staleClaims[]` / `missingClauses[]` / `passed` | 构建期输出；非空即失败 |
| `SyncTrigger` | `capabilityAdded` / `capabilityRemoved` / `permissionChanged` / `tierChanged` | 触发技能复核的事件清单 |

**必备能力域（`missingClauses` 的判定集合）**

1. 可用命令与禁用项（含 `toybox <n>` 用法与 mksh 内建遮蔽提示）；
2. 无 PTY / 无交互式程序；
3. 路径围栏与审批语义（越界 → 拒绝 → 如何申请）；
4. 数据与项目目录语义（项目根、沙箱、授权前置）；
5. 插件档位现状（默认不启用安装）；
6. 降级清单（内容搜索等）与其「明示而非静默」要求。

## 4. 接口契约

### 4.1 技能 ↔ 规范源的引用契约

```
SKILL.md 顶部元信息（形态待上游核对，⬜）：
  name: <技能名>
  specVersion: <能力清单版本>（例：v0.1 / 2026-10-11）
  source: docs/鸿蒙环境能力清单.md, docs/toybox命令清单.md, docs/ACL申请清单.md

正文每条结论 SHOULD 带规范源出处（章节号或条目编号），例如：
  「无 git/rg/curl（见 能力清单 #18；命令清单 §8.1）」
```

### 4.2 漂移检查契约（构建期）

```
checkSkillDrift(skillText, snapshot) -> DriftCheck
  1. 抽取技能中出现的命令名（反引号包裹的命令 style + 需要执行的行内命令）
  2. 每个命令名 ∈ (snapshot.commands.direct ∪ snapshot.commands.toyboxOnly
                   ∪ snapshot.commands.absent ∪ snapshot.commands.dangerous)
     否则 unknownCommands += 名字
  3. staleClaims：技能声称「不可用」，但能力清单该项状态已为 ✅ ⇒ 报告
  4. missingClauses：§3 的六个必备域未覆盖 ⇒ 报告
  5. passed = 三类均为空
```

### 4.3 技能内容骨架（写作契约，不含具体措辞）

| 段 | 必须回答的问题 |
|---|---|
| 概览 | 这台设备是什么（HarmonyOS 2in1/平板 + Electron 运行时 + opencode 服务端） |
| 能做 | 文件读写、命令执行（mksh + toybox）、会话与工具调用 |
| 不能做 | 无 PTY/交互式、无 `bash`/`git`/`rg`/`curl`、无 LSP/MCP 外部进程 |
| 怎么做 | 命令写法（`toybox <n>`、避免 bash 语法、绝对路径优先）、越界时的申请方式 |
| 前置与授权 | 项目目录授权 + 可能需要重启；数据在沙箱内 |
| 降级 | 每个不可用能力的**可见降级**（空结果 + 明示）与替代做法 |
| 观测纪律 | 以应用域结论为准；不要用 `hdc shell` 视角推断应用可访问性 |

## 5. 实现策略

1. **先落规范源，后写技能**：本模块创建时，`docs/鸿蒙环境能力清单.md`、`docs/toybox命令清单.md`、`docs/ACL申请清单.md` 已就位（同批创建），技能写作以其为唯一输入。
2. **技能投放等契约核对**：Phase 0 随 P0-1/P0-3 一起核对上游技能契约（D6），确认后再定 `skills/` 的投放位置与文件形态（⬜）。
3. **漂移检查进流水线**：在构建期（`collect-app` 之后或独立脚本）执行 §4.2，失败即阻断（与 host 门禁同级）。
4. **同步触发**：能力清单状态变化（`docs/真机验证记录.md` 的结论回写）即视为 `SyncTrigger`，技能复核在当轮内完成。
5. **与插件/文档一致披露**：`specs/201-plugin-runtime/` 的档位、`docs/ACL申请清单.md` 的权限面、README 的能力描述 MUST 与技能正文同口径（口径变化先改规范源）。
6. **不越界**：本模块不新增设备能力、不改任何上游代码；只做文档治理与检查。

## 6. 测试与验证

| 层 | 手段 | 覆盖 |
|---|---|---|
| 构建期断言 | `checkSkillDrift`（§4.2） | 未知命令名、过期声明（staleClaims）、必备域缺失（missingClauses）、`specVersion` 存在性 |
| 评审检查 | 人工对照 | 技能每条结论可在规范源定位；不含未获批权限的能力承诺 |
| host 侧门禁 | 随 `scripts/smoke-node22.mjs` | 技能投放后不影响服务端启动；技能文件在投放区存在且可读 |
| 真机（Phase 0/1） | 应用域取证 | 技能被加载（模型侧可见其名称/描述）；技能内容与实际能力一致（抽测 3 条：命令可达性、围栏拒绝、降级明示） |

**纪律**：任何「能力已可用」的表述必须以 `docs/真机验证记录.md` 的结论为前提；否则技能保持 ⬜/不可用表述。

## 7. 文件清单

| 路径 | 角色 | 状态 |
|---|---|---|
| `skills/<name>/SKILL.md` | 壳专用技能正文（名字与形态待上游契约核对后确定） | ⬜ 计划 |
| `scripts/check-skill-drift.mjs`（或并入现有构建脚本） | 漂移检查（§4.2） | ⬜ 计划 |
| `scripts/collect-app.mjs` | 技能投放（跟随其它应用产物） | 计划 |
| `specs/202-skill-runtime-capabilities/{spec.md,plan.md}` | 本模块规格与方案 | 本次创建 |
| `docs/鸿蒙环境能力清单.md`、`docs/toybox命令清单.md`、`docs/ACL申请清单.md` | 权威规范源（技能的唯一输入） | 本次创建 |

## 8. 与规格的交叉引用

| 规格条目 | 本方案落点 |
|---|---|
| FR-202-001 ~ FR-202-006 | §4.3 技能内容骨架、D1/D2/D4/D5、§5.1/5.5 |
| FR-202-007 ~ FR-202-011 | §4.1/4.2 契约（引用与漂移检查）、§6 构建期断言、D3 |
| 假设 1~5（⬜） | §1 技术上下文、D6、§5.2（投放等契约核对）、§5.4（同步触发） |
| 约束 1~4 | §5.6 不越界、§6 纪律、`docs/ACL申请清单.md` 权限面 |
