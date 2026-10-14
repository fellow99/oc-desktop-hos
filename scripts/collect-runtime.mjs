#!/usr/bin/env node
/**
 * collect-runtime.mjs —— 阶段 ①：收集 Electron-on-鸿蒙 运行时（工程规划 §6.1）。
 *
 * 流水线（任一阶段失败即非零退出，绝不静默降级）：
 *   0  前置校验：运行时清单、发行版归档 / 预解压源、DEVECO_SDK_HOME、AppScope 身份
 *   1  取得运行时源码树：
 *         a) 默认：../harmonypc-electron-versions/v37.2.3-20260825.1-release.zip
 *            → 内层 libelectron_*.tar.gz → 解到 <工程>/.cache/runtime/<binaryVersion>/
 *         b) --runtime-source <dir>：使用已解压的 ohos_hap（CI 预置 / 离线机器）
 *   2  拷贝 electron/ + web_engine/ 进工程（排除 build/oh_modules 等生成物）
 *   3  剪裁运行时中本应用不需要的文件（PRUNE_FILES，缺失即硬失败，防外壳结构漂移）
 *   4  恢复本应用 App 主进程文件：src-main/* → resfile/resources/app/（+ skills 树）
 *   5  应用 runtime-overlays/ 白名单回盖（module.json5 / label 资源）
 *   6  声明式文本改写（REWRITE_RULES，命中次数断言）：关闭运行时默认开启的调试开关
 *   7  bundleName 字面量替换（清单 bundleNameRewrite.adapters，命中次数断言）
 *   8  清理 resfile/resources/app 中的应用无关文件（白名单外全删并逐条打印）
 *   9  注入 libc++_shared.so（DevEco SDK）与 better_sqlite3.node（aarch64-ohos / ABI 138）
 *   10 结构化守卫（SO md5 / 壳标记 / barrel 导出 / 身份 / 权限集 / 调试开关 / 图标合规 / 残留）
 *
 * 用法：
 *   node scripts/collect-runtime.mjs                       原地重建运行时（默认）
 *   node scripts/collect-runtime.mjs --extract-only         只做 0-4、7-9（不覆盖 overlay、不跑守卫）
 *   node scripts/collect-runtime.mjs --verify-only          只跑阶段 10 守卫
 *   node scripts/collect-runtime.mjs --runtime-source <dir> 用预解压的 ohos_hap 目录
 *   node scripts/collect-runtime.mjs --allow-placeholder-icons 包内图标缺失时回退生成纯色占位图（仅首次导入取骨架）
 *   node scripts/collect-runtime.mjs --release <zip>         指定发行版归档
 *   node scripts/collect-runtime.mjs --no-libcxx --no-sqlite 跳过原生注入（host 侧检查用）
 *
 * 前置：
 *   - ../harmonypc-electron/ohos_hap/runtime-manifest.json（运行时契约清单，submodule 提供）
 *   - ../harmonypc-electron-versions/ 下存在 v37 发行版归档（或 --runtime-source）
 *   - DEVECO_SDK_HOME 指向 DevEco SDK 根（注入 libc++_shared.so 必需）
 */
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  banner,
  copyOne,
  copyTree,
  exists,
  fail,
  fileSize,
  findFiles,
  hasCommand,
  isDir,
  isFile,
  listDir,
  listZipEntries,
  log,
  md5File,
  mkdirp,
  parseArgs,
  readJson,
  readPngHeader,
  readText,
  rel,
  removeTree,
  require_,
  run,
  runOrFail,
  sha256File,
  warn,
  writeSolidPng,
  writeText,
  readFileHead,
  extractTarGz,
  extractZip,
} from './lib/util.mjs';

// ------------------------------------------------------------------ 常量

const PROJECT_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const WORKSPACE_ROOT = resolve(PROJECT_ROOT, '..');
const SHELL_SOURCE_DIR = join(WORKSPACE_ROOT, 'harmonypc-electron', 'ohos_hap');
const MANIFEST_PATH = join(SHELL_SOURCE_DIR, 'runtime-manifest.json');
const VERSIONS_DIR = join(WORKSPACE_ROOT, 'harmonypc-electron-versions');
const DEFAULT_RELEASE = join(VERSIONS_DIR, 'v37.2.3-20260825.1-release.zip');
const SQLITE_GUIDE_DIR = join(VERSIONS_DIR, 'better-sqlite3编译指导（Electron37）');
const CACHE_DIR = join(PROJECT_ROOT, '.cache', 'runtime');

/** 期望的应用身份（与 AppScope/app.json5 单一事实源保持一致，阶段 10 守卫） */
const EXPECTED_BUNDLE_NAME = 'org.fellow99.oc.OCDesktop';
const EXPECTED_APP_LABEL = 'OC Desktop';

/** 拷贝模块时排除的顶层目录（生成物 / 版本控制 / 缓存） */
const EXCLUDE_TOP = new Set([
  'build',
  'oh_modules',
  'node_modules',
  '.git',
  '.hvigor',
  '.idea',
  '.cxx',
  '.cache',
  '.test',
  'test',
]);

/** 本应用主进程产物目录（Electron 约定：resfile/resources/app） */
const APP_RESFILE_DIR = 'web_engine/src/main/resources/resfile/resources/app';

/**
 * runtime-overlays/ 回盖白名单（相对工程根的镜像路径）。
 * 全部为**本应用定制**：模块清单（权限/后台保活）与显示名资源（三套 locale）。
 * 阶段 10.7 逐一做源/目标 md5 一致性守卫 —— 覆盖缺失即硬失败。
 */
const OVERLAY_FILES = [
  'electron/src/main/module.json5',
  'electron/src/main/resources/base/element/string.json',
  'electron/src/main/resources/en_US/element/string.json',
  'electron/src/main/resources/zh_CN/element/string.json',
  'web_engine/src/main/module.json5',
];

