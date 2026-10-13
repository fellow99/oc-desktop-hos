#!/usr/bin/env node
/**
 * collect-opencode.mjs —— 阶段 ②（后半）：把上游 Node 产物物化成 HAP 内的单文件归档。
 *
 * 输入：opencode 的 dist-node 产物（opencode.mjs + assets/**，含内嵌 UI 的 app-archive.bin）
 * 输出：<工程>/web_engine/src/main/resources/resfile/resources/app/opencode-dist.tar.gz
 *
 * 为什么必须打包成单文件（工程规划 §6.3）：
 *   ① 数万小文件直接进 HAP 会卡死 hvigor，或令 Electron 启动时 CHECK 崩溃（真机实测）；
 *   ② 运行时解压到可写的 userData 沙箱后，.node 才能被 dlopen（resfile 只读目录不行）。
 *
 * 另外物化 better-sqlite3（JS + aarch64-ohos/.node）：设备上 node:sqlite 无 binding，
 * sqlite 的 ohos 变体走 better-sqlite3（工程规划 §3.6）。
 *
 * 用法：
 *   node scripts/collect-opencode.mjs                      使用默认产物目录
 *   node scripts/collect-opencode.mjs --product <dir>      指定 dist-node 目录
 *   node scripts/collect-opencode.mjs --no-app-copy        只产出归档，不投放进 resfile
 *   node scripts/collect-opencode.mjs --assets <dir>        指定品牌物料目录（默认父工程 ../assets）
 */
import { readFileSync, writeFileSync } from 'node:fs';
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
  isDir,
  isFile,
  listDir,
  log,
  mkdirp,
  parseArgs,
  readFileHead,
  readPngHeader,
  readText,
  rel,
  removeTree,
  require_,
  runOrFail,
  sha256File,
  warn,
} from './lib/util.mjs';
import { BRAND_NAME, DEFAULT_MATERIAL_DIR, requireBranded, transformArchive } from './lib/branding.mjs';

const PROJECT_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const WORKSPACE_ROOT = resolve(PROJECT_ROOT, '..');
const VERSIONS_DIR = join(WORKSPACE_ROOT, 'harmonypc-electron-versions');
const SQLITE_GUIDE_DIR = join(VERSIONS_DIR, 'better-sqlite3编译指导（Electron37）');
const CACHE_DIR = join(PROJECT_ROOT, '.cache');
const APP_RESFILE_DIR = join(PROJECT_ROOT, 'web_engine', 'src', 'main', 'resources', 'resfile', 'resources', 'app');

const args = parseArgs();
const PRODUCT_DIR = resolve(args.get('product', join(WORKSPACE_ROOT, 'opencode', 'packages', 'cli', 'dist-node')));
const OUT_DIR = resolve(args.get('out', join(PROJECT_ROOT, '.stage')));
const STAGE_DIR = join(OUT_DIR, 'dist-node');
const ARCHIVE = join(OUT_DIR, 'opencode-dist.tar.gz');
const NO_APP_COPY = args.has('no-app-copy');

/** 归档内不得出现的原生件（非 arm64-linux / 设备不可用），剪裁以压体积并避免误加载 */
const PRUNE_PATTERNS = [
  /^@lydell\/node-pty-(darwin|win32)-/,
  /^@parcel\/watcher-(darwin|win32|linux-x64)/,
  /^@ff-labs\/fff-bin-(darwin|win32|linux-x64)/,
  /^@yuuang\/ffi-rs-(darwin|win32|linux-x64)/,
  /^opencode-pty\//, // 持久终端助手 ELF：设备侧 PTY 平台级不可用，不随包
];

