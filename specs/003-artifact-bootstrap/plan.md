# 产物就位（003-artifact-bootstrap）—— 实现方案

> **Module:** 003-artifact-bootstrap ｜ **Status:** Proposed ｜ **Last Updated:** 2026-10-11 ｜ **上游基线:** opencode v2.0.26（Branch_v2.0.26）
> 对应规格：[spec.md](./spec.md)

## 1. 技术上下文

### 1.1 运行时环境

- 解压发生在 Electron 主进程（ArkTS UIAbility 进程内，Electron 37 / Node 22.17.0），早于宿主加载（`env → artifact → host`）。
- 产物来源：`resfile/resources/app/opencode-dist.tar.gz`（只读打包资源），主进程侧以 `path.join(__dirname, 'opencode-dist.tar.gz')` 定位；⬜ 待验证：主进程 `__dirname` 在本运行时确实解析到 `resfile/resources/app/`（验证方式：真机打印 `__dirname` 到 `[oc-desktop]` 日志）。
- 目标文件系统：`<userData>` = `/data/storage/el2/base/files`（hmfs）。
- 同一份解析器在 host 侧（Windows + Node 22.17）可复用，用于构建期/冒烟期往返校验。

### 1.2 依赖

| 依赖 | 版本/来源 | 用途 |
|------|-----------|------|
| `node:zlib` `createGunzip()` | Node 22.17.0 内置 | gzip 流式解压 |
| `node:crypto` `createHash('sha256')` | 内置 | 包指纹、关键文件回读校验 |
| `node:fs` / `node:stream` | 内置 | 顺序读、逐文件写、目录创建 |
| `node:path` | 内置 | 路径拼接与越界判定 |
| `005-build-pipeline` | 本工程 | 产出并校验 tar.gz 与 marker |
| `002-lifecycle` | 本工程 | 驱动 `artifact` 阶段、展示失败 |

## 2. 关键决策

| 决策 | 结论 | 依据 |
|------|------|------|
| 产物形态 | 单文件 `opencode-dist.tar.gz`（ustar + gzip） | 🔶 小文件入 HAP 不可行 |
| 解压实现 | 自研流式解析器（不调用设备 `tar`） | 设备无可用 `tar`/`gzip` 保证；也便于 host 侧复用 |
| 顶层前缀 | 唯一前缀 `dist-node/`，解压时剥掉 | 工程规划 §6.3「剥前缀」 |
| marker 语义 | 内容 = tar 包 SHA-256，比对而非存在性 | 纠正 🔶 dsh 只比存在性导致就地升级不生效 |
| 替换策略 | 临时目录解压 + 关键文件校验 + 目录替换 | 不留半成品；失败不破坏旧产物 |
| 目录替换手段 | `fs.rename(tmp, final)`（⬜ 原子性待真机验证）；失败退化路径为「先备份旧目录 → 移动新目录 → 删备份」 | hmdfs 语义未验证 |
| 失败策略 | 有旧产物 → 可见提示 + 继续用旧产物；无旧产物 → 阻断 | fail-visible 且不让应用永久不可用 |
| 链接条目 | 直接判失败 | 🔶 应用域不支持 symlink/hardlink |
| 文件 mode | 不设置、不校验 | 🔶 `chmod` 静默失效且无意义 |
| 增量解压 | 不做（整包替换） | 语义简单、可自证；解压耗时待实测后再评估 |

## 3. 数据模型

### 3.1 实体定义

产物包与 marker：

```js
bundle  = { tarPath: '<resfile>/resources/app/opencode-dist.tar.gz', sha256, sizeBytes }
marker  = { path: '<userData>/opencode-dist.version', sha256, writtenAt }
```

解压结果：

```js
{ root: '<userData>/opencode-dist', fileCount, bytes, durationMs, skipped }
```

tar 条目（ustar 头解析结果）：

```js
{ name, relPath, type: 'file'|'dir'|'rejected', size, mode, mtime }
```

### 3.2 状态转换