/**
 * 声明式文本改写（阶段 6）：把运行时默认开启、但生产不允许的开关去掉。
 * 每条断言「原始命中次数」与「改写后残留数」，防止上游外壳漂移后静默失效。
 * 依据：工程规划 §5.4「生产开关」与 §2.4 启动参数（运行时默认带 --inspect）。
 */
const REWRITE_RULES = [
  {
    file: 'web_engine/src/main/ets/common/CommandLineAdapter.ets',
    description: '移除运行时默认开启的 --inspect（生产包禁止远程调试端口）',
    from: '"--inspect",',
    to: '',
    expectedHits: 1,
  },
];

/**
 * 运行时中本应用不需要的文件（阶段 3 删除）。
 * 删除前断言存在：缺失说明上游外壳结构已变化，必须重新评估，不得静默跳过。
 *
 * ⚠️ 当前为**空表**：曾尝试剪裁 4 个蓝牙适配器（BluetoothAdapter / BluetoothLowEnergyAdapter 及其
 * Bind），但基线的 `web_engine/src/main/ets/jsbindings/JsBindingMethod.ets` 仍静态 import 它们，
 * 删除后 ArkTS/Rollup 直接编译失败（`Could not resolve "../jsbindings/BluetoothAdapterBind"`）。
 * 要剪裁必须同时提供 JsBindingMethod.ets 的 overlay（改写 import 与注册行）——登记为 Phase 2 精修项，
 * 详见 `docs/真机验证记录.md`。蓝牙能力本身已通过**移除权限声明**（web_engine module.json5 overlay）关闭。
 */
const PRUNE_FILES = [];

/** 本应用 App 主进程文件（阶段 4 投放；新增 src-main 文件必须在此登记，否则不进 HAP） */
const APP_FILES = [
  ['src-main/main.js', `${APP_RESFILE_DIR}/main.js`],
  ['src-main/sidecar.js', `${APP_RESFILE_DIR}/sidecar.js`],
  ['src-main/tar-extract.js', `${APP_RESFILE_DIR}/tar-extract.js`],
  ['src-main/package.json', `${APP_RESFILE_DIR}/package.json`],
];

/** resfile/resources/app 白名单（其他一律清理；opencode-dist.tar.gz 由阶段 ② 投放，缺失允许） */
const APP_KEEP = new Set([
  'main.js',
  'sidecar.js',
  'tar-extract.js',
  'package.json',
  'electron_white.png',
  'opencode-dist.tar.gz',
  'skills',
  // 壳专用 opencode 插件（由 scripts/collect-app.mjs 投放；此白名单必须保留它，
  // 否则「先 collect-app 后重跑 collect-runtime」会把插件从 resfile 删掉）
  'plugins',
]);

/**
 * 权限断言：必须**不得**出现的受限/上架障碍权限（工程规划 §8.3）。
 * 例外：`READ_WRITE_DESKTOP_DIRECTORY` 自 006-signing-identity 对齐
 * `dsh-desktop-hos/docs/ACL申请清单-v1.md` 后**改为声明并随批次申请**（见 REQUIRED_PERMISSIONS），
 * 因此从本表移除；上架前仍须按 `docs/ACL申请清单.md` §7.3 ⬜-6 复核是否保留。
 */
const FORBIDDEN_PERMISSIONS = [
  'ohos.permission.PRINT',
  'ohos.permission.CUSTOM_SANDBOX',
  'ohos.permission.RUN_ANY_CODE',
  // ⚠️ 真实权限名带 `kernel.` 前缀（原表写成 `ohos.permission.LOAD_INDEPENDENT_LIBRARY`，
  //    该名字不存在 ⇒ 声明真名时本断言不会命中，属静默失效，2026-10-14 修正）
  'ohos.permission.kernel.LOAD_INDEPENDENT_LIBRARY',
  'ohos.permission.ALLOW_EXTERNAL_NATIVE_CODE',
];

/**
 * 权限断言：必须**存在**的权限（对齐 `docs/ACL申请清单.md` §1 的 6 项：
 * 3 项需 ACL + 3 项开放权限，另有本工程自用的 INTERNET / GET_NETWORK_INFO）。
 */
const REQUIRED_PERMISSIONS = [
  'ohos.permission.INTERNET',
  'ohos.permission.GET_NETWORK_INFO',
  'ohos.permission.kernel.ALLOW_WRITABLE_CODE_MEMORY',
  'ohos.permission.READ_PASTEBOARD',
  'ohos.permission.READ_WRITE_DESKTOP_DIRECTORY',
  'ohos.permission.READ_WRITE_DOCUMENTS_DIRECTORY',
  'ohos.permission.READ_WRITE_DOWNLOAD_DIRECTORY',
  'ohos.permission.FILE_ACCESS_PERSIST',
];

/**
 * `user_grant` 权限（`docs/ACL申请清单.md` §1 的 #2–#5）。
 * 这些项**必须**带 `reason` + `usedScene`，否则系统授予弹窗/上架审核会缺材料；
 * 断言实现见 stage10Guards 10.6b（定位条目本体直到其 `}`，再断言含 `usedScene`），
 * 以容忍 json5 注释与字段顺序变化。
 */
const USER_GRANT_PERMISSIONS = [
  'ohos.permission.READ_PASTEBOARD',
  'ohos.permission.READ_WRITE_DESKTOP_DIRECTORY',
  'ohos.permission.READ_WRITE_DOCUMENTS_DIRECTORY',
  'ohos.permission.READ_WRITE_DOWNLOAD_DIRECTORY',
];

/** JIT 权限（V8 必需，须同时出现在 requestPermissions 与 definePermissions） */
const JIT_PERMISSION = 'ohos.permission.kernel.ALLOW_WRITABLE_CODE_MEMORY';

