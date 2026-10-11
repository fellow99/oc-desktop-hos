#!/usr/bin/env node
/**
 * build-opencode.mjs —— 阶段 ②：打补丁 → 构建 opencode 的 Node 产物 → 收集（工程规划 §6.1/§6.2）。
 *
 * 步骤（任一步失败即非零退出）：
 *   0 前置校验：../opencode 存在且位于预期基线；bun 可用；patches/v2.0.26/ 非空
 *   1 幂等打补丁：逐个性判断（git apply --reverse --check 成功 ⇒ 已应用 ⇒ 跳过）
 *   2 bun install --os=* --cpu=*（拉齐各平台可选依赖，构建期需要）
 *   3 bun run --cwd packages/cli script/build-node.ts --target=linux-arm64 --bundle-only
 *   4 node scripts/collect-opencode.mjs（物化 better-sqlite3 → tar.gz + 校验 → 投放 resfile）
 *   5 node scripts/smoke-node22.mjs（host 侧门禁，默认开启；--no-smoke 跳过）
 *
 * 用法：
 *   node scripts/build-opencode.mjs
 *   node scripts/build-opencode.mjs --skip-install     跳过 bun install
 *   node scripts/build-opencode.mjs --no-smoke         跳过 host 侧冒烟
 *   node scripts/build-opencode.mjs --bun <path>       指定 bun 可执行文件
 */
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { banner, fail, hasCommand, isDir, isFile, listDir, log, parseArgs, readText, require_, run, runOrFail } from './lib/util.mjs';

const PROJECT_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const WORKSPACE_ROOT = resolve(PROJECT_ROOT, '..');
const OPENCODE_DIR = resolve(process.env.OCR_OPENCODE_DIR || join(WORKSPACE_ROOT, 'opencode'));
const PATCH_DIR = join(PROJECT_ROOT, 'patches', 'v2.0.26');
/** 上游基线（docs/工程规划-V2.md 文档头）：tag v2.0.26 / 提交 9b4ec5714d */
const EXPECTED_BASELINE = process.env.OCR_OPENCODE_BASELINE || '9b4ec5714d';

const args = parseArgs();
const SKIP_INSTALL = args.has('skip-install');
const NO_SMOKE = args.has('no-smoke');
const BUN = args.get('bun', 'bun');

function main() {
  banner('build-opencode', '构建 opencode Node 产物');
  stage0Preflight();
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

function stage2Install() {
  banner('build-opencode', 'bun install --os=* --cpu=*');
  require_(hasCommand(BUN), `bun 不可用（未找到 ${BUN}）；请安装 bun 或用 --bun <path> 指定`);
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
