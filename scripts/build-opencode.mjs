#!/usr/bin/env node
/**
 * build-opencode.mjs —— 阶段 ②：打补丁 → 构建 opencode 的 Node 产物 → 收集（工程规划 §6.1/§6.2）。
 *
 * 步骤（任一步失败即非零退出）：
 *   0 前置校验：../opencode 存在且位于预期基线；bun 版本满足 ^1.4.2；patches/v2.0.26/ 非空
 *   1 幂等打补丁：逐个性判断（git apply --reverse --check 成功 ⇒ 已应用 ⇒ 跳过）
 *   2 bun install --os=* --cpu=*（拉齐各平台可选依赖，构建期需要）
 *   3 bun run --cwd packages/cli script/build-node.ts --target=linux-arm64 --bundle-only
 *   4 node scripts/collect-opencode.mjs（物化 better-sqlite3 → tar.gz + 校验 → 投放 resfile）
 *   5 node scripts/smoke-node22.mjs（host 侧门禁，默认开启；--no-smoke 跳过）
 *
 * bun 版本契约（上游 root package.json 的 packageManager = bun@1.4.2；@opencode/script 用 semver 强制 ^1.4.2）：
 *   解析顺序 = --bun <path> → .cache/bun/bun-1.4.2[.exe] → .cache/bun/bun-<platform>/bun[.exe]
 *              → PATH 上的 bun（需满足 ^1.4.2）→ 下载官方发行包到 .cache/bun/
 *   PATH 上版本不符时不会静默使用（否则报错会指向上游脚本，误导排查）。
 *
 * 用法：
 *   node scripts/build-opencode.mjs
 *   node scripts/build-opencode.mjs --skip-install     跳过 bun install
 *   node scripts/build-opencode.mjs --no-smoke         跳过 host 侧冒烟
 *   node scripts/build-opencode.mjs --bun <path>       指定 bun 可执行文件（优先于缓存与 PATH）
 */
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  banner,
  extractZip,
  fail,
  fileSize,
  hasCommand,
  isDir,
  isFile,
  listDir,
  log,
  mkdirp,
  parseArgs,
  readText,
  require_,
  run,
  runOrFail,
  warn,
} from './lib/util.mjs';

const PROJECT_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const WORKSPACE_ROOT = resolve(PROJECT_ROOT, '..');
const OPENCODE_DIR = resolve(process.env.OCR_OPENCODE_DIR || join(WORKSPACE_ROOT, 'opencode'));
const PATCH_DIR = join(PROJECT_ROOT, 'patches', 'v2.0.26');
/** 上游基线（docs/工程规划-V2.md 文档头）：tag v2.0.26 / 提交 9b4ec5714d */
const EXPECTED_BASELINE = process.env.OCR_OPENCODE_BASELINE || '9b4ec5714d';

const args = parseArgs();
const SKIP_INSTALL = args.has('skip-install');
const NO_SMOKE = args.has('no-smoke');
/** 上游要求的 bun 版本（^1.4.2）与其缓存目录 */
const BUN_REQUIRED = '1.4.2';
const BUN_CACHE_DIR = join(PROJECT_ROOT, '.cache', 'bun');
let BUN = args.get('bun', '');

function main() {
  banner('build-opencode', '构建 opencode Node 产物');
  stage0Preflight();
  BUN = resolveBun();
  stage1Patches();
  if (!SKIP_INSTALL) stage2Install();
  stage3Build();
  stage4Collect();
  if (!NO_SMOKE) stage5Smoke();
  console.log('[oc-desktop] 完成：opencode Node 产物已构建并收集');
}

