/**
 * 运行时时序产物：流式解压 + marker 幂等（工程规划 §3.3/§6.3）。
 *
 * 为什么不能把产物直接铺进 HAP：
 *   ① 数万小文件会卡死 hvigor，或令 Electron 启动时 CHECK 崩溃（真机实测，§2.5b）；
 *   ② resfile 目录只读且不可 dlopen 原生模块 → 必须解压到可写的 userData 沙箱。
 *
 * marker 语义：marker 文件内容 = tar.gz 的 SHA-256。内容不一致即重新解压（V1 只比存在性，
 * 导致就地升级不生效，本工程显式修正为内容比对）。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const zlib = require('node:zlib');
const { pipeline } = require('node:stream/promises');

const ARCHIVE_NAME = 'opencode-dist.tar.gz';
const MARKER_NAME = 'opencode-dist.version';
/** 归档内顶层目录前缀：打包时以 dist-node/ 为根，解压时剥离 */
const STRIP_PREFIX = 'dist-node/';

/** 读取 marker（内容为归档 SHA-256）；不存在返回 undefined */
function readMarker(runtimeDir) {
  const marker = path.join(runtimeDir, MARKER_NAME);
  if (!fs.existsSync(marker)) return undefined;
  return fs.readFileSync(marker, 'utf8').trim();
}

function sha256File(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/**
 * 确保产物就位。
 *
 * ⚠️ 必须 await：extractTarGzSync 内部是流式解压（返回 Promise）。此前写成同步调用 + 立即写 marker，
 * 真机实测得到「已解压（marker=新）→ 立刻报服务端产物缺失 → 11 秒后才真正解压完成」的一次性失败，
 * 且 marker 已提前落盘，使下一次启动跳过解压。marker 只在解压「完成」后写。
 *
 * @returns {Promise<{ extracted: boolean, marker: string, dir: string, files: number }>}
 */
async function ensureExtracted(options) {
  const archive = options.archive || path.join(__dirname, ARCHIVE_NAME);
  const runtimeDir = options.runtimeDir;
  const onProgress = options.onProgress || (() => {});
  if (!fs.existsSync(archive)) {
    throw new Error(
      `运行时归档缺失: ${archive}（请先运行 node scripts/build-opencode.mjs 产出并投放 opencode-dist.tar.gz）`,
    );
  }
  const expected = sha256File(archive);
  const current = readMarker(runtimeDir);
  const entry = path.join(runtimeDir, 'opencode.mjs');
  if (current === expected && fs.existsSync(entry)) {
    return { extracted: false, marker: expected, dir: runtimeDir, files: 0 };
  }
  onProgress(`解压产物 → ${runtimeDir}（marker ${current ? current.slice(0, 12) : '无'} → ${expected.slice(0, 12)}）`);
  fs.rmSync(runtimeDir, { recursive: true, force: true });
  fs.mkdirSync(runtimeDir, { recursive: true });
  const files = await extractTarGzSync(archive, runtimeDir, { onProgress });
  fs.writeFileSync(path.join(runtimeDir, MARKER_NAME), `${expected}\n`);
  return { extracted: true, marker: expected, dir: runtimeDir, files };
}

/**
 * 流式解压 tar.gz（ustar）。
 * 设备侧约束：不能一次性读入（数百 MB 会 OOM）、禁 symlink/hardlink、chmod 只是尽力而为。
 */
function extractTarGzSync(archive, destDir, options = {}) {
  const onProgress = options.onProgress || (() => {});
  const gunzip = zlib.createGunzip();
  const input = fs.createReadStream(archive, { highWaterMark: 1 << 20 });
  let buffer = Buffer.alloc(0);
  let pending = Buffer.alloc(0);
  let files = 0;
  let skippedLinks = 0;
  let fd = null;
  let remaining = 0;

  const readString = (buf, offset, length) => buf.subarray(offset, offset + length).toString('utf8').replace(/\0.*$/, '');
  const readOctal = (buf, offset, length) => {
    const text = buf.subarray(offset, offset + length).toString('utf8').replace(/\0.*$/,'').trim();
    return text === '' ? 0 : parseInt(text, 8);
  };

  const processBuffer = () => {
    for (;;) {
      if (remaining > 0) {
        // 正在写文件内容
        const take = Math.min(remaining, buffer.length);
        if (take > 0) {
          fs.writeSync(fd, buffer.subarray(0, take));
          buffer = buffer.subarray(take);
          remaining -= take;
        }
        if (remaining > 0) return;
        fs.closeSync(fd);
        fd = null;
      }
      if (buffer.length < 512) return;
      const header = buffer.subarray(0, 512);
      if (header.every((byte) => byte === 0)) {
        buffer = buffer.subarray(512);
        continue;
      }
      const name = readString(header, 0, 100);
      const prefix = readString(header, 345, 155);
      const typeflag = String.fromCharCode(header[156] || 0x30);
      const size = readOctal(header, 124, 12);
      const fullPath = prefix ? `${prefix}/${name}` : name;
      const payloadSize = Math.ceil(size / 512) * 512;
      if (buffer.length < 512 + payloadSize) return;

      const relative = fullPath.startsWith(STRIP_PREFIX)
        ? fullPath.slice(STRIP_PREFIX.length)
        : fullPath.startsWith('./')
          ? fullPath.slice(2)
          : fullPath;
      const target = path.join(destDir, relative);
      if (!target.startsWith(destDir)) {
        throw new Error(`归档条目越出目标目录（拒绝解压）: ${fullPath}`);
      }

      if (typeflag === '5') {
        fs.mkdirSync(target, { recursive: true });
      } else if (typeflag === '2' || typeflag === '1') {
        // 设备侧 symlink/hardlink 不可用：跳过并计数（fail-visible，不静默）
        skippedLinks += 1;
      } else if (typeflag === '0' || typeflag === '\0' || typeflag === '') {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fd = fs.openSync(target, 'w');
        remaining = size;
        files += 1;
        const body = buffer.subarray(512, 512 + size);
        if (body.length > 0) {
          fs.writeSync(fd, body);
          remaining -= body.length;
        }
        if (remaining === 0) {
          fs.closeSync(fd);
          fd = null;
        }
      }
      // 其他类型（pax 头 x/g、字符设备等）直接跳过内容
      buffer = buffer.subarray(512 + payloadSize);
    }
  };

  return new Promise((resolve, reject) => {
    pipeline(input, gunzip)
      .then(() => {})
      .catch(reject);
    gunzip.on('data', (chunk) => {
      buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
      try {
        processBuffer();
      } catch (error) {
        reject(error);
        input.destroy();
      }
    });
    gunzip.on('end', () => {
      if (skippedLinks > 0) onProgress(`跳过 ${skippedLinks} 个链接条目（设备侧不支持 symlink/hardlink）`);
      onProgress(`解压完成：${files} 个文件`);
      resolve(files);
    });
    gunzip.on('error', reject);
    input.on('error', reject);
  });
}

module.exports = { ensureExtracted, readMarker, extractTarGzSync, ARCHIVE_NAME, MARKER_NAME, STRIP_PREFIX };