function main() {
  banner('collect-opencode', '物化 opencode Node 产物');
  require_(isDir(PRODUCT_DIR), `产物目录缺失: ${PRODUCT_DIR}\n  请先执行: bun run --cwd packages/cli script/build-node.ts --target=linux-arm64 --bundle-only`);
  const entry = join(PRODUCT_DIR, 'opencode.mjs');
  require_(isFile(entry), `产物入口缺失: ${entry}`);
  const appArchive = join(PRODUCT_DIR, 'assets', 'app-archive.bin');
  require_(
    isFile(appArchive),
    `内嵌 UI 归档缺失: ${appArchive}\n  说明产物构建时未包含 Web UI（工程规划 §2.3：根路径会 404）。`,
  );
  log('collect-opencode', `entry=${(fileSize(entry) / 1024 / 1024).toFixed(1)} MB assets/app-archive.bin=${(fileSize(appArchive) / 1024 / 1024).toFixed(2)} MB`);

  // 1) 暂存产物
  removeTree(STAGE_DIR);
  mkdirp(OUT_DIR);
  copyTree(PRODUCT_DIR, STAGE_DIR);
  log('collect-opencode', `已暂存产物 → ${rel(PROJECT_ROOT, STAGE_DIR)}`);

  // 2) Web UI 品牌化（OpenCode → OC Desktop）：只改**本工程交付产物**，因此不需要上游补丁
  brandAppArchive(join(STAGE_DIR, 'assets', 'app-archive.bin'));

  // 3) better-sqlite3（JS + aarch64/.node）
  stageBetterSqlite3();

  // 4) 剪裁非 arm64 原生件
  pruneNative();

  // 5) 打包：以 dist-node/ 为顶层前缀（运行时解压时剥离）
  removeTree(ARCHIVE);
  runOrFail('tar', ['-czf', ARCHIVE, '--format=ustar', '-C', OUT_DIR, 'dist-node']);
  const marker = sha256File(ARCHIVE);
  log('collect-opencode', `归档完成 ${rel(PROJECT_ROOT, ARCHIVE)}（${(fileSize(ARCHIVE) / 1024 / 1024).toFixed(1)} MB, sha256=${marker.slice(0, 16)}…）`);

  // 6) 校验归档内容（fail-visible）
  verifyArchive();

  // 7) 投放进 resfile
  if (!NO_APP_COPY) {
    mkdirp(APP_RESFILE_DIR);
    copyOne(ARCHIVE, join(APP_RESFILE_DIR, 'opencode-dist.tar.gz'));
    log('collect-opencode', `已投放 → ${rel(PROJECT_ROOT, join(APP_RESFILE_DIR, 'opencode-dist.tar.gz'))}`);
  }
  console.log(`[oc-desktop] 完成：opencode 产物就绪（marker=sha256:${marker.slice(0, 12)}…）`);
}

/**
 * 品牌化内嵌 Web UI 归档（原地重写 app-archive.bin）。
 * 物料缺失/不可解析、保护清单被改写、品牌引用点漂移 → 一律硬失败（FR-brand-010 / R2）。
 */
function brandAppArchive(archivePath) {
  require_(isFile(archivePath), `内嵌 UI 归档缺失: ${archivePath}`);
  const materialDir = resolve(args.get('assets', DEFAULT_MATERIAL_DIR));
  const before = readFileSync(archivePath);
  const { bytes, stats } = transformArchive(before, { materialDir, label: rel(PROJECT_ROOT, archivePath) });
  writeFileSync(archivePath, bytes);
  log(
    'collect-opencode',
    `Web UI 品牌化 → ${BRAND_NAME}：条目 ${stats.entries} 不变，文本资产 ${stats.textAssets}，` +
      `品牌替换 ${stats.brandReplacements} 处，图标 ${stats.iconAssets.length} 个，内联 Logo ${stats.logoAssets.length} 处；` +
      `${(before.length / 1024 / 1024).toFixed(2)} → ${(bytes.length / 1024 / 1024).toFixed(2)} MB`,
  );
  const report = requireBranded(bytes, { materialDir, label: rel(PROJECT_ROOT, archivePath), scope: 'collect-opencode' });
  const failed = report.checks.filter((check) => !check.ok);
  require_(report.ok, `Web UI 品牌化断言失败 ${failed.length} 项: ${failed.map((check) => check.name).join(' / ')}`);
  log('collect-opencode', `品牌化断言全绿（${report.checks.length} 项）`);
}