```
ensureArtifact()
 ├─ 计算包 SHA-256（流式）
 ├─ 读 marker：sha 相同且产物完整 → return { skipped: true }
 ├─ 清残留临时目录 → 解压到 <userData>/opencode-dist.tmp-<sha8>/
 │     ├─ 条目非法 / gzip 损坏 / 写盘失败 → 清 tmp → 失败分支
 ├─ 关键文件回读校验（opencode.mjs 大小 + SHA-256）
 │     └─ 不一致 → 清 tmp → 失败分支（phase = recheck）
 ├─ 替换：rename(tmp → opencode-dist)（失败则走备份/移动/删备份）
 └─ 写 marker（原子写：临时文件 + rename）→ return ExtractResult
失败分支：有旧产物 → 记录 + 可见提示 + 继续；无旧产物 → 抛错（阻断启动）
```

### 3.3 校验规则

- 条目名 MUST 通过：非绝对路径、无 `..` 段、最终路径 `path.resolve(root, relPath)` 仍以 `root` 为前缀。
- 只接受 `typeflag` 为 `0`/`\0`（普通文件）与 `5`（目录）；`1`/`2`（链接）与其它类型一律拒绝。
- ustar 头校验：magic `ustar\0` + version `00`；`size` 为八进制且 ≤ 合理上限（分块写入，依据 size 精确消费字节流）。
- 解压结束判据：两个连续 512 字节全零块；未达结束符而流终止 → 判失败。

## 4. 接口契约

### 4.1 本模块提供

| 接口 | 说明 |
|------|------|
| `ensureArtifact()` | 幂等地保证产物就位；返回 `ExtractResult`；失败抛结构化 `ExtractError` |
| `artifactRoot()` | 返回 `<userData>/opencode-dist`（供 007/008 使用，避免各处拼路径） |
| `assetsDir()` | 返回 `<userData>/opencode-dist/assets`（供 008 设 `OPENCODE_NODE_ASSETS_DIR`） |
| `parseTarGz(stream)` | 纯流式解析器（无副作用），供 host 侧往返校验复用 |
| `globalThis.__extractError` | 失败摘要（脱敏、≤2500 字符） |

### 4.2 本模块消费

| 来源 | 契约 |
|------|------|
| `resfile/resources/app/opencode-dist.tar.gz` | 只读输入；格式 ustar + gzip；拓扑前缀 `dist-node/` |
| `resfile/resources/app/opencode-dist.version` | 构建期写出的 SHA-256（**运行时只读校验用**，不作为 marker；marker 在 `<userData>`） |
| 环境/运行时 | `--user-data-dir` 提供的 `<userData>`（`app.getPath('userData')`） |
| 002-lifecycle | 阶段开始/结束回调与失败展示 |
| Node `zlib`/`crypto`/`fs` | 解压与哈希原语 |

> 注：`resfile` 内的 `opencode-dist.version` 与 `<userData>/opencode-dist.version` 同名但职责不同——前者是构建期产出的事实记录（供 005 校验与真机对照），后者是运行时幂等 marker；实现 MUST 以「HAP 内 tar 的 SHA-256」为唯一判据，不信任任何可写目录中的值作为来源。

## 5. 实现策略

### 5.1 关键算法（ustar 流式解析）

1. `fs.createReadStream(tarPath)` → `zlib.createGunzip()`；
2. 维护 512 字节对齐缓冲：读满一个头块 → 解析字段（`name[0..100]`、`mode[100..108]`、`size[124..136]`（八进制）、`mtime[136..148]`、`typeflag[156]`、`linkname[157..257]`、`magic[257..263]`、`prefix[345..500]`）；
3. 条目名 = `prefix` 非空时为 `prefix + '/' + name`；剥掉首段 `dist-node/` 得到 `relPath`；
4. 目录条目 → 递归 `mkdir`；文件条目 → `createWriteStream` 精确写入 `size` 字节，并跳过 `512 - (size % 512)` 填充；
5. 结束判定：连续两个全零头块 → `finish`；期间到达流末尾 → 判失败；
6. 全程单遍、单缓冲，内存上限为「一个头的缓冲 + 每个文件的写缓冲」。

### 5.2 错误处理

- gzip 损坏 / 头非法 / 条目非法 / 流提前结束 → `phase = 'extract'`，附条目名（若有），清临时目录。
- 写盘失败（空间不足、权限）→ `phase = 'extract'`，记录系统错误码原文（🔶 便于区分 hmdfs 语义问题）。
- 回读校验不一致 → `phase = 'recheck'`，不替换最终目录。
- 目录替换失败 → `phase = 'replace'`，按「备份 → 移动 → 删备份」降级；两次都失败则保留旧产物并报错。
- 所有失败路径 MUST 先清理临时目录，再写 `__extractError`。