function stage0Preflight() {
  require_(isDir(OPENCODE_DIR), `上游源码目录缺失: ${OPENCODE_DIR}`);
  require_(isDir(PATCH_DIR), `补丁目录缺失: ${PATCH_DIR}`);
  const patches = listDir(PATCH_DIR).filter((name) => name.endsWith('.patch'));
  require_(patches.length > 0, `补丁目录为空: ${PATCH_DIR}`);
  const head = runOrFail('git', ['-C', OPENCODE_DIR, 'rev-parse', '--short', 'HEAD']).stdout.trim();
  require_(
    head.startsWith(EXPECTED_BASELINE.slice(0, 8)) || head === EXPECTED_BASELINE,
    `上游基线不匹配：当前 HEAD=${head}，期望 ${EXPECTED_BASELINE}（v2.0.26）。\n  补丁按该基线生成，换基线必须重生成补丁并新建 patches/<新tag>/。`,
  );
  const packageJson = readText(join(OPENCODE_DIR, 'package.json'));
  require_(/"version":\s*"2\.0\.26"/.test(packageJson), '上游 package.json 版本不是 2.0.26，请确认基线');
  log('build-opencode', `上游基线 HEAD=${head}，补丁 ${patches.length} 个: ${patches.join(', ')}`);
}

function stage1Patches() {
  banner('build-opencode', '幂等打补丁');
  for (const name of listDir(PATCH_DIR).filter((n) => n.endsWith('.patch')).sort()) {
    const patch = join(PATCH_DIR, name);
    require_(isFile(patch), `补丁缺失: ${patch}`);
    const reversed = run('git', ['-C', OPENCODE_DIR, 'apply', '--reverse', '--check', patch]);
    if (reversed.status === 0) {
      log('build-opencode', `${name} 已应用（reverse-check 通过），跳过`);
      continue;
    }
    const forward = run('git', ['-C', OPENCODE_DIR, 'apply', '--check', patch]);
    if (forward.status !== 0) {
      fail(
        `补丁 ${name} 既不能正向应用也不能反向应用（上游可能已漂移）。\n` +
          `  正向检查输出: ${(forward.stderr || forward.stdout).trim()}\n` +
          `  处置：按工程规划 §6.2 的「冲突即终止」原则，禁止 --3way 强行合并；请重生成补丁。`,
      );
    }
    runOrFail('git', ['-C', OPENCODE_DIR, 'apply', patch]);
    log('build-opencode', `${name} 已应用`);
  }
}

/**
 * 解析 bun：上游脚本要求 ^1.4.2，宿主 PATH 上的版本可能更旧（npm 全局装的 bun 常见），
 * 因此优先用 .cache/bun 下与本工程绑定的 1.4.2，绝不因为「PATH 上有 bun」就用错版本。
 */
function resolveBun() {
  if (BUN) {
    require_(isFile(BUN), `--bun 指定的 bun 不存在: ${BUN}`);
    return checkBun(resolve(BUN), '--bun');
  }
  const exeName = process.platform === 'win32' ? 'bun.exe' : 'bun';
  const pinned = join(BUN_CACHE_DIR, `bun-${BUN_REQUIRED}${process.platform === 'win32' ? '.exe' : ''}`);
  if (isFile(pinned)) return checkBun(pinned, `缓存 bun-${BUN_REQUIRED}`);
  const extracted = join(BUN_CACHE_DIR, bunTargetName(), exeName);
  if (isFile(extracted)) return checkBun(extracted, '缓存（发行包解压目录）');
  if (hasCommand('bun')) {
    const probe = run('bun', ['--version'], { optional: true });
    const version = (probe.stdout || '').trim();
    if (probe.status === 0 && satisfiesBun(version)) return checkBun('bun', `PATH（${version}）`);
    warn('build-opencode', `PATH 上的 bun ${version || '?'} 不满足 ^${BUN_REQUIRED}，改用缓存/下载的 ${BUN_REQUIRED}`);
  }
  return checkBun(downloadBun(), `下载 bun ${BUN_REQUIRED}`);
}

function checkBun(command, source) {
  const probe = run(command, ['--version'], { optional: true });
  const version = (probe.stdout || probe.stderr || '').trim().split('\n').pop();
  require_(probe.status === 0, `bun 不可执行（${source}）: ${command} → ${probe.stderr || probe.status}`);
  require_(
    satisfiesBun(version),
    `bun 版本不满足上游要求 ^${BUN_REQUIRED}（${source}）: ${version}\n` +
      `  上游 @opencode/script 启动时会直接抛错。处置：删除 .cache/bun 后重跑（脚本会下载 ${BUN_REQUIRED}），或用 --bun <path> 指定。`,
  );
  log('build-opencode', `bun ${version}（${source}）`);
  return command;
}

