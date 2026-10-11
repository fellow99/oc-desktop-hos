# 201-plugin-runtime 技术方案（plan）

> 模块：201-plugin-runtime ｜ 对应规格：[spec.md](./spec.md) ｜ Last Updated: 2026-10-11
> 上游基线：opencode `v2.0.26`（`Branch_v2.0.26` / `9b4ec5714d`）｜ 证据口径：✅ 实测 ／ 🔶 沿用 ／ ⬜ 待验证

## 1. 技术上下文

| 项 | 值 | 来源 |
|---|---|---|
| 插件执行位置 | **服务端进程内**（与服务端同权限：文件读写 + 命令执行） | `docs/工程规划-V2.md` §7.5 ✅（源码核实） |
| 声明入口 | 配置 `plugins` 数组（`"<pkg>"` / `{package,options}` / `"-<target>"`；支持 `file://`） | 同上 §3.9 ✅ |
| 发现入口 | 各**配置目录**下的 `plugin/` 与 `plugins/`（只认这两个名字） | 同上 §3.9（`source-directory.ts`）✅ |
| 配置目录集合 | 全局 `<XDG_CONFIG_HOME>/opencode`（本工程 = `<userData>/config/opencode`）、各项目根、兼容目录 `<home>/.claude` 与 `<home>/.agents`（受 `global` 开关控制） | 同上 ✅ |
| 加载两趟 | ① `install:false`：`Npm.resolve`，未装者记 `pending` ② `install:true`：真装后再加载 | 同上（`supervisor.ts#activate`）✅ |
| 安装实现 | 进程内 `import("@npmcli/arborist")` → `reify({save, saveType:"prod", ignoreScripts:true, binLinks:true, audit:false})`；缓存 `<XDG_CACHE_HOME>/opencode/npm/<key>`；EffectFlock 串行化；generation 目录切换 | 同上（`packages/util/src/npm.ts`）✅ |
| registry 配置 | 经 `@npmcli/config` 读取 `.npmrc` / `npm_config_*` / `registry` | 同上（`npm-config.ts`）✅ |
| 模块契约 | 默认导出 `{id, effect}` 或 `{id, setup}`；SDK 由产物前导注入 | 同上（`vite.node.config.ts#nodePrelude`）✅ |
| 治理 | `ManagedPolicy` 判 `deny` → `blocked`（静默禁用）；策略来自 Console 组织连接，本地不可写 | 同上（`module.ts`、`managed-policy.ts`）✅ |
| 失败可见性 | inventory（`failed` + `error` + `ref`）经 `GET /api/plugin` 暴露；`plugin.check` / `plugin.update` 走 `PluginUpdate` | 同上（`handlers/plugin.ts`）✅ |
| 热重载 | 依赖 `Watcher`；本工程 `OPENCODE_FILEWATCHER_DISABLE=1` → 空实现 → **变更不热重载** | 同上 ✅ |
| 现成开关 | **不存在** `OPENCODE_DISABLE_PLUGIN*`（已核对全部 `OPENCODE_*` 环境变量） | 同上 §3.9 ✅ |
| 平台语义（与安装相关） | 应用域无 `symlink`（`EACCES`）、`hmdfs` 无 hardlink（`EPERM`）、`chmod` 静默不落实 | dsh 真机 ✅（本工程 ⬜ 复验） |

**依赖**

| 依赖 | 来源 | 用途 |
|---|---|---|
| `@npmcli/arborist` / `@npmcli/config` | 上游 bundle 依赖闭包 | 进程内安装与 registry 配置 |
| 上游插件子系统（`supervisor` / `module` / `source-directory` / `discovery`） | `../opencode` `packages/core` | 声明、发现、加载、治理 |
| 物化脚本（构建期） | 本工程 `scripts/collect-app.mjs`（计划） | 壳专用插件 copy 物化 |
| `specs/012-data-dirs-sqlite/` 提供的根 | 本工程 | `<userData>/config/opencode`、`<userData>/cache/opencode` |

## 2. 关键决策