/**
 * 包内图标位（上架合规 §8.5 G2；尺寸与 alpha 规则见 specs/103-branding/spec.md FR-brand-009）。
 *
 * 自 2.0.26 起，这 5 个文件由 `scripts/lib/branding.mjs --generate-icons` 从入库透明位图
 * `assets/brand/*-transparent.png` 生成并入库；本表的 `size` 是**必须**满足的边长。
 *
 * `ensureAppIcons()` 不再静默兜底：文件缺失即硬失败（FR-brand-010「不得静默产出无品牌/占位图标的包」），
 * 只有显式传 `--allow-placeholder-icons` 才允许生成纯色占位图（仅用于首次导入取骨架）。
 */
const PLACEHOLDER_ICONS = [
  ['AppScope/resources/base/media/app_icon.png', 1024],
  ['AppScope/resources/base/media/icon.png', 512],
  ['AppScope/resources/base/media/startIcon.png', 512],
  ['AppScope/resources/base/media/product_logo_32.png', 32],
  ['AppScope/resources/base/media/window_icon.png', 200],
];
/**
 * 允许携带 Alpha 通道的图标位。
 *
 * **2026-10-14 口径变更（FR-brand-009 修订）**：原先只允许 `window_icon.png`，其余应用级图标必须
 * 不带 Alpha（当时的依据是「含 Alpha 会被应用市场驳回」）。真机上白底母版表现为「白方块 + 橙环」，
 * 用户判定不可接受并要求改用透明底的 `logo.png` ⇒ 5 个图标位**全部保留 Alpha**。
 * 残留风险：带 Alpha 的应用图标能否通过应用市场审核**未经证实**；若被驳回，回退方案见
 * specs/103-branding/spec.md R6（把图案压在深色或品牌色底上，仍保持无 Alpha）。
 */
const ALPHA_ALLOWED_ICONS = new Set([
  'AppScope/resources/base/media/app_icon.png',
  'AppScope/resources/base/media/icon.png',
  'AppScope/resources/base/media/startIcon.png',
  'AppScope/resources/base/media/product_logo_32.png',
  'AppScope/resources/base/media/window_icon.png',
]);

// ------------------------------------------------------------------ 参数

const args = parseArgs();
const EXTRACT_ONLY = args.has('extract-only');
const VERIFY_ONLY = args.has('verify-only');
const RESOLVE_LIBCXX = !args.has('no-libcxx') && !VERIFY_ONLY;
/** 允许回退生成纯色占位图标（仅首次导入取骨架；见 ensureAppIcons 的 FR-brand-010 说明） */
const ALLOW_PLACEHOLDER_ICONS = args.has('allow-placeholder-icons');
const RESOLVE_SQLITE = !args.has('no-sqlite') && !VERIFY_ONLY;
const RELEASE_ZIP = resolve(args.get('release', DEFAULT_RELEASE));
const RUNTIME_SOURCE = args.get('runtime-source', '');

// ------------------------------------------------------------------ 阶段 0

function stage0() {
  banner(0, '前置校验');
  require_(isFile(MANIFEST_PATH), `运行时契约清单缺失: ${MANIFEST_PATH}\n  请确认 ../harmonypc-electron 已切换到含 runtime-manifest.json 的提交。`);
  const manifest = readJson(MANIFEST_PATH);
  require_(typeof manifest.binaryVersion === 'string', `清单缺少 binaryVersion: ${MANIFEST_PATH}`);
  require_(Array.isArray(manifest.so) && manifest.so.length > 0, `清单缺少 so 清单: ${MANIFEST_PATH}`);
  require_(Array.isArray(manifest.shellMarkers) && manifest.shellMarkers.length > 0, `清单缺少 shellMarkers: ${MANIFEST_PATH}`);
  const rewrite = manifest.bundleNameRewrite;
  require_(rewrite && typeof rewrite.from === 'string' && Array.isArray(rewrite.adapters) && rewrite.adapters.length > 0, `清单缺少 bundleNameRewrite: ${MANIFEST_PATH}`);
  log(0, `清单 shellVersion=${manifest.shellVersion} binaryVersion=${manifest.binaryVersion} adapters=${rewrite.adapters.length}`);

  const appScope = join(PROJECT_ROOT, 'AppScope', 'app.json5');
  require_(isFile(appScope), `AppScope/app.json5 缺失: ${appScope}`);
  const match = readText(appScope).match(/"bundleName"\s*:\s*"([^"]+)"/);
  require_(match && match[1] === EXPECTED_BUNDLE_NAME, `AppScope bundleName 必须为 ${EXPECTED_BUNDLE_NAME}，实际: ${match ? match[1] : '解析失败'}`);

  ensureAppIcons();

  if (VERIFY_ONLY) return manifest;
  if (RUNTIME_SOURCE === '' && !isFile(RELEASE_ZIP)) {
    fail(
      `发行版归档缺失: ${RELEASE_ZIP}\n  请从 ../harmonypc-electron-versions/ 取得 v37.2.3-20260825.1-release.zip，或使用 --runtime-source <已解压 ohos_hap 目录>。`,
    );
  }
  if (RESOLVE_LIBCXX && !process.env.DEVECO_SDK_HOME) {
    fail('DEVECO_SDK_HOME 未设置，无法注入 libc++_shared.so（可用 --no-libcxx 跳过）。');
  }
  return manifest;
}

/**
 * 包内图标的存在性门禁（FR-brand-010）。
 *
 * 自 2.0.26 起图标是**品牌物料生成物**（`scripts/lib/branding.mjs --generate-icons`，入库）。
 * 因此缺文件**不再静默生成占位图**，而是硬失败并要求先跑品牌化图标生成 —— 「不得静默产出
 * 无品牌 / 占位图标的包」。仅在首次导入取骨架时显式传 `--allow-placeholder-icons` 才回退生成。
 */