function stageBetterSqlite3() {
  const candidates = findFiles(SQLITE_GUIDE_DIR, (name) => name.endsWith('.tar.gz'));
  require_(
    candidates.length > 0,
    `未找到 better-sqlite3 归档（查找目录: ${SQLITE_GUIDE_DIR}）\n  设备无 node:sqlite binding，缺它则无法持久化会话（工程规划 §3.6）。`,
  );
  const extractDir = join(CACHE_DIR, 'better-sqlite3');
  const packageDir = join(extractDir, 'better-sqlite3');
  if (!isDir(join(packageDir, 'build', 'Release'))) {
    mkdirp(extractDir);
    runOrFail('tar', ['-xzf', candidates[0], '-C', extractDir]);
  }
  const binding = join(packageDir, 'build', 'Release', 'better_sqlite3.node');
  require_(isFile(binding), `better-sqlite3 归档中缺少原生模块: ${binding}`);
  require_(isElfAarch64(binding), `better_sqlite3.node 不是 aarch64 ELF（ABI 必须与 Electron 37 / v138 一致）: ${binding}`);
  const target = join(STAGE_DIR, 'node_modules', 'better-sqlite3');
  removeTree(target);
  copyTree(packageDir, target);
  log(
    'collect-opencode',
    `better-sqlite3 → node_modules/better-sqlite3（${readText(join(packageDir, 'package.json')).match(/"version":\s*"([^"]+)"/)?.[1] ?? '?'}，.node ${(fileSize(binding) / 1024 / 1024).toFixed(1)} MB）`,
  );
}

/** 归档内资源以「包 id」为粒度剪裁：scoped 包为 `@scope/pkg`，普通包为顶层名 */
function assetPackageId(relativePath) {
  const parts = relativePath.split('/').filter(Boolean);
  if (parts.length === 0) return '';
  return parts[0].startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

function matchesPrune(id) {
  return PRUNE_PATTERNS.some((pattern) => pattern.test(id) || pattern.test(`${id}/`));
}

function pruneNative() {
  const assets = join(STAGE_DIR, 'assets');
  if (!isDir(assets)) return;
  const removed = [];
  for (const entry of listDir(assets)) {
    const full = join(assets, entry);
    if (entry.startsWith('@')) {
      for (const pkg of listDir(full)) {
        const id = `${entry}/${pkg}`;
        if (matchesPrune(id)) {
          removeTree(join(full, pkg));
          removed.push(id);
        }
      }
      if (listDir(full).length === 0) removeTree(full);
      continue;
    }
    if (matchesPrune(entry)) {
      removeTree(full);
      removed.push(entry);
    }
  }
  if (removed.length > 0) {
    log('collect-opencode', `已剪裁 ${removed.length} 个非 arm64 / 设备不可用的原生包（assets/）: ${removed.join(', ')}`);
  }
}

function verifyArchive() {
  const listed = runOrFail('tar', ['-tzf', ARCHIVE]).stdout.split('\n').map((line) => line.trim());
  const total = listed.filter(Boolean).length;
  require_(total > 0, '归档为空');
  const required = [
    'dist-node/opencode.mjs',
    'dist-node/assets/app-archive.bin',
    'dist-node/node_modules/better-sqlite3/package.json',
    'dist-node/node_modules/better-sqlite3/build/Release/better_sqlite3.node',
  ];
  for (const entry of required) {
    require_(listed.includes(entry), `归档缺少必需条目: ${entry}`);
  }
  const pruned = listed
    .filter((line) => line.startsWith('dist-node/assets/'))
    .map((line) => assetPackageId(line.replace('dist-node/assets/', '')))
    .filter((id) => id !== '' && matchesPrune(id));
  require_(pruned.length === 0, `归档中仍存在应剪裁的原生包: ${[...new Set(pruned)].slice(0, 5).join(', ')}`);
  log('collect-opencode', `归档校验通过（${total} 个条目）`);
}

function isElfAarch64(p) {
  const head = readFileHead(p, 20);
  if (head.length < 20) return false;
  if (head[0] !== 0x7f || head[1] !== 0x45 || head[2] !== 0x4c || head[3] !== 0x46) return false;
  return head.readUInt16LE(18) === 0xb7;
}

main();
