# 签名与应用身份（006-signing-identity）—— 实现方案

> **Module:** 006-signing-identity ｜ **Status:** Proposed ｜ **Last Updated:** 2026-10-11 ｜ **上游基线:** opencode v2.0.26（Branch_v2.0.26）
> 对应规格：[spec.md](./spec.md)

## 1. 技术上下文

### 1.1 构建环境

- hvigor 构建在 host 侧 Windows 完成（DevEco 自带 JBR / Node / `hvigorw.bat`；`.bat` 经 `cmd /c` 调用）。
- 身份与权限的落地文件（均为工程内源码文件，参与构建）：
  - `AppScope/app.json5`：`bundleName`、`label`、`versionCode`、`versionName`、图标引用；
  - `electron/src/main/resources/{base,en_US,zh_CN}/element/string.json`：`EntryAbility_label`；
  - `electron/src/main/module.json5`：开放权限（`requestPermissions`）；
  - `web_engine/src/main/module.json5`：权限声明面（`requestPermissions` + `definePermissions`，含 JIT 与 3 项 ACL）；`runtime-overlays/web_engine/src/main/module.json5` 为回盖源（同 md5）；
  - `hvigorfile.ts`：签名材料注入（`afterNodeEvaluate`）。
- 运行时侧（harmonypc-electron）与身份相关的参考机制：`runtime-manifest.json` 的 `bundleNameRewrite.adapters`（4 个 ArkTS 适配文件各 1 处命中）——🔶 用于校验 `web_engine` 内是否残留旧 bundle 硬编码。

### 1.2 依赖

| 依赖 | 版本/来源 | 用途 |
|------|-----------|------|
| DevEco Studio | 本机安装 | 证书/Profile 生成、`hvigorw`、JBR |
| AGC 控制台 | 在线 | ACL 提交、发布 Profile 创建、备案信息 |
| `signing.debug.local.json` / `signing.release.local.json` | 本机（不入库） | 签名材料真值 |
| `signing.{debug,release}.local.json.sample` | 工程内 | 材料结构与字段名模板 |
| `docs/ACL申请清单.md` | 工程文档 | 申请文案与提交记录 |
| `docs/上架合规清单.md` | 工程文档 | `versionCode` 基线与合规检查项 |
| `005-build-pipeline` | 本工程 | 阶段④调用注入点与守卫 |

## 2. 关键决策

| 决策 | 结论 | 依据 |
|------|------|------|
| 包名 | `org.fellow99.oc.OCDesktop`（沿用 V1） | 工程规划 §3.7 |
| 显示名 | `OC Desktop` | 同上 |
| 改名机制 | 三处同步 + 校验脚本（不靠记忆） | 🔶 同型工程踩坑 |
| 签名材料注入 | `hvigorfile.ts#afterNodeEvaluate`，仅内存注入不写回 | 工程规划 §3.7 |
| 共享签名 | 不使用，必须自有证书 | bundleName 不同 |
| ACL 归属 | 按本包名单独申请 3 项受限权限（JIT / `READ_PASTEBOARD` / `READ_WRITE_DESKTOP_DIRECTORY`） | 工程规划 §3.7、§8.1；上游 `ACL申请清单-v1.md` |
| 权限声明纪律 | 只声明实际使用项；本批 ACL 共 3 项（JIT + `READ_PASTEBOARD` + `READ_WRITE_DESKTOP_DIRECTORY`），其余受限项一律不申请 | FR-006-011 / 013 / 025；§8.3 |
| JIT 权限 | `ALLOW_WRITABLE_CODE_MEMORY` 同时进 `requestPermissions` 与 `definePermissions` | 引擎必需，不可删 |
| ACL 清单对齐 | 按上游 `dsh-desktop-hos/docs/ACL申请清单-v1.md` §1 的 6 项逐项核对本工程声明面，差异以「补齐声明」消除 | spec FR-006-025（2026-10-14） |
| versionCode | 严格递增 + release 守卫（基线在 `docs/上架合规清单.md`） | §8.5 G7 |
| versionName | 与上游基线可读关联，职责与 `versionCode` 分离 | 上架信息一致性 |
| 图标守卫 | 解析 PNG IHDR 颜色类型判定 Alpha（4/6 带 Alpha） | §8.5 G2；无需图像库 |
| 调试开关 | release 档强制关闭并守卫 | §8.5 G10 |

## 3. 数据模型

### 3.1 实体定义