function ensureAppIcons() {
  const missing = PLACEHOLDER_ICONS.map(([relPath]) => relPath).filter((relPath) => !exists(join(PROJECT_ROOT, relPath)));
  if (missing.length === 0) return;
  if (!ALLOW_PLACEHOLDER_ICONS) {
    fail(
      `包内图标缺失（${missing.length} 个）：\n  ${missing.join('\n  ')}\n` +
        `  处置：先跑品牌化图标生成 node scripts/lib/branding.mjs --generate-icons` +
        `（物料来自 ../assets/logo-1024-with-bg.png 与 ../assets/logo.png）。\n` +
        `  首次导入取骨架时可显式传 --allow-placeholder-icons 回退为纯色占位图（绝不用于发布）。`,
    );
  }
  for (const [relPath, size] of PLACEHOLDER_ICONS) {
    const target = join(PROJECT_ROOT, relPath);
    if (exists(target)) continue;
    const bytes = writeSolidPng(target, size, PLACEHOLDER_ICON_RGB);
    warn(0, `生成占位图标 ${relPath}（${size}×${size}，纯色不透明，${bytes} B）—— 仅供首次导入取骨架，发布前必须替换为品牌图标`);
  }
}

const PLACEHOLDER_ICON_RGB = [31, 111, 235]; // #1F6FEB

// ------------------------------------------------------------------ 阶段 1

/**
 * 本次运行内已解析的运行时源码树。
 *
 * 阶段 1 与阶段 10 的 10.13 都要用同一份运行时资产作比对基准；不缓存的话阶段 10 会**再解析一次**，
 * 而在缓存目录结构未被 findShellRoot 命中时那一次解析会**重新解压整个发行版归档**（~370 MB zip /
 * 1.8 GB 目录树）——既慢，又会让 `--verify-only` 在没有归档的机器上抛 ENOENT。
 */
let cachedShellRoot = null;

function stage1LocateRuntime() {
  if (cachedShellRoot) return cachedShellRoot;
  banner(1, '取得运行时源码树');
  if (RUNTIME_SOURCE !== '') {
    const dir = resolve(RUNTIME_SOURCE);
    require_(isDir(dir), `--runtime-source 不是目录: ${dir}`);
    const shellRoot = findShellRoot(dir);
    require_(shellRoot, `--runtime-source 中未找到含 electron + web_engine 的 ohos_hap 目录: ${dir}`);
    log(1, `使用预解压运行时: ${shellRoot}`);
    cachedShellRoot = shellRoot;
    return cachedShellRoot;
  }

  const manifest = readJson(MANIFEST_PATH);
  const cacheRoot = join(CACHE_DIR, manifest.binaryVersion);
  const shellRoot = findShellRoot(cacheRoot);
  if (shellRoot) {
    log(1, `复用已解压运行时缓存: ${shellRoot}`);
    cachedShellRoot = shellRoot;
    return cachedShellRoot;
  }

  mkdirp(cacheRoot);
  log(1, `解压发行版归档: ${RELEASE_ZIP}（${(fileSize(RELEASE_ZIP) / 1024 / 1024).toFixed(1)} MB）`);
  const zipEntries = listZipEntries(RELEASE_ZIP);
  const innerName = zipEntries
    ? zipEntries.find((entry) => entry.endsWith('.tar.gz') && !entry.endsWith('/'))
    : null;
  if (!innerName) {
    // 无 unzip 时退化：用 tar（Windows bsdtar 支持 zip）整包解出，再找内层 tar.gz
    extractZip(RELEASE_ZIP, cacheRoot);
    const inner = findFiles(cacheRoot, (name) => name.endsWith('.tar.gz'))[0];
    require_(inner, `发行版归档中未找到内层 .tar.gz: ${RELEASE_ZIP}`);
    extractTarGz(inner, join(cacheRoot, 'extracted'));
  } else {
    extractZip(RELEASE_ZIP, cacheRoot, [innerName]);
    extractTarGz(join(cacheRoot, innerName), join(cacheRoot, 'extracted'));
  }
  const resolved = findShellRoot(join(cacheRoot, 'extracted'));
  require_(resolved, `解压后未找到 ohos_hap（electron + web_engine）: ${join(cacheRoot, 'extracted')}`);
  log(1, `运行时已解压: ${resolved}`);
  cachedShellRoot = resolved;
  return cachedShellRoot;
}

/** 在给定根下（最多 3 层）寻找同时含 electron/ 与 web_engine/ 的 ohos_hap 目录 */
function findShellRoot(root) {
  if (!isDir(root)) return null;
  // `extracted/libelectron/ohos_hap` 是发行版归档解压后的真实落点：不列入候选的话
  // 缓存复用分支永远不命中，每次运行都会重新解压归档。
  const candidates = [
    root,
    join(root, 'ohos_hap'),
    join(root, 'libelectron', 'ohos_hap'),
    join(root, 'extracted', 'ohos_hap'),
    join(root, 'extracted', 'libelectron', 'ohos_hap'),
  ];
  for (const candidate of candidates) {
    if (isDir(join(candidate, 'electron')) && isDir(join(candidate, 'web_engine'))) return candidate;
  }
  return null;
}

// ------------------------------------------------------------------ 阶段 2

function stage2CopyModules(shellRoot) {
  banner(2, '拷贝运行时模块 electron + web_engine');
  for (const name of ['electron', 'web_engine']) {
    const src = join(shellRoot, name);
    require_(isDir(src), `运行时模块缺失: ${src}`);
    const dest = join(PROJECT_ROOT, name);
    copyTree(src, dest, (sourcePath) => {
      const relPath = rel(src, sourcePath);
      if (relPath === '') return true;
      return !EXCLUDE_TOP.has(relPath.split('/')[0]);
    });
    log(2, `已拷贝 ${name}/ ← ${src}`);
  }
  for (const so of readJson(MANIFEST_PATH).so ?? []) {
    const p = join(PROJECT_ROOT, so.path);
    require_(isFile(p), `原生 SO 缺失: ${p}\n  发行版归档应包含 electron/libs/arm64-v8a/ 下的捆绑 SO。`);
  }
}