/** semver 语义的 ^1.4.2 判定（只比较 major.minor.patch） */
function satisfiesBun(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec((version || '').trim());
  if (!match) return false;
  const [major, minor, patch] = match.slice(1).map(Number);
  if (major !== 1) return false;
  if (minor !== 4) return minor > 4;
  return patch >= 2;
}

function bunTargetName() {
  const os = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'darwin' : 'linux';
  const arch = process.arch === 'arm64' ? (os === 'windows' ? 'x64' : 'aarch64') : 'x64';
  return `bun-${os}-${arch}`;
}

/** 下载官方发行包并解压到 .cache/bun（离线环境请预先放好 .cache/bun/bun-<ver>[.exe]） */
function downloadBun() {
  const target = bunTargetName();
  const archive = join(BUN_CACHE_DIR, `${target}.zip`);
  const executable = join(BUN_CACHE_DIR, target, process.platform === 'win32' ? 'bun.exe' : 'bun');
  mkdirp(BUN_CACHE_DIR);
  if (!isFile(archive)) {
    const url = `https://github.com/oven-sh/bun/releases/download/bun-v${BUN_REQUIRED}/${target}.zip`;
    log('build-opencode', `下载 bun ${BUN_REQUIRED}: ${url}`);
    const viaCurl = run('curl', ['-fsSL', '-o', archive, url], { optional: true });
    if (viaCurl.status !== 0 || !isFile(archive)) {
      if (process.platform !== 'win32') fail(`下载 bun 失败: ${url}（curl 不可用或网络不可达）`);
      runOrFail('powershell', ['-NoProfile', '-NonInteractive', '-Command', `Invoke-WebRequest -Uri '${url}' -OutFile '${archive}'`]);
    }
    require_(isFile(archive), `下载 bun 失败: ${url}`);
  }
  log('build-opencode', `解压 ${archive}（${(fileSize(archive) / 1024 / 1024).toFixed(1)} MB）`);
  extractZip(archive, BUN_CACHE_DIR);
  require_(isFile(executable), `bun 发行包解压后未找到可执行文件: ${executable}`);
  return executable;
}

function stage2Install() {
  banner('build-opencode', 'bun install --os=* --cpu=*');
  runOrFail(BUN, ['install', '--os=*', '--cpu=*'], { cwd: OPENCODE_DIR });
  log('build-opencode', '依赖已安装');
}

function stage3Build() {
  banner('build-opencode', '构建 dist-node（--target=linux-arm64 --bundle-only）');
  runOrFail(BUN, ['run', '--cwd', 'packages/cli', 'script/build-node.ts', '--target=linux-arm64', '--bundle-only'], {
    cwd: OPENCODE_DIR,
    stdio: 'inherit',
  });
  const product = join(OPENCODE_DIR, 'packages', 'cli', 'dist-node');
  require_(isFile(join(product, 'opencode.mjs')), `产物入口未生成: ${join(product, 'opencode.mjs')}`);
  require_(
    isFile(join(product, 'assets', 'app-archive.bin')),
    `内嵌 UI 归档未生成: ${join(product, 'assets', 'app-archive.bin')}（根路径会 404，见工程规划 §2.3）`,
  );
  log('build-opencode', `产物就绪: ${product}`);
}

function execNode(script, extra = []) {
  const result = run(process.execPath, [join(PROJECT_ROOT, 'scripts', script), ...extra], { stdio: 'inherit' });
  if (result.status !== 0) fail(`${script} 失败（退出码 ${result.status}）`);
}

function stage4Collect() {
  banner('build-opencode', '收集产物（tar.gz + 校验 + 投放）');
  execNode('collect-opencode.mjs');
}

function stage5Smoke() {
  banner('build-opencode', 'host 侧门禁（Node 22.17 冒烟）');
  execNode('smoke-node22.mjs');
}

main();