```js
appIdentity = {
  bundleName: 'org.fellow99.oc.OCDesktop',
  label: 'OC Desktop',
  labelSources: [
    'AppScope/app.json5',
    'electron/src/main/resources/base/element/string.json#EntryAbility_label',
    'electron/src/main/resources/en_US/element/string.json#EntryAbility_label',
    'electron/src/main/resources/zh_CN/element/string.json#EntryAbility_label',
  ],
  synced: true,
}

// versionName = '2.0.26'（三段式，与需求「版本号设为 2.0.26」一致）；versionCode 取
// major*10000 + minor*100 + patch = 20026（与兄弟工程 pi-desktop-hos 同一规则），且必须严格大于
// 上一发布基线（原为 1）。落地见 specs/101-version-2.0.26/{spec,plan}.md。
appVersion = { versionCode: 20026, versionName: '2.0.26', publishedBaseline: 1 }

signingMaterial = { debugFile, releaseFile, alias, injectedAt, writeBack: false }

aclEntry = { name, availableLevel: 'system_basic', provisionEnable: true, since: 14, reason, basis }

signingProfile = { type: 'debug'|'release', bundleName, generatedAt, rebuiltAfterAcl: true }
```

### 3.2 状态转换

```
identity-check（三处 label 一致 + 包名唯一）→ version-check（release: versionCode > baseline）
→ sign-inject（afterNodeEvaluate，内存注入）→ hvigor build → post-build-verify（产物签名/包名/版本）
失败 → 中止构建并打印具体检查项（fail-visible）
```

### 3.3 校验规则

- 三处 `EntryAbility_label` 与 `AppScope/app.json5` 的 `label` 必须逐字节相等（含语言目录全套）。
- 包名在构建脚本、ArkTS 源码中**只能作为引用**出现；任何与 `AppScope/app.json5` 不一致的字面量即判失败。
- `signing.*.local.json` 必须含必需字段（`bundleName`、`alias`、证书与 Profile 路径、密钥路径）；字段缺失即中止。
- `versionCode` 必须为整数且严格大于基线（release 档）。
- 图标 PNG：`IHDR` 的 color type ∈ {4, 6} 或含 `tRNS` 块 → 判为带 Alpha，中止。

## 4. 接口契约

### 4.1 本模块提供

| 接口 | 说明 |
|------|------|
| `hvigorfile.ts#afterNodeEvaluate` | 读取 `signing.<mode>.local.json` 并注入 hvigor 签名配置（内存） |
| `scripts/lib/identity.mjs` | 身份检查：label 三处一致、包名唯一、禁用词扫描 |
| `scripts/lib/version-guard.mjs` | `versionCode` 递增守卫（对比 `docs/上架合规清单.md` 基线） |
| `scripts/lib/png-guard.mjs` | 图标 Alpha 守卫（PNG `IHDR` 解析） |
| `AppScope/app.json5` | `bundleName` / `label` / `versionCode` / `versionName` 的单一来源 |
| `web_engine/src/main/module.json5` | 受限权限 `definePermissions`（含 JIT 权限）与开放权限声明（含 3 项 ACL：JIT / `READ_PASTEBOARD` / `READ_WRITE_DESKTOP_DIRECTORY`） |

### 4.2 本模块消费

| 来源 | 契约 |
|------|------|
| `signing.debug.local.json` / `signing.release.local.json` | 签名材料（本机文件，不入库） |
| `docs/ACL申请清单.md` | 申请原因/使用场景文本；ACL 获批记录 |
| `docs/上架合规清单.md` | `versionCode` 上一发布基线；合规检查项状态 |
| `005-build-pipeline` | 阶段④的构建入口与 release 档参数 |
| `runtime-manifest.json#bundleNameRewrite.adapters` | 校验 `web_engine` 内旧 bundle 硬编码的参考清单 |

## 5. 实现策略

### 5.1 关键算法

- **签名注入（`hvigorfile.ts`）**：在 `afterNodeEvaluate` 中读取 `signing.<mode>.local.json`（`mode` 由构建参数决定），组装 `signingConfigs` 字段并写回 hvigor 的内存配置对象；**不调用任何写文件 API**。文件缺失或字段缺失即 `throw`，使构建以非零退出。
- **身份检查**：读 `AppScope/app.json5`（JSON5 解析或正则取值）→ 与三套 `string.json` 的 `EntryAbility_label` 逐一比对 → 扫描 `web_engine/src/main/ets/**` 中与「旧包名/其它包名」匹配的字面量 → 输出差异表。
- **版本守卫**：解析 `docs/上架合规清单.md` 中的基线行（约定格式：`versionCode 基线: N`）→ 比较 `AppScope/app.json5` 的值 → release 档要求 `>` 基线；debug 档只要求整数。
- **图标守卫**：读 PNG 前 33 字节，校验签名与 `IHDR` 的 color type、`trns` 存在性；判定为带 Alpha 即中止。
- **调试开关守卫**：release 档扫描构建参数与运行时常量（`--inspect`、`remote-debugging-port`）是否被启用。

### 5.2 错误处理

- 任守卫失败 → 打印「检查项 / 期望 / 实际 / 修复提示」并退出非零。
- 签名材料缺失 → 打印缺失文件的绝对路径与必需字段清单（MUST NOT 打印材料内容）。
- Profile `type` 非 release 而走 release 档构建 → 标记并中止（上架资格问题）。
- ACL 相关失败不在构建期处理（属外部审批），但 `docs/ACL申请清单.md` MUST 记录当前状态，便于人工判断。