### 5.3 降级

- 唯一降级：**沿用旧产物**（仅当旧产物目录与旧 marker 自洽），并在 UI/日志给出可见提示。
- 首次无旧产物时无降级路径（阻断在 `artifact` 阶段），因为宿主没有可执行入口。

## 6. 测试与验证

### 6.1 host 侧

- **往返校验（必做）**：用 host 侧 Node 22.17 调用同一个 `parseTarGz` 解开 `opencode-dist.tar.gz`，断言：文件数 > 0、`opencode.mjs` 存在且 SHA-256 与构建期记录一致、`assets/app-archive.bin` 存在、无链接条目、全部条目名以 `dist-node/` 开头。
- **坏包注入**：截断包、篡改 gzip 尾、构造含 `../escape` 与 symlink 条目的包各一份，断言解析器以 `ExtractError` 失败且不写目标目录。
- **幂等断言**：连续调用两次 `ensureArtifact()`（模拟已就位）断言第二次 `skipped = true` 且 marker 内容不变。
- 与 `005-build-pipeline` 的构建期校验共享同一断言函数，避免两处口径漂移。

### 6.2 真机命令

```bash
hdc app install -r electron/build/default/outputs/default/electron-default-signed.hap
hdc shell aa start -a EntryAbility -b rg.fellow99.oc.OCDesktop
hdc shell "hilog -x | grep oc-desktop"        # 记录 sha 前 8 位 / 文件数 / 字节数 / 耗时 / 是否跳过

# 产物与 marker 观察（应用域目录在 shell 侧是否可读 ⬜ 待验证）
hdc shell "ls -l /data/storage/el2/base/files/opencode-dist"
hdc shell "cat /data/storage/el2/base/files/opencode-dist.version"

# 升级验证：卸载前记录 marker，重装新 HAP 后再次观察
hdc uninstall rg.fellow99.oc.OCDesktop        # 仅用于「清空全量」对照实验
```

- 真机 MUST 采集：首次解压耗时、二次启动跳过耗时、解压后占用（`du -sh` 类命令可用性 ⬜ 待验证）、首启总耗时，落 `docs/真机验证记录.md`。

### 6.3 验收口径

- host 侧往返校验与坏包注入全绿；真机首次解压成功、二次跳过、升级自动生效；三类失败（tar 损坏、写盘失败、回读不一致）各产生一次可读结论。

## 7. 文件清单

| 文件（相对工程根） | 用途 |
|--------------------|------|
| `src-main/tar-extract.js` | 流式 gzip + ustar 解析、剥前缀、安全校验、原子替换、marker 读写 |
| `src-main/main.js` | 调用 `ensureArtifact()`、阶段回调、`__extractError` 汇总 |
| `scripts/collect-opencode.mjs` | 裁剪 + `tar --format=ustar` 打包 + 写 `opencode-dist.version` + 投放 `resfile`（见 005） |
| `web_engine/src/main/resources/resfile/resources/app/opencode-dist.tar.gz` | 运行时输入（构建期产出） |
| `web_engine/src/main/resources/resfile/resources/app/opencode-dist.version` | 构建期 SHA-256 事实记录 |
| `docs/真机验证记录.md` | 解压耗时、体积、升级与失败注入留证 |

## 8. 与规格的交叉引用

| 规格需求 | 落点 |
|----------|------|
| FR-003-001 ~ 003（产物形态与投放） | `scripts/collect-opencode.mjs`、`web_engine/.../resfile/resources/app/` |
| FR-003-004 ~ 008（解压） | `src-main/tar-extract.js`（`parseTarGz` / `ensureArtifact`） |
| FR-003-009 ~ 013（失败可见与恢复） | `src-main/tar-extract.js`（`ExtractError` + 临时目录清理）、`src-main/main.js`（`__extractError`） |
| FR-003-014 ~ 017（marker 与升级） | `src-main/tar-extract.js`（marker 读写与比对）、`scripts/collect-opencode.mjs` |
| FR-003-018 ~ 019（路径契约） | `src-main/main.js`（`artifactRoot()` / `assetsDir()` 导出给 007/008） |