// ------------------------------------------------------------------ 阶段 3

function stage3Prune() {
  banner(3, '剪裁运行时中本应用不需要的文件');
  for (const relPath of PRUNE_FILES) {
    const p = join(PROJECT_ROOT, relPath);
    require_(exists(p), `待剪裁文件缺失（上游外壳结构可能已变化，请重新评估 PRUNE_FILES）: ${relPath}`);
    removeTree(p);
    log(3, `已删除 ${relPath}`);
  }
}

// ------------------------------------------------------------------ 阶段 4

function stage4RestoreAppFiles() {
  banner(4, '恢复本应用 App 主进程文件');
  for (const [from, to] of APP_FILES) {
    const dest = join(PROJECT_ROOT, to);
    copyOne(join(PROJECT_ROOT, from), dest);
    // 语法门禁：主进程脚本一旦解析失败，require 即抛错、main.js 整段不执行 ——
    // 真机表现是「白屏 + 零日志」（console.error 也不入 hilog），极难定位，故在此 fail-visible 拦住。
    if (dest.endsWith('.js')) {
      const checked = run(process.execPath, ['--check', dest], { optional: true });
      require_(checked.status === 0, `App 主进程脚本语法错误: ${to}\n${(checked.stderr || checked.stdout || '').trim()}`);
    }
    log(4, `${from} → ${to}`);
  }
  const skills = join(PROJECT_ROOT, 'skills');
  if (isDir(skills)) {
    copyTree(skills, join(PROJECT_ROOT, APP_RESFILE_DIR, 'skills'));
    log(4, `skills/ → ${APP_RESFILE_DIR}/skills`);
  }
}

// ------------------------------------------------------------------ 阶段 5

function stage5Overlays() {
  banner(5, '应用 runtime-overlays 白名单回盖');
  for (const relPath of OVERLAY_FILES) {
    const src = join(PROJECT_ROOT, 'runtime-overlays', relPath);
    const dest = join(PROJECT_ROOT, relPath);
    require_(isFile(src), `overlay 源缺失（应用定制丢失）: runtime-overlays/${relPath}`);
    require_(isFile(dest), `overlay 目标缺失（运行时外壳结构可能已升级）: ${relPath}`);
    copyOne(src, dest);
    log(5, `回盖 ${relPath}`);
  }
}

// ------------------------------------------------------------------ 阶段 6

function stage6Rewrites() {
  banner(6, '声明式文本改写（除开关 / 生产禁用项）');
  for (const rule of REWRITE_RULES) {
    const p = join(PROJECT_ROOT, rule.file);
    require_(isFile(p), `待改写文件缺失（外壳结构可能已变化）: ${rule.file}`);
    const original = readText(p);
    const hits = original.split(rule.from).length - 1;
    // 幂等：命中 expectedHits ⇒ 正常改写；命中 0 ⇒ 说明上一次已经改过（本脚本要能重复执行，
    // 例如「清理中间文件后重跑流水线」），此时**跳过而不是失败** —— 但必须确认目标形态已达成，
    // 否则说明规则已失效（from 与 to 都不在文件里）。
    if (hits === 0) {
      require_(
        rule.to === '' || original.includes(rule.to),
        `${rule.file} 中既没有 "${rule.from}" 也没有 "${rule.to}"（命中 0 次）：规则已失效，必须重新评估。`,
      );
      log(6, `${rule.file}: ${rule.description}（已改写，跳过）`);
      continue;
    }
    require_(
      hits === rule.expectedHits,
      `${rule.file} 中 "${rule.from}" 命中 ${hits} 次，预期 ${rule.expectedHits} 次（${rule.description}）；上游外壳升级后必须重新评估。`,
    );
    const rewritten = original.split(rule.from).join(rule.to);
    require_(!rewritten.includes(rule.from), `${rule.file} 改写后仍残留 "${rule.from}"`);
    writeText(p, rewritten);
    log(6, `${rule.file}: ${rule.description}（${hits} 处）`);
  }
}

// ------------------------------------------------------------------ 阶段 7

function stage7RewriteBundleName(manifest) {
  banner(7, 'bundleName 字面量替换');
  const { from, adapters, expectedHitsPerFile = 1 } = manifest.bundleNameRewrite;
  for (const relPath of adapters) {
    const p = join(PROJECT_ROOT, relPath);
    require_(isFile(p), `adapter 缺失（外壳结构可能已升级）: ${relPath}`);
    const original = readText(p);
    const hits = original.split(from).length - 1;
    require_(
      hits === expectedHitsPerFile,
      `${relPath} 中通用字面量 "${from}" 命中 ${hits} 次，预期 ${expectedHitsPerFile} 次；外壳升级后必须重新评估 bundleName 定制。`,
    );
    const rewritten = original.split(from).join(EXPECTED_BUNDLE_NAME);
    require_(!rewritten.includes(from), `${relPath} 替换后仍残留通用字面量 "${from}"`);
    writeText(p, rewritten);
    log(7, `${relPath}: ${from} → ${EXPECTED_BUNDLE_NAME}（${hits} 处）`);
  }
}

// ------------------------------------------------------------------ 阶段 8

function stage8PurgeAppDir() {
  banner(8, '清理 resfile/resources/app 中的应用无关文件');
  const dir = join(PROJECT_ROOT, APP_RESFILE_DIR);
  mkdirp(dir);
  for (const entry of listDir(dir)) {
    if (APP_KEEP.has(entry)) continue;
    removeTree(join(dir, entry));
    log(8, `清理 ${entry}`);
  }
}

// ------------------------------------------------------------------ 阶段 9