### 5.3 降级

- **无构建期降级**：身份、版本、签名、图标、调试开关五类问题一律 fail-visible。
- 唯一允许的例外：debug 档允许缺少 release 材料（反之不允许），且该分支 MUST 在日志中显式标注「本次产物不可上架」。

## 6. 测试与验证

### 6.1 host 侧

- **身份检查单测**：构造「三处一致」「一处不一致」「含禁用词」三种输入，断言检查结果与提示文本。
- **版本守卫单测**：基线 `N` 与取值 `N-1`/`N`/`N+1` 三组断言（release 档只有 `N+1` 通过）。
- **PNG 守卫单测**：用 color type 2/6 与含 `tRNS` 的三份小图断言判定结果。
- **签名注入单测**：以 `.sample` 为模板构造临时材料文件，调用注入函数后断言「返回的内存对象含 signingConfigs」且「工作区文件哈希未变」（零写回）。
- **零写回断言**：注入前后对工程目录做哈希快照比对（排除构建产物目录）。

### 6.2 真机命令

```bash
# 安装与启动（bundleName 即身份真值）
hdc app install -r electron/build/default/outputs/default/electron-default-signed.hap
hdc shell aa start -a EntryAbility -b org.fellow99.oc.OCDesktop
hdc uninstall org.fellow99.oc.OCDesktop        # 对照实验：清空后重装观察 JIT 权限首装行为

# 身份与状态取证
hdc shell aa dump -a                          # Ability 状态与所属包名
hdc shell "bm dump -n org.fellow99.oc.OCDesktop"   # 包信息（命令可用性 ⬜ 待验证）
hdc shell "hilog -x | grep oc-desktop"
```

- 真机 MUST 记录：桌面/任务视图显示名、安装是否被权限策略拒绝、JIT 示性探针结果（与 007 联动），落 `docs/真机验证记录.md`；ACL 状态变化落 `docs/ACL申请清单.md`。

### 6.3 验收口径

- spec §5 七个场景全绿；「材料缺失 / 版本未递增 / 图标带 Alpha / release 档调试开关」四类守卫各被真实触发一次；`git status --porcelain` 在完成 debug 构建后无签名材料相关改动；`node scripts/collect-runtime.mjs --verify-only` 阶段 10.6/10.7 全绿（ACL 6 项在册 + JIT 两处 + overlay md5 一致）。

## 7. 文件清单

| 文件（相对工程根） | 用途 |
|--------------------|------|
| `AppScope/app.json5` | `bundleName` / `label` / `versionCode` / `versionName` 单一来源 |
| `electron/src/main/resources/base/element/string.json` | `EntryAbility_label`（基础） |
| `electron/src/main/resources/en_US/element/string.json` | `EntryAbility_label`（英文） |
| `electron/src/main/resources/zh_CN/element/string.json` | `EntryAbility_label`（中文） |
| `electron/src/main/module.json5` | 开放权限声明（`requestPermissions`）与避免 `browsable`/`viewData` |
| `web_engine/src/main/module.json5` | 权限声明面（`requestPermissions` 8 项 + `definePermissions`，含 JIT 与 3 项 ACL）；`runtime-overlays/` 同文件为回盖源 |
| `hvigorfile.ts` | 签名材料注入（`afterNodeEvaluate`，仅内存）+ release 守卫调用 |
| `signing.debug.local.json.sample` / `signing.release.local.json.sample` | 材料模板（入库，无真实密钥） |
| `scripts/lib/identity.mjs` / `version-guard.mjs` / `png-guard.mjs` | 身份、版本、图标守卫 |
| `scripts/build-release.ps1` | release 档入口（先守卫后构建） |
| `AppScope/resources/base/media/`（应用图标） | 1024×1024 纯色不透明图标 |
| `docs/ACL申请清单.md` / `docs/上架合规清单.md` | ACL 申请与版本基线、合规检查项 |

## 8. 与规格的交叉引用

| 规格需求 | 落点 |
|----------|------|
| FR-006-001 ~ 004（身份与命名） | `AppScope/app.json5`、三套 `string.json`、`scripts/lib/identity.mjs` |
| FR-006-005 ~ 009（签名与 Profile） | `hvigorfile.ts`（`afterNodeEvaluate`）、`signing.*.local.json.sample` |
| FR-006-010 ~ 016、025、026（ACL 归属） | `web_engine/src/main/module.json5`、`runtime-overlays/web_engine/src/main/module.json5`、`scripts/collect-runtime.mjs`（阶段 10.6/10.7 断言）、`docs/ACL申请清单.md` |
| FR-006-017 ~ 020（versionCode 与版本纪律） | `AppScope/app.json5`、`scripts/lib/version-guard.mjs`、`scripts/build-release.ps1`、`docs/上架合规清单.md` |
| FR-006-021 ~ 024（身份类合规守卫） | `scripts/lib/png-guard.mjs`、`AppScope/resources/base/media/`、release 档开关守卫、`docs/上架合规清单.md` |
