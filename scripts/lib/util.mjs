/**
 * oc-desktop-hos 构建脚本公共库。
 *
 * 只提供「无副作用」的工具函数：日志、哈希、拷贝、外部命令、归档解包、PNG 生成、JSON5 容错解析。
 * 任何失败都通过 fail() 以非零码退出，绝不静默降级（fail-visible，工程规划 §5.2/§6.4）。
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { cpSync, copyFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

/** 统一日志前缀（工程规划 §5.2：所有壳层日志以 [oc-desktop] 打点） */
export const LOG_PREFIX = '[oc-desktop]';

export function log(scope, message) {
  console.log(`${LOG_PREFIX}[${scope}] ${message}`);
}

export function warn(scope, message) {
  console.warn(`${LOG_PREFIX}[${scope}] 警告: ${message}`);
}

export function banner(scope, name) {
  console.log(`${LOG_PREFIX}[${scope}] ---- ${name} ----`);
}

/** 读取文件头部 n 字节（ELF/PNG 头校验用，避免整文件读入） */
export function readFileHead(p, n) {
  const fd = openSync(p, 'r');
  try {
    const buf = Buffer.alloc(n);
    const read = readSync(fd, buf, 0, n, 0);
    return buf.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

/** 硬失败：打印可诊断信息并以非零码退出 */
export function fail(message) {
  console.error(`${LOG_PREFIX} 错误: ${message}`);
  process.exit(1);
}

export function require_(condition, message) {
  if (!condition) fail(message);
}

export function exists(p) {
  return existsSync(p);
}

export function isDir(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export function isFile(p) {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

export function readText(p) {
  return readFileSync(p, 'utf8');
}

export function readJson(p) {
  try {
    return JSON.parse(readText(p));
  } catch (error) {
    return fail(`JSON 解析失败: ${p}（${error.message}）`);
  }
}

export function writeText(p, text) {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
}

export function mkdirp(p) {
  mkdirSync(p, { recursive: true });
}

export function md5File(p) {
  return createHash('md5').update(readFileSync(p)).digest('hex').toUpperCase();
}

export function sha256File(p) {
  return createHash('sha256').update(readFileSync(p)).digest('hex');
}

export function sha256Text(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function fileSize(p) {
  return statSync(p).size;
}

export function listDir(p) {
  return existsSync(p) ? readdirSync(p) : [];
}

export function copyTree(src, dest, filter) {
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(src, dest, { recursive: true, force: true, ...(filter ? { filter } : {}) });
}

export function copyOne(src, dest) {
  require_(existsSync(src), `待拷贝文件缺失: ${src}`);
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(src, dest);
}

export function removeTree(p) {
  rmSync(p, { recursive: true, force: true });
}

/**
 * 递归查找目录下匹配的文件名（用于在编译指导目录里定位 better_sqlite3.node 等产物）。
 * 返回相对路径数组，按字典序排序（可复现）。
 */
export function findFiles(root, matcher, options = {}) {
  const out = [];
  const walk = (dir, depth) => {
    if (depth > (options.maxDepth ?? 12)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (matcher(entry.name, full)) out.push(full);
    }
  };
  if (existsSync(root)) walk(root, 0);
  return out.sort();
}

/** 相对工程根的展示路径（日志用，统一正斜杠） */
export function rel(root, p) {
  return relative(root, p).split(sep).join('/');
}

// ------------------------------------------------------------------ 外部命令

/**
 * Windows 下把「裸命令名」解析成真实可执行文件路径。
 *
 * 背景（已实测）：spawnSync('bun') 在 Windows 上直接 ENOENT —— Node 不会像 shell 那样按
 * PATHEXT 补全，而 npm 全局安装的 bun 实际是 `bun.cmd` 包装（内核是
 * `<npm-global>/node_modules/bun/bin/bun.exe`）。因此这里先用 `where` 解出候选，
 * 优先 .exe，其次 .cmd/.bat（后者必须经 cmd /c 调用）。
 *
 * 带路径分隔符的命令（显式路径）原样返回，不做解析。
 */
const whereCache = new Map();
function resolveWindowsCommand(cmd) {
  if (/[\\/]/.test(cmd)) return cmd;
  const cached = whereCache.get(cmd);
  if (cached !== undefined) return cached;
  let resolved = cmd;
  const probe = spawnSync('where', [cmd], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  if (!probe.error && probe.status === 0) {
    // 只保留 Windows 可执行的候选：`where` 会先列出无扩展名的 POSIX shim（如
    // D:\AppData\npm-global\bun），spawnSync 无法执行它 → 必须过滤，否则修不了 ENOENT。
    const candidates = (probe.stdout ?? '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && existsSync(line) && /\.(exe|cmd|bat|com)$/i.test(line));
    const exe = candidates.find((line) => /\.exe$/i.test(line));
    resolved = exe ?? candidates[0] ?? cmd;
  }
  whereCache.set(cmd, resolved);
  return resolved;
}

/**
 * 同步执行外部命令。Windows 下的 .bat/.cmd 必须经 cmd /c 调用（工程规划 §6.4）；
 * 裸命令名先经 resolveWindowsCommand 解析（否则 spawnSync 不会走 PATHEXT，报 ENOENT）。
 * 返回 { status, stdout, stderr }；stdio 默认 'pipe' 以便脚本自行判定。
 */
export function run(cmd, args = [], options = {}) {
  const isWin = process.platform === 'win32';
  const target = isWin ? resolveWindowsCommand(cmd) : cmd;
  const needsShell = isWin && /\.(bat|cmd)$/i.test(target);
  const finalCmd = needsShell ? 'cmd' : target;
  const finalArgs = needsShell ? ['/c', target, ...args] : normalizeTarArgs(target, args, options.cwd ?? process.cwd());
  const result = spawnSync(finalCmd, finalArgs, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: 'utf8',
    maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024,
    stdio: options.stdio ?? 'pipe',
  });
  if (result.error) {
    if (options.optional) return { status: null, stdout: '', stderr: String(result.error.message) };
    return fail(`命令启动失败: ${cmd}（${result.error.message}）`);
  }
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/** 执行并要求成功；失败即硬失败（并把 stderr 摘要打出来） */
export function runOrFail(cmd, args = [], options = {}) {
  const result = run(cmd, args, options);
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim().split('\n').slice(-20).join('\n');
    fail(`命令失败(${result.status}): ${cmd} ${args.join(' ')}\n${detail}`);
  }
  return result;
}

/** 探测命令是否可用（which/where） */
export function hasCommand(name) {
  const probe = process.platform === 'win32' ? 'where' : 'which';
  const result = run(probe, [name], { optional: true, stdio: 'ignore' });
  return result.status === 0;
}

/**
 * GNU tar 会把 `D:\path` 里的冒号当成「远端主机:路径」→ 报 "Cannot connect to D: resolve failed"。
 * 因此对 tar 命令的参数做归一化：同盘符的绝对路径改成相对 cwd 的路径（不带冒号）；
 * 跨盘符无法用相对路径表达时，直接给出可操作的错误，避免出现难以理解的 tar 报错。
 */
export function normalizeTarArgs(cmd, args, cwd) {
  if (!/^(.*[\\/])?tar(\.exe)?$/i.test(cmd)) return args;
  return args.map((arg) => {
    if (typeof arg !== 'string' || !/^[A-Za-z]:[\\/]/.test(arg)) return arg;
    const sameDrive = arg.slice(0, 2).toLowerCase() === cwd.slice(0, 2).toLowerCase();
    if (!sameDrive) {
      fail(
        `tar 参数跨盘符无法安全传递（GNU tar 会把 "D:" 误判为远端主机）：${arg}\n` +
          `  请把待处理文件与工程放在同一盘符，或使用 --runtime-source / --product 指定同盘符目录。`,
      );
    }
    const relativePath = relative(cwd, arg);
    // GNU tar（MSYS 版）把反斜杠当转义字符，必须统一成正斜杠
    return (relativePath === '' ? '.' : relativePath).split('\\').join('/');
  });
}

// ------------------------------------------------------------------ 归档解包

/**
 * 解压 zip。
 * 优先 unzip（支持只解指定条目，避免 370MB 全量落盘），回退 tar（Windows 自带 bsdtar 支持 zip）。
 */
export function extractZip(zipPath, destDir, entries = []) {
  mkdirp(destDir);
  if (hasCommand('unzip')) {
    const args = ['-o', '-q', zipPath, ...(entries.length > 0 ? entries : []), '-d', destDir];
    runOrFail('unzip', args);
    return 'unzip';
  }
  if (hasCommand('tar')) {
    runOrFail('tar', ['-xf', zipPath, '-C', destDir, ...entries]);
    return 'tar';
  }
  return fail(`无法解压 zip（unzip / tar 均不可用）: ${zipPath}`);
}

/** 解压 tar.gz（Windows 自带 tar.exe 与 GNU tar 均可处理） */
export function extractTarGz(tarPath, destDir, entries = []) {
  mkdirp(destDir);
  require_(hasCommand('tar'), 'tar 不可用，无法解压 ' + tarPath);
  runOrFail('tar', ['-xzf', tarPath, '-C', destDir, ...entries]);
  return 'tar';
}

/** 解析 zip 内的条目名列表（用于定位内层 tar.gz） */
export function listZipEntries(zipPath) {
  if (!hasCommand('unzip')) return null;
  const result = runOrFail('unzip', ['-Z1', zipPath]);
  return result.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
}

// ------------------------------------------------------------------ PNG（占位图标）

/**
 * 生成纯色不透明 PNG（上架合规 §8.5 G2：图标不得含 Alpha）。
 * 用最小 PNG 编码器实现，避免引入三方依赖；仅用于仓库缺图标时生成占位资源。
 */
export function writeSolidPng(target, size, [r, g, b]) {
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    const rowStart = y * (size * 3 + 1);
    raw[rowStart] = 0; // filter: None
    for (let x = 0; x < size; x += 1) {
      const at = rowStart + 1 + x * 3;
      raw[at] = r;
      raw[at + 1] = g;
      raw[at + 2] = b;
    }
  }
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0, 0);
    return Buffer.concat([length, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor（无 Alpha）
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, png);
  return png.length;
}

let crcTable = null;
function crc32(buf) {
  if (crcTable === null) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i += 1) crc = (crc >>> 8) ^ crcTable[(crc ^ buf[i]) & 0xff];
  return crc ^ -1;
}

/** 读取 PNG 的宽高与 colorType（合规守卫用：不得为 6=RGBA / 4=Gray+Alpha） */
export function readPngHeader(p) {
  const fd = openSync(p, 'r');
  try {
    const head = Buffer.alloc(33);
    readSync(fd, head, 0, 33, 0);
    if (head.readUInt32BE(0) !== 0x89504e47) return null;
    return {
      width: head.readUInt32BE(16),
      height: head.readUInt32BE(20),
      bitDepth: head[24],
      colorType: head[25],
    };
  } finally {
    closeSync(fd);
  }
}

// ------------------------------------------------------------------ JSON5 容错解析

/**
 * 解析 JSON5/JSONC（DevEco 的 *.json5 允许注释与尾随逗号）。
 * 仅用于构建期自检，不替代 hvigor 的解析器。
 */
export function parseJson5(text, source = '<inline>') {
  const withoutComments = text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:"'\\])\/\/[^\n\r]*/g, '$1');
  const withoutTrailingCommas = withoutComments.replace(/,(\s*[}\]])/g, '$1');
  try {
    return JSON.parse(withoutTrailingCommas);
  } catch (error) {
    return fail(`JSON5 解析失败: ${source}（${error.message}）`);
  }
}

export function readJson5(p) {
  return parseJson5(readText(p), p);
}

/** 参数解析：--key value / --flag */
export function parseArgs(argv = process.argv.slice(2)) {
  const flags = new Set();
  const values = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      values[key] = next;
      i += 1;
    } else {
      flags.add(key);
    }
  }
  return { flags, values, has: (k) => flags.has(k), get: (k, fallback) => values[k] ?? fallback };
}