| # | 决策 | 备选与理由 | 状态 |
|---|---|---|---|
| D1 | v1 默认 **L0**：不声明 `plugins`、不投放 `plugin/`、`plugins/` 目录 | 备选「默认 L1」被否：L1 仍需随包投放第三方可执行 JS，收益不足以抵消安全面扩大 | 已决策 |
| D2 | L1 的壳专用插件由构建期 **copy 物化**到 `<userData>/config/opencode/plugin/<name>/` | 备选「投放到 resfile」被否：**不会生效**（只认配置目录）；备选「symlink」被否：应用域 `EACCES` | 已决策 |
| D3 | L2 保持上游 `ignoreScripts: true`，不 spawn 包管理器 | 备选「spawn npm/pnpm」被否：应用域子进程 JIT 受限（SIGSYS 风险）+ 不需要 | 已决策 |
| D4 | 需要硬开关时使用候选补丁 **`0005-plugin-gate`**（在读 `ConfigPluginSource` 处短路，或提供「仅本地插件」档） | 备选「靠不声明 + 不投放」被否：无法拦住**远端 well-known 清单**这类非本机声明入口 | ⬜ Phase 2 落地 |
| D5 | 档位是**部署期常量**（构建期写入 + 宿主装配期断言），不由模型/工具/远端更改 | 与 §3.8 的「部署期状态不是模型输入」同口径 | 已决策 |
| D6 | `pending` / `failed` / `blocked` 三类状态统一进壳层可见面（日志 + UI 状态） | 备选「只依赖 `GET /api/plugin`」被否：使用者不会去翻 API | 已决策 |
| D7 | 兼容目录（`<home>/.claude`、`<home>/.agents`）与远端 `well-known` 在 L0/L1 下纳入审计 | 备选「忽略」被否：它们是**不在本机也不在包里**的声明入口 | ⬜ 落实方式待定 |
| D8 | 插件安全面与 shell 通道**合并披露**（同一进程、同一权限） | 备选「分别描述」被否：会导致「插件比 shell 安全」的错觉 | 已决策 |

## 3. 数据模型

| 类型 | 字段 | 说明 |
|---|---|---|
| `PluginTier` | `tier`（`L0`/`L1`/`L2`）/ `source`（`build-constant`）/ `declaredAt` | 进程内单点；变更即日志 |
| `PluginMaterialization` | `name` / `srcDir` / `dstDir` / `method: "copy"` / `files[]` / `manifestOk` | 构建期产出，运行期只读校验 |
| `PluginInventoryEntry` | `id` / `status` / `error` / `ref` | 由 `GET /api/plugin` 归一化而来（⬜ 字段核对） |
| `PluginGate` | `mode`（`off`/`local-only`/`install`）/ `interceptAt`（`ConfigPluginSource` 读取处）/ `applied` | 候选补丁 0005 的开关状态 |
| `O8Probe` | `fsSemantics` / `registryReachable` / `installBytes` / `failureVisibility` / `verdict` | L2 前置探针结果（真机） |

## 4. 接口契约

### 4.1 档位配置契约（部署期）

```
// 构建期常量（host 侧）
OC_PLUGIN_TIER = "L0" | "L1" | "L2"

// 宿主装配期（src-main/main.js）
assertTierConsistency(OC_PLUGIN_TIER, {
  configHasPlugins: boolean,        // 生成的配置里是否出现 plugins 数组
  materializedDirs: string[],       // <userData>/config/opencode/plugin/* 清单
})
// 不一致（如 L0 却有 plugins 声明 / 有物化目录）⇒ fail-visible，不进入启动下一步
```

### 4.2 物化契约（构建期）

```
materializePlugins(srcRoot = "plugins/", dstRoot = "<userData>/config/opencode/plugin/")
  对每个 <srcRoot>/<name>/：
    1. 校验 package.json（name / main / exports / type）
    2. 递归 copy（**禁** symlink / hardlink；保留文件内容逐字节）
    3. 校验目标：manifestOk && 入口文件存在
    4. 幂等：已存在且内容一致则跳过；不一致则整体替换（copy 到临时名 → rename）
```

- 依赖 MUST 在构建期预置（`node_modules` 或 vendor 目录），运行期 MUST NOT 联网补装。
- 物化清单 MUST 写入 `[oc-desktop]` 日志与构建产物清单。

### 4.3 观测契约（运行期）

```
GET /api/plugin  ->  inventory[]（id / status / error / ref）
  ├─ status === "failed"  ⇒ 壳层显示失败条目（含 error 摘要）
  ├─ status === "pending" ⇒ 壳层显示「未安装（本版未启用安装通道）」
  └─ status === "blocked" ⇒ 壳层显示「被组织策略禁用」
L0 特例：inventory 为空 ⇒ 正常，不得报错
```

### 4.4 硬开关契约（候选补丁 `0005-plugin-gate`，Phase 2）

```
// 在读 ConfigPluginSource 处短路（1~2 处判空/短路）
if (gate.mode === "local-only") skipNpmTargets(declarations)   // 只保留本地路径 / file:// 目标
if (gate.mode === "off")       return []                       // 插件通道整体静默
```

