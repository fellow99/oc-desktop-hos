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
const EXPECTED_BUNDLE_NAME = 'rg.fellow99.oc.OCDesktop';
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
]);

/** 权限断言：必须**不得**出现的受限/上架障碍权限（工程规划 §8.3） */
const FORBIDDEN_PERMISSIONS = [
  'ohos.permission.READ_WRITE_DESKTOP_DIRECTORY',
  'ohos.permission.PRINT',
  'ohos.permission.CUSTOM_SANDBOX',
  'ohos.permission.RUN_ANY_CODE',
  'ohos.permission.LOAD_INDEPENDENT_LIBRARY',
  'ohos.permission.ALLOW_EXTERNAL_NATIVE_CODE',
];

/** 权限断言：必须**存在**的权限 */
const REQUIRED_PERMISSIONS = ['ohos.permission.INTERNET'];

/** JIT 权限（V8 必需，须同时出现在 requestPermissions 与 definePermissions） */
const JIT_PERMISSION = 'ohos.permission.kernel.ALLOW_WRITABLE_CODE_MEMORY';

/** AppScope 占位图标（纯色不透明，上架合规 §8.5 G2）；仅当文件缺失时生成 */
const PLACEHOLDER_ICONS = [
  ['AppScope/resources/base/media/app_icon.png', 1024],
  ['AppScope/resources/base/media/icon.png', 512],
  ['AppScope/resources/base/media/startIcon.png', 512],
  ['AppScope/resources/base/media/product_logo_32.png', 32],
  ['AppScope/resources/base/media/window_icon.png', 512],
];
const PLACEHOLDER_ICON_RGB = [31, 111, 235]; // #1F6FEB

// ------------------------------------------------------------------ 参数

const args = parseArgs();
const EXTRACT_ONLY = args.has('extract-only');
const VERIFY_ONLY = args.has('verify-only');
const RESOLVE_LIBCXX = !args.has('no-libcxx') && !VERIFY_ONLY;
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

/** 占位图标：仅缺失时生成，避免把二进制资源塞进仓库；合规要求纯色不透明（无 Alpha） */
function ensureAppIcons() {
  for (const [relPath, size] of PLACEHOLDER_ICONS) {
    const target = join(PROJECT_ROOT, relPath);
    if (exists(target)) continue;
    const bytes = writeSolidPng(target, size, PLACEHOLDER_ICON_BYTES());
    log(0, `生成占位图标 ${relPath}（${size}×${size}，纯色不透明，${bytes} B）—— 发布前必须替换为产品图标`);
  }
}

function PLACEHOLDER_ICON_BYTES() {
  return PLACEHOLDER_ICON_RGB;
}

// ------------------------------------------------------------------ 阶段 1

function stage1LocateRuntime() {
  banner(1, '取得运行时源码树');
  if (RUNTIME_SOURCE !== '') {
    const dir = resolve(RUNTIME_SOURCE);
    require_(isDir(dir), `--runtime-source 不是目录: ${dir}`);
    const shellRoot = findShellRoot(dir);
    require_(shellRoot, `--runtime-source 中未找到含 electron + web_engine 的 ohos_hap 目录: ${dir}`);
    log(1, `使用预解压运行时: ${shellRoot}`);
    return shellRoot;
  }

  const manifest = readJson(MANIFEST_PATH);
  const cacheRoot = join(CACHE_DIR, manifest.binaryVersion);
  const shellRoot = findShellRoot(cacheRoot);
  if (shellRoot) {
    log(1, `复用已解压运行时缓存: ${shellRoot}`);
    return shellRoot;
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
  return resolved;
}

/** 在给定根下（最多 3 层）寻找同时含 electron/ 与 web_engine/ 的 ohos_hap 目录 */
function findShellRoot(root) {
  if (!isDir(root)) return null;
  const candidates = [root, join(root, 'ohos_hap'), join(root, 'libelectron', 'ohos_hap')];
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
    copyOne(join(PROJECT_ROOT, from), join(PROJECT_ROOT, to));
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

  // better_sqlite3.node 不在这里注入：它随运行时时序产物一起分发（<runtimeDir>/node_modules/better-sqlite3/
  // 由 scripts/collect-opencode.mjs 物化）。原因是设备侧 .node 不能从 resfile 只读目录 dlopen，
  // 而运行时时序产物解压到可写的 userData 沙箱，dsh 0.1.5 上架版本即用该布局（工程规划 §3.6）。
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

  // 10.6 权限集断言（受限权限最小化，工程规划 §8）
  const webEngineManifest = join(PROJECT_ROOT, 'web_engine', 'src', 'main', 'module.json5');
  if (isFile(webEngineManifest)) {
    const text = readText(webEngineManifest);
    for (const permission of FORBIDDEN_PERMISSIONS) {
      guard(!text.includes(permission), `未声明受限权限 ${permission}`);
    }
    for (const permission of REQUIRED_PERMISSIONS) {
      guard(text.includes(permission), `已声明开放权限 ${permission}`);
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
  for (const [, to] of APP_FILES) {
    const p = join(PROJECT_ROOT, to);
    guard(isFile(p), `App 文件就位 ${to.replace(`${APP_RESFILE_DIR}/`, '')}`);
  }

  // 10.11 原生注入：libc++ 由本脚本注入；better_sqlite3.node 随运行时时序产物分发
  //（collect-opencode.mjs 阶段 ② 负责物化与守卫，故此处不检查 libs/ 下的 .node）
  const libcxxPath = join(PROJECT_ROOT, manifest.libcxx?.path ?? 'electron/libs/arm64-v8a/libc++_shared.so');
  guard(isFile(libcxxPath), `libc++_shared.so 就位（${manifest.libcxx?.path ?? 'electron/libs/arm64-v8a/libc++_shared.so'}）`);

  // 10.12 图标合规（纯色不透明；含 Alpha 会被应用市场驳回）
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
    guard(!hasAlpha, `图标不含 Alpha ${relPath}（colorType=${header.colorType}）`);
    guard(header.width === header.height && header.width >= 32, `图标为正方形 ${relPath}（${header.width}×${header.height}）`);
    if (size === 1024) guard(header.width === 1024, `主图标为 1024×1024 ${relPath}`);
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
