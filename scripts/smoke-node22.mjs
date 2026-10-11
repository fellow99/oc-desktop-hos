#!/usr/bin/env node
/**
 * smoke-node22.mjs —— host 侧门禁（工程规划 §6.4）。
 *
 * 为什么必须有这道门禁：v2 的 Node 产物由 Vite 以 `target: "node26"` 构建
 * （脚本内 NODE_VERSION=26.4.0，@types/node 24），而设备侧 Electron 37 内置的是
 * **Node 22.17.0**。两者相差 4 个大版本，是 R2（Node 版本错位）的唯一实体证据来源。
 * 因此：产物必须先在**与设备同版本的 Node 22.17.0** 上跑通，才允许上真机。
 *
 * 检查项（任一失败即非零退出）：
 *   ① opencode.mjs --version / --help
 *   ② serve --hostname 127.0.0.1 --port <随机> 能起来（v2 的密码必填契约：OPENCODE_PASSWORD）
 *   ③ GET /api/info 200（Basic 凭据）
 *   ④ GET / 返回 SPA（内嵌 UI 生效，不是 404）
 *   ⑤ GET /api/event 能读到首个 SSE 事件（server.connected）
 *
 * 用法：
 *   node scripts/smoke-node22.mjs                        默认跑全部检查
 *   node scripts/smoke-node22.mjs --node <path>          指定 Node 22.17.0 可执行文件
 *   node scripts/smoke-node22.mjs --product <dir>        指定 dist-node 目录
 *   node scripts/smoke-node22.mjs --keep                 保留临时 Node 下载
 */
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  banner,
  exists,
  extractZip,
  fail,
  fileSize,
  hasCommand,
  isDir,
  isFile,
  log,
  mkdirp,
  parseArgs,
  require_,
  run,
  runOrFail,
} from './lib/util.mjs';

const PROJECT_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const WORKSPACE_ROOT = resolve(PROJECT_ROOT, '..');
const NODE_VERSION = '22.17.0'; // 与 Electron 37.2.0 内置 Node 完全一致
const CACHE_DIR = join(PROJECT_ROOT, '.cache', 'node');

const args = parseArgs();
const PRODUCT_DIR = resolve(args.get('product', join(WORKSPACE_ROOT, 'opencode', 'packages', 'cli', 'dist-node')));
const ENTRY = join(PRODUCT_DIR, 'opencode.mjs');
const PASSWORD = 'oc-smoke-' + Math.random().toString(36).slice(2, 10);
const TIMEOUT_MS = Number(process.env.OCR_SMOKE_TIMEOUT_MS || 60_000);

async function main() {
  banner('smoke', `host 侧门禁（Node ${NODE_VERSION}）`);
  require_(isFile(ENTRY), `产物入口缺失: ${ENTRY}（先运行 scripts/build-opencode.mjs）`);
  const nodeBin = resolveNode();
  log('smoke', `Node 解释器: ${nodeBin}`);
  const version = runOrFail(nodeBin, ['--version']).stdout.trim();
  require_(version === `v${NODE_VERSION}`, `Node 版本不匹配：${version}，期望 v${NODE_VERSION}（必须与设备侧一致才有意义）`);

  checkCli(nodeBin);
  await checkServer(nodeBin);
  console.log('[oc-desktop] 完成：host 侧门禁全部通过（Node 22.17.0）');
}

function checkCli(nodeBin) {
  banner('smoke', '① CLI 自检（--version / --help）');
  const version = run(nodeBin, [ENTRY, '--version'], { env: smokeEnv() });
  require_(version.status === 0, `--version 失败（退出码 ${version.status}）：${(version.stderr || '').slice(-500)}`);
  log('smoke', `--version → ${version.stdout.trim().split('\n').pop()}`);
  const help = run(nodeBin, [ENTRY, '--help'], { env: smokeEnv() });
  require_(help.status === 0, `--help 失败（退出码 ${help.status}）：${(help.stderr || '').slice(-500)}`);
  require_(/serve/.test(help.stdout), '--help 输出中未见 serve 子命令（上游 CLI 结构可能已变化）');
  log('smoke', '--help 正常且包含 serve 子命令');
}