- 纯抑制，不改动上游 `node` 行为；幂等、可往返（`docs/工程规划-V2.md` §6.2）。

## 5. 实现策略

1. **L0 先行（v1）**：包内不投放 `plugin/`、`plugins/`；配置不生成 `plugins` 数组；构建期加一条「L0 下不得存在这些目录」的守卫断言（FR-201-024）。
2. **物化通道先做构建期，不做运行期**：`collect-app.mjs` 在阶段 ③ 完成 copy 物化与校验；运行期只做「存在性 + 清单一致性」校验并打日志。
3. **状态可见性最小实现**：宿主定期（或启动后一次）拉 `GET /api/plugin`，归一化为壳层状态并写日志；UI 面在 Phase 2 与技能/能力页合并呈现。
4. **补丁 0005 在需要时生成**：先按 §4.4 的形状准备两处短路点；只有 L2 真要开放时才落地（避免无消费者的补丁）。
5. **O8 先探针后决策**：用一个最小 npm 包插件做真机 PoC（观察 `pending` → 成功 / `failed`），把 `FsSemanticsProbe` 的结论（hardlink / symlink / chmod）与安装体积一并记录，再决定 L2 是否进入 v1 之后的版本。
6. **披露一致性**：`docs/鸿蒙环境能力清单.md`、`docs/ACL申请清单.md`、`specs/202-skill-runtime-capabilities/` 与 README MUST 与本节档位一致（档位变化时先改规格，再同步文档）。

## 6. 测试与验证

| 层 | 手段 | 覆盖 |
|---|---|---|
| 单元（裸 Node，临时目录模拟 `<userData>`） | `node:test` | 物化幂等（重复执行/内容不一致替换）、manifest 校验失败分支、档位一致性断言（L0 + 有目录 ⇒ 报错）、inventory 归一化（空/`failed`/`pending`/`blocked` 四种输入） |
| 静态断言（构建期） | `grep` / 目录列举守卫 | L0：包内无 `plugin` / `plugins` 目录、配置无 `plugins` 声明；任何档位：代码中无 `symlink(` / `link(` 调用；权限声明面不含 `*PLUGIN*` |
| host 侧门禁 | `scripts/smoke-node22.mjs` | 启动后 `GET /api/plugin` 可达；L0 下返回空清单且不报错；插件通道不阻断服务端启动 |
| 真机（Phase 2） | 应用域取证（日志 + `--inspect`） | L1：物化目录被扫描、插件进入 inventory 且非 `failed`；插件失败时壳层可见；`pending` 时无联网安装 |
| 真机（L2 前置） | O8 探针（最小 npm 包插件） | 物化语义、registry 可达性、安装体积、失败可见性；结论写入 `docs/真机验证记录.md` |

**纪律**：设备条目在未执行时保持 ⬜；「上游源码核实」与「真机实测」两类证据 MUST 分开标注。

## 7. 文件清单

| 路径 | 角色 | 状态 |
|---|---|---|
| `plugins/<name>/` | 壳专用插件源码与打包源（本工程） | 计划（Phase 2） |
| `scripts/collect-app.mjs` | 物化 + 校验 + 档位一致性守卫 | 计划 |
| `src-main/main.js` | 档位断言、inventory 观测、日志 | 计划 |
| `patches/v2.0.26/0005-plugin-gate.patch` | 硬开关（`ConfigPluginSource` 读取处短路 / 仅本地档） | 候选（Phase 2） |
| `specs/201-plugin-runtime/{spec.md,plan.md}` | 本模块规格与方案 | 本次创建 |
| `docs/ACL申请清单.md` | 「不申请 `*PLUGIN*` 权限」的依据 | 本次创建 |
| `docs/真机验证记录.md` | O8 与档位验收结论落点 | 本次创建 |

## 8. 与规格的交叉引用

| 规格条目 | 本方案落点 |
|---|---|
| FR-201-001 ~ FR-201-006 | §4.1 档位一致性契约、D1/D2/D5/D6、§5.1 与 §5.3 |
| FR-201-007 ~ FR-201-015 | §1 技术上下文（机制全貌）、§4.3 观测契约 |
| FR-201-016 ~ FR-201-023 | §1（Arborist/npm-config）、D3/D4/D8、§4.4 硬开关契约、§5.4/5.5 |
| FR-201-024 ~ FR-201-026 | §4.2 物化契约、§5.2、§6 静态断言与验收 |
| 假设 1~7（⬜） | §3 数据模型字段标 ⬜、§4.3、§5.5 O8 探针 |
| 约束 1~5 | D8、D3、D4、`docs/ACL申请清单.md`、§5.1（核心能力不依赖插件） |