function stage9InjectNatives(manifest) {
  if (RESOLVE_LIBCXX) {
    banner(9, '注入 libc++_shared.so');
    const sdkRoot = process.env.DEVECO_SDK_HOME;
    const candidates = [
      join(sdkRoot, 'default', 'openharmony', 'native', 'llvm', 'lib', 'aarch64-linux-ohos', 'libc++_shared.so'),
      join(sdkRoot, 'default', 'openharmony', 'native', 'llvm', 'lib', 'aarch64-linux-ohos', 'libc++_shared.so'),
    ];
    const libcxx = candidates.find((p) => isFile(p));
    require_(libcxx, `SDK 中的 libc++_shared.so 未找到（DEVECO_SDK_HOME=${sdkRoot}）`);
    const dest = join(PROJECT_ROOT, manifest.libcxx?.path ?? 'electron/libs/arm64-v8a/libc++_shared.so');
    copyOne(libcxx, dest);
    log(9, `libc++_shared.so → ${manifest.libcxx?.path ?? 'electron/libs/arm64-v8a/libc++_shared.so'}（${md5File(dest)}）`);
  }

  // better_sqlite3.node 双份投放（工程规划 §3.6 / spec 005 FR-005-009、spec 012 FR-012-012）：
  //   ① <runtimeDir>/node_modules/better-sqlite3/（JS 包 + .node）：由 scripts/collect-opencode.mjs 物化；
  //   ② 本阶段额外投放同名「dlopen 锚点」到 electron/libs/arm64-v8a/。
  // 为什么必须有 ②：HarmonyOS 链接器命名空间（default/ndk/moduleNs_default）访问不到 app 的 files/ 沙箱，
  //   真机实测从 userData（el2）dlopen 同样失败（MUSL-LDSO: check ns accessible failed，文件在但加载被拒）；
  //   只有 HAP 的 libs/arm64-v8a（部署为 /data/storage/el1/bundle/libs/arm64/）可达 —— node_binding.cc 会先把
  //   请求的 .node 按同名重试到该目录，因此同名锚点即可让 el2 包内的 require 命中。dsh 0.1.5 上架版本同此布局。
  if (RESOLVE_LIBCXX) {
    const anchorDest = join(PROJECT_ROOT, 'electron/libs/arm64-v8a/better_sqlite3.node');
    const binding = locateBetterSqlite3Binding();
    mkdirp(join(PROJECT_ROOT, 'electron/libs/arm64-v8a'));
    copyOne(binding, anchorDest);
    require_(
      sha256File(anchorDest) === sha256File(binding),
      `dlopen 锚点投放校验失败（sha256 不一致）: ${rel(PROJECT_ROOT, anchorDest)}`,
    );
    log(
      9,
      `dlopen 锚点 better_sqlite3.node → electron/libs/arm64-v8a/（${(fileSize(anchorDest) / 1024 / 1024).toFixed(1)} MB，sha256=${sha256File(anchorDest).slice(0, 16)}…）`,
    );
  }
}

/**
 * 定位 aarch64-ohos 的 better_sqlite3.node。
 * 与 scripts/collect-opencode.mjs 同一来源（v37 编译指导归档）与同一缓存目录，保证两份字节一致。
 */