async function checkServer(nodeBin) {
  banner('smoke', '② 服务端启动 + ③/④/⑤ 接口检查');
  const port = await pickPort();
  const child = spawn(nodeBin, [ENTRY, 'serve', '--hostname', '127.0.0.1', '--port', String(port)], {
    cwd: PRODUCT_DIR,
    env: smokeEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = [];
  child.stdout.on('data', (chunk) => output.push(chunk.toString()));
  child.stderr.on('data', (chunk) => output.push(chunk.toString()));
  let exited = null;
  child.on('exit', (code) => {
    exited = code;
  });

  try {
    const base = `http://127.0.0.1:${port}`;
    const auth = `Basic ${Buffer.from(`opencode:${PASSWORD}`).toString('base64')}`;
    const deadline = Date.now() + TIMEOUT_MS;

    // ③ /api/info
    let info = null;
    while (Date.now() < deadline) {
      if (exited !== null) {
        fail(`服务端提前退出（code=${exited}）：\n${output.join('').slice(-2000)}`);
      }
      try {
        const response = await fetch(`${base}/api/info`, { headers: { authorization: auth, accept: 'application/json' } });
        if (response.status === 200) {
          info = await response.json();
          break;
        }
      } catch {
        // 未监听，继续等
      }
      await sleep(300);
    }
    require_(info, `服务端在 ${TIMEOUT_MS}ms 内未就绪。\n输出尾部：\n${output.join('').slice(-2000)}`);
    log('smoke', `③ /api/info 200 version=${info.version} pid=${info.pid}`);
    require_(Array.isArray(info.urls) || info.version, '/api/info 返回结构异常（缺 version）');

    // ④ 内嵌 UI（同源 SPA）
    const page = await fetch(`${base}/`, { headers: { authorization: auth } });
    require_(page.status === 200, `④ GET / 期望 200，实际 ${page.status}（内嵌 UI 未生效？）`);
    const html = await page.text();
    require_(/<html/i.test(html), '④ GET / 返回内容不是 HTML（内嵌 UI 归档可能缺失）');
    log('smoke', `④ GET / 200（${html.length} 字节 HTML，内嵌 UI 生效）`);

    // ⑤ SSE 事件流
    const sse = await fetch(`${base}/api/event`, { headers: { authorization: auth, accept: 'text/event-stream' } });
    require_(sse.status === 200, `⑤ GET /api/event 期望 200，实际 ${sse.status}`);
    const first = await readFirstChunk(sse, 10_000);
    require_(/server\.connected/.test(first), `⑤ SSE 首个事件不是 server.connected：${first.slice(0, 200)}`);
    log('smoke', '⑤ /api/event 首个事件 server.connected ✔');
  } finally {
    child.kill();
    await sleep(300);
  }
}

function smokeEnv() {
  return {
    ...process.env,
    OPENCODE_PASSWORD: PASSWORD,
    OPENCODE_DISABLE_MODELS_FETCH: '1',
    OPENCODE_FILEWATCHER_DISABLE: '1',
    OPENCODE_DISABLE_FFF: '1',
    // 产物自带的 assets/（app-archive.bin 等）；prelude 通常已设置，这里显式兜底
    OPENCODE_NODE_ASSETS_DIR: join(PRODUCT_DIR, 'assets'),
    // host 侧：优先用 .cache/smoke-host 里安装的 **Windows 版 better-sqlite3**，从而走与真机同一条 tier 1 路径
    // （设备侧该 env 指向 <runtimeDir>/node_modules/better-sqlite3）。未安装时退回包名解析。
    OPENCODE_BETTER_SQLITE3_PATH:
      process.env.OPENCODE_BETTER_SQLITE3_PATH ||
      (exists(join(PROJECT_ROOT, '.cache', 'smoke-host', 'node_modules', 'better-sqlite3'))
        ? join(PROJECT_ROOT, '.cache', 'smoke-host', 'node_modules', 'better-sqlite3')
        : 'better-sqlite3'),
  };
}

function resolveNode() {
  const explicit = args.get('node', '');
  if (explicit) {
    require_(isFile(explicit), `--node 指定的解释器不存在: ${explicit}`);
    return resolve(explicit);
  }
  const platform = process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'darwin' : 'linux';
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const dirName = `node-v${NODE_VERSION}-${platform}-${arch}`;
  const targetDir = join(CACHE_DIR, dirName);
  const executable = process.platform === 'win32' ? join(targetDir, 'node.exe') : join(targetDir, 'bin', 'node');
  if (isFile(executable)) return executable;

  // 本地 Node 恰好是 22.17.0 时直接复用（避免不必要的下载）
  const localVersion = run('node', ['--version'], { optional: true }).stdout.trim();
  if (localVersion === `v${NODE_VERSION}`) return 'node';

  mkdirp(CACHE_DIR);
  const extension = process.platform === 'win32' ? 'zip' : 'tar.gz';
  const archive = join(CACHE_DIR, `${dirName}.${extension}`);
  const url = `https://nodejs.org/dist/v${NODE_VERSION}/${dirName}.${extension}`;
  if (!isFile(archive)) {
    log('smoke', `下载 Node ${NODE_VERSION}: ${url}（${hasCommand('curl') ? 'curl' : '内置 fetch'}）`);
    downloadSync(url, archive);
  }
  log('smoke', `解压 ${archive}（${(fileSize(archive) / 1024 / 1024).toFixed(1)} MB）`);
  if (extension === 'zip') extractZip(archive, CACHE_DIR);
  else runOrFail('tar', ['-xzf', archive, '-C', CACHE_DIR]);
  require_(isFile(executable), `Node ${NODE_VERSION} 解压后未找到解释器: ${executable}`);
  return executable;
}

/** 用 curl 下载（Git Bash / Windows 10+ 自带 curl），失败回落到 PowerShell */
function downloadSync(url, target) {
  const viaCurl = run('curl', ['-fsSL', '-o', target, url], { optional: true, timeout: 600_000 });
  if (viaCurl.status === 0 && isFile(target)) return;
  if (process.platform === 'win32') {
    runOrFail('powershell', ['-NoProfile', '-NonInteractive', '-Command', `Invoke-WebRequest -Uri '${url}' -OutFile '${target}'`]);
    require_(isFile(target), `下载失败: ${url}`);
    return;
  }
  fail(`下载失败: ${url}（curl 不可用或网络不可达）`);
}

async function pickPort() {
  const { createServer } = await import('node:net');
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolvePort(port));
    });
  });
}

async function readFirstChunk(response, timeoutMs) {
  const reader = response.body.getReader();
  const timer = setTimeout(() => reader.cancel().catch(() => {}), timeoutMs);
  try {
    const decoder = new TextDecoder();
    let text = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      if (/server\.connected/.test(text) || text.length > 4096) break;
    }
    return text;
  } finally {
    clearTimeout(timer);
    await reader.cancel().catch(() => {});
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

main().catch((error) => fail(error && error.stack ? error.stack : String(error)));