function locateBetterSqlite3Binding() {
  const candidates = findFiles(SQLITE_GUIDE_DIR, (name) => name.endsWith('.tar.gz'));
  require_(
    candidates.length > 0,
    `未找到 better-sqlite3 归档（查找目录: ${SQLITE_GUIDE_DIR}）\n  设备无 node:sqlite binding，缺它则服务端起不来（工程规划 §3.6）。`,
  );
  const extractDir = join(PROJECT_ROOT, '.cache', 'better-sqlite3');
  const binding = join(extractDir, 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node');
  if (!isFile(binding)) {
    mkdirp(extractDir);
    runOrFail('tar', ['-xzf', candidates[0], '-C', extractDir]);
  }
  require_(isFile(binding), `better-sqlite3 归档中缺少原生模块: ${binding}`);
  require_(isElfAarch64(binding), `better_sqlite3.node 不是 aarch64 ELF（ABI 必须与 Electron 37 一致）: ${binding}`);
  return binding;
}

// ------------------------------------------------------------------ 阶段 10

function stage10Guards(manifest) {
  banner(10, '结构化守卫');
  let failed = 0;
  const guard = (ok, message) => {
    if (ok) log(10, `PASS ${message}`);
    else {
      console.error(`[oc-desktop][10] FAIL ${message}`);
      failed += 1;
    }
  };

  // 10.1 捆绑 SO 存在且哈希与清单一致
  for (const so of manifest.so ?? []) {
    const p = join(PROJECT_ROOT, so.path);
    if (!isFile(p)) {
      guard(false, `SO 存在 ${so.path}`);
      continue;
    }
    guard(md5File(p) === String(so.md5).toUpperCase(), `SO 哈希 ${so.path}`);
  }

  // 10.2 外壳标记（确认是最新 ArkTS 外壳）
  for (const marker of manifest.shellMarkers ?? []) {
    const p = join(PROJECT_ROOT, marker.file);
    guard(isFile(p) && readText(p).includes(marker.symbol), `外壳标记 ${marker.symbol} @ ${marker.file}`);
  }

  // 10.3 barrel 导出
  const barrelPath = join(PROJECT_ROOT, manifest.barrelFile ?? 'web_engine/Index.ets');
  if (isFile(barrelPath)) {
    const barrel = readText(barrelPath);
    for (const name of manifest.barrelExports ?? []) guard(barrel.includes(name), `barrel 导出 ${name}`);
  } else {
    guard(false, `barrel 存在 ${manifest.barrelFile ?? 'web_engine/Index.ets'}`);
  }

  // 10.4 应用身份
  const appJson5 = readText(join(PROJECT_ROOT, 'AppScope', 'app.json5'));
  guard(appJson5.includes(`"${EXPECTED_BUNDLE_NAME}"`), `AppScope bundleName = ${EXPECTED_BUNDLE_NAME}`);
  guard(appJson5.includes('$string:app_name'), 'AppScope label 走资源引用（显示名由三套 string.json 承载）');
  const appLabelPath = join(PROJECT_ROOT, 'AppScope', 'resources', 'base', 'element', 'string.json');
  guard(isFile(appLabelPath) && readText(appLabelPath).includes(EXPECTED_APP_LABEL), `AppScope 显示名 = ${EXPECTED_APP_LABEL}`);
  const generic = manifest.bundleNameRewrite?.from ?? 'com.huawei.ohos_electron';
  for (const relPath of manifest.bundleNameRewrite?.adapters ?? []) {
    const p = join(PROJECT_ROOT, relPath);
    guard(isFile(p) && !readText(p).includes(generic), `adapter 无通用字面量残留 ${relPath.split('/').pop()}`);
  }

  // 10.5 三套 EntryAbility label（显示名落点，漏改会导致桌面名不变）
  for (const locale of ['base', 'en_US', 'zh_CN']) {
    const p = join(PROJECT_ROOT, 'electron', 'src', 'main', 'resources', locale, 'element', 'string.json');
    guard(isFile(p) && readText(p).includes(EXPECTED_APP_LABEL), `EntryAbility_label(${locale}) = ${EXPECTED_APP_LABEL}`);
  }

  // 10.6 权限集断言（对齐 docs/ACL申请清单.md 的 6 项 + 本工程自用开放权限）
  const webEngineManifest = join(PROJECT_ROOT, 'web_engine', 'src', 'main', 'module.json5');
  if (isFile(webEngineManifest)) {
    const text = readText(webEngineManifest);
    for (const permission of FORBIDDEN_PERMISSIONS) {
      guard(!text.includes(permission), `未声明受限权限 ${permission}`);
    }
    for (const permission of REQUIRED_PERMISSIONS) {
      guard(text.includes(permission), `已声明权限 ${permission}`);
    }
    // 10.6b `user_grant` 项必须带 reason + usedScene（specs/006 FR-006-012 / FR-006-026）
    // 匹配口径：先按 `"name": "<perm>"` 定位条目，再取到**该条目自身的 `}`** 为止（`[\s\S]*?` 在
    // 第一个 `}` 处停止 ⇒ 恰好覆盖嵌套的 `usedScene` 对象），最后断言该片段含 `usedScene`。
    // 不用「N 字符窗口」——那样会被**相邻条目**的 usedScene 误判为通过（负向用例已实测）。
    for (const permission of USER_GRANT_PERMISSIONS) {
      const entry = text.match(
        new RegExp(`\\{\\s*"name"\\s*:\\s*"${permission.replace(/\./g, '\\.')}"[\\s\\S]*?\\}`),
      );
      guard(Boolean(entry) && entry[0].includes('usedScene'), `user_grant 权限带 usedScene ${permission}`);
    }
    const jitHits = text.split(JIT_PERMISSION).length - 1;
    guard(jitHits === 2, `JIT 权限出现在 requestPermissions + definePermissions 两处（实际 ${jitHits} 处）`);
  } else {
    guard(false, `web_engine module.json5 存在 ${webEngineManifest}`);
  }

  // 10.7 overlay 命中（源/目标一致）
  for (const relPath of OVERLAY_FILES) {
    const src = join(PROJECT_ROOT, 'runtime-overlays', relPath);
    const dest = join(PROJECT_ROOT, relPath);
    guard(isFile(src) && isFile(dest) && md5File(src) === md5File(dest), `overlay 命中 ${relPath}`);
  }

  // 10.8 剪裁结果
  for (const relPath of PRUNE_FILES) guard(!exists(join(PROJECT_ROOT, relPath)), `已剪裁 ${relPath}`);

  // 10.9 生产调试开关
  for (const rule of REWRITE_RULES) {
    const p = join(PROJECT_ROOT, rule.file);
    guard(isFile(p) && !readText(p).includes(rule.from), `已移除 ${rule.from}（${rule.file}）`);
  }

  // 10.10 resfile/app 残留与必备文件
  const appDir = join(PROJECT_ROOT, APP_RESFILE_DIR);
  const leftovers = listDir(appDir).filter((entry) => !APP_KEEP.has(entry));
  guard(leftovers.length === 0, `resfile/app 无应用无关残留${leftovers.length ? `（发现: ${leftovers.join(', ')}）` : ''}`);
  for (const [from, to] of APP_FILES) {
    const p = join(PROJECT_ROOT, to);
    const label = to.replace(`${APP_RESFILE_DIR}/`, '');
    guard(isFile(p), `App 文件就位 ${label}`);
    // 与 `src-main/` 源文件**逐字节一致**：`main.js` 等要同时存在于两处（源 + 包内资源），
    // 只校验「存在」会漏掉「改了源忘了同步镜像」——那时守卫全绿、打出的包却仍是旧逻辑。
    // `build-debug.ps1` 不跑本脚本，所以这条守卫是这条不变量的唯一自动兜底。
    const src = join(PROJECT_ROOT, from);
    guard(
      isFile(src) && isFile(p) && md5File(src) === md5File(p),
      `App 文件与 src-main 源一致 ${label}（${from}）`,
    );
  }

  // 10.11 原生注入：libc++ 与 better_sqlite3.node 的 dlopen 锚点均由本脚本投放到 libs/arm64-v8a/
  //（better_sqlite3 的 JS 包 + .node 另由 collect-opencode.mjs 阶段 ② 随运行时时序产物物化）
  const libcxxPath = join(PROJECT_ROOT, manifest.libcxx?.path ?? 'electron/libs/arm64-v8a/libc++_shared.so');
  guard(isFile(libcxxPath), `libc++_shared.so 就位（${manifest.libcxx?.path ?? 'electron/libs/arm64-v8a/libc++_shared.so'}）`);

  // 10.11b dlopen 锚点：libs/ 下的同名 better_sqlite3.node（工程规划 §3.6 硬约束；缺失即真机白屏）
  const sqliteAnchor = join(PROJECT_ROOT, 'electron/libs/arm64-v8a/better_sqlite3.node');
  guard(
    isFile(sqliteAnchor) && isElfAarch64(sqliteAnchor),
    'dlopen 锚点就位 electron/libs/arm64-v8a/better_sqlite3.node',
  );

  // 10.12 图标合规（FR-brand-009：应用级图标不带 Alpha；window_icon 允许透明）
  for (const [relPath, size] of PLACEHOLDER_ICONS) {
    const p = join(PROJECT_ROOT, relPath);
    if (!isFile(p)) {
      guard(false, `图标存在 ${relPath}`);
      continue;
    }
    const header = readPngHeader(p);
    if (!header) {
      guard(false, `图标是可解析 PNG ${relPath}`);
      continue;
    }
    const hasAlpha = header.colorType === 4 || header.colorType === 6;
    if (ALPHA_ALLOWED_ICONS.has(relPath)) {
      log(10, `图标允许 Alpha（窗口图标）${relPath}（colorType=${header.colorType}）`);
    } else {
      guard(!hasAlpha, `图标不含 Alpha ${relPath}（colorType=${header.colorType}）`);
    }
    guard(header.width === header.height && header.width >= 32, `图标为正方形 ${relPath}（${header.width}×${header.height}）`);
    if (size !== 32) guard(header.width === size, `图标边长 ${size} ${relPath}（实际 ${header.width}）`);
  }

  // 10.13 resfile 二进制必须与运行时发行版**逐字节一致**
  // （真机事故 2026-10-14：`icudtl.dat` / `resources.pak` / `chrome_*.pak` 被当成文本做了
  //   CRLF→LF 归一化，各少了 51 / 120 / 197 / 201 字节 —— 逐字节核验被删掉的全是 CRLF 对。
  //   后果分两层且都只表现为真机白屏/闪退：ICU 数据损坏
  //   （`RangeError: Internal error. Icu error.`，服务端产物 import 即失败）与 Chromium 数据包
  //   损坏（`Data pack file corruption: Entry #N past end` → 加载 resources.pak 失败 →
  //   建窗时 CHECK 失败 → `Signal:SIGTRAP(TRAP_BRKPT)` 崩溃）。
  //   本守卫是这条约束的唯一自动兜底：`.gitattributes` 只防未来复发，防不住已有损坏。）
  {
    const resfileRel = 'web_engine/src/main/resources/resfile';
    const projectResfileDir = join(PROJECT_ROOT, resfileRel);
    // 运行时源码树不可得时**明确失败**而不是抛未捕获的 ENOENT（--verify-only 路径没有归档时
    // 曾会直接崩在 fileSize 上，看不出是守卫没跑还是守卫失败）。
    let resfileSrcDir = null;
    try {
      resfileSrcDir = join(stage1LocateRuntime(), resfileRel);
    } catch (error) {
      guard(false, `取得运行时源码树以比对 ${resfileRel}（${error && error.message}）`);
    }
    if (resfileSrcDir !== null && !isDir(resfileSrcDir)) {
      guard(false, `运行时 resfile 目录存在 ${resfileRel}`);
      resfileSrcDir = null;
    }
    if (resfileSrcDir !== null) {
      const guarded = new Set();
      for (const file of findFiles(resfileSrcDir, () => true)) {
        const relPath = rel(resfileSrcDir, file);
        // 只跳过 `resources/app/`（由本工程阶段 4/8 投放，已由 10.10 与 `src-main` 逐字节比对）；
        // 若宽到整个 `resources/`，上游一旦新增 `resources/app.asar` 之类就会被**静默漏检**。
        if (relPath.startsWith('resources/app/')) continue;
        guarded.add(relPath);
        const dest = join(projectResfileDir, relPath);
        guard(isFile(dest) && md5File(dest) === md5File(file), `resfile 运行时资产与发行版一致 ${relPath}`);
      }
      // 反向检查：工程侧多出的文件同样要报错（迭代是源码驱动的，多出来的文件否则永远不可见）。
      for (const file of findFiles(projectResfileDir, () => true)) {
        const relPath = rel(projectResfileDir, file);
        if (relPath.startsWith('resources/app/')) continue;
        guard(guarded.has(relPath), `resfile 无发行版之外的额外文件 ${relPath}`);
      }
    }
  }

  if (failed > 0) fail(`一致性守卫 ${failed} 项未通过，已中止（旧壳 / 错 SO / 定制丢失 / 权限越界 / 合规风险）。`);
  log(10, '全部守卫通过');
}

/** 读取 ELF 头校验 e_machine = 0xB7（AArch64） */
function isElfAarch64(p) {
  const buffer = readFileHead(p, 20);
  if (buffer.length < 20) return false;
  if (buffer[0] !== 0x7f || buffer[1] !== 0x45 || buffer[2] !== 0x4c || buffer[3] !== 0x46) return false;
  return buffer.readUInt16LE(18) === 0xb7;
}

// ------------------------------------------------------------------ main

function main() {
  require_(hasCommand('tar'), 'tar 不可用：无法解压运行时归档');
  const manifest = stage0();
  if (!VERIFY_ONLY) {
    const shellRoot = stage1LocateRuntime();
    stage2CopyModules(shellRoot);
    stage3Prune();
    stage4RestoreAppFiles();
    if (!EXTRACT_ONLY) {
      stage5Overlays();
      stage6Rewrites();
    }
    stage7RewriteBundleName(manifest);
    stage8PurgeAppDir();
    stage9InjectNatives(manifest);
  }
  // --extract-only 用于首次导入与 overlay 取材：不跑守卫（overlay 尚未落地时必然失败）
  if (!EXTRACT_ONLY) stage10Guards(manifest);
  console.log(
    `[oc-desktop] 完成：运行时已就绪（electron + web_engine${EXTRACT_ONLY ? '，未应用 overlay' : ''}${VERIFY_ONLY ? '，仅守卫' : ''}）`,
  );
}

main();
