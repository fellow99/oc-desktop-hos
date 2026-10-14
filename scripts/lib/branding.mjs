#!/usr/bin/env node
/**
 * scripts/lib/branding.mjs —— 品牌化（OpenCode → OC Desktop）、图标物料生成与产物断言。
 *
 * 设计（回引 specs/103-branding/plan.md §1 D1–D9、spec.md §4）：
 *   · 只替换**首字母大写**的字面量 `OpenCode`；小写 `opencode`（技术标识符）与 camelCase
 *     代码标识符（`OpenCodeClient` 等）绝不触碰。且只作用于可判定为 UTF-8 文本的资产。
 *   · 保护清单（上游服务名 / 商标声明 / 域名）先掩码、后还原；替换前后按 token 计数断言不变。
 *   · 二进制资产**整文件替换**（不做字节级替换）：favicon / apple-touch-icon / PWA 图标。
 *   · 归档格式与上游 `packages/cli/src/app-archive.ts` 完全一致，brotli quality 11。
 *   · PNG 编解码 / 缩放 / 去 alpha 全部纯 JS 实现（不引三方依赖）；无法解码即硬失败。
 *
 * 用法（CLI 见文件末尾）：
 *   node scripts/lib/branding.mjs --generate-icons        由父工程物料重生成 AppScope 5 个图标
 *   node scripts/lib/branding.mjs --self-test             物料往返 / 生成确定性自检
 *   node scripts/lib/branding.mjs --brand <in> --out <out> 对任意 app-archive.bin 做品牌化
 *   node scripts/lib/branding.mjs --verify <archive.bin>  断言（等价于 scripts/verify-branding.mjs）
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { brotliCompressSync, brotliDecompressSync, constants, deflateSync, inflateSync } from 'node:zlib';
import { fail, isFile, log, md5File, parseArgs, require_, sha256File } from './util.mjs';

export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
/** 父工程品牌物料目录（spec.md §1「物料来源」：../assets/） */
export const DEFAULT_MATERIAL_DIR = resolve(PROJECT_ROOT, '..', 'assets');

export const BRAND_NAME = 'OC Desktop';
export const UPSTREAM_BRAND = 'OpenCode';

/**
 * 本仓**入库的透明品牌位图**目录（2026-10-14 需求变更后成为图标物料的实际来源）。
 * 由 `scripts/make-brand-materials.mjs` 从父工程 `logo.svg` 栅格化而来；构建期只消费、不重生成
 * （因此构建不依赖本机 Chromium）。与父工程 `logo.png` 的像素一致性由 `loadMaterial` 断言把关。
 */
export const DEFAULT_BRAND_MATERIAL_DIR = resolve(PROJECT_ROOT, 'assets', 'brand');

/** 入库位图清单（文件名即尺寸标注；全部保留 Alpha） */
export const BRAND_RASTERS = [
  'logo-1024-transparent.png',
  'logo-512-transparent.png',
  'logo-200-transparent.png',
  'logo-192-transparent.png',
  'logo-180-transparent.png',
  'logo-64-transparent.png',
  'logo-32-transparent.png',
];

/**
 * 保护清单（FR-brand-005）：**不得**被品牌化改写。
 * 上游真实服务名 / 商标归属声明 / 域名 —— 改成自家品牌属于事实错误与法律风险。
 */
export const PROTECTED_SUBSTRINGS = [
  'OpenCode is a registered trademark of Anomaly Innovations, Inc.',
  'OpenCode Console',
  'OpenCode Go',
  'OpenCode Zen',
  'OpenCode Free',
  'www.opencode.ai',
];

/**
 * 保护清单中**必须在交付产物里存在**的子集（断言用）。
 * `OpenCode Zen` 在 opencode v2.0.26 的 Web UI 产物里没有字面量（实测 0 处），
 * 因此只保护、不要求存在——上游将来引入时无需改本文件即自动受保护。
 */
export const REQUIRED_PROTECTED_SUBSTRINGS = PROTECTED_SUBSTRINGS.filter((token) => token !== 'OpenCode Zen');

/**
 * 技术标识符探针（FR-brand-005 第 1 类）：品牌化前后计数必须一致。
 * 全是小写/下划线形态，正常替换不可能命中；这里断言的是「没有被误伤」。
 */
export const TECHNICAL_MARKERS = [
  'opencode-theme-id',
  'opencode-color-scheme',
  'opencode_session',
  'OPENCODE_',
  'opencode:',
  '@opencode/',
];

/** 上游连接页矢量字标（viewBox `0 0 720 129`）的特征 path —— 品牌化后必须消失 */
const UPSTREAM_WORDMARK_PATH = 'M55.3846 36.4286H18.4615V91.7143H55.3846V36.4286ZM73.8462 110.143H0V18H73.8462V110.143Z';

/**
 * 上游「新建会话页大字标」的最后一笔字形路径（viewBox `0 0 234 42`，8 个字母的最后一笔，唯一）。
 * 品牌化后必须消失；用它定位该 SVG 的结束位置（上游压缩器省略了 `</g></svg>`）。
 */
const UPSTREAM_NEW_SESSION_WORDMARK_LAST_PATH = 'M216 12V18H228V12H216ZM234 24H216V30H234V36H210V6H234V24Z';

/** 上游「新建会话页大字标」第一笔字形路径（用于断言品牌化后确实消失） */
export const UPSTREAM_NEW_SESSION_WORDMARK_FIRST_PATH = 'M18 30H6V18H18V30Z';

/** 上游内联 Logo（`data-component=opencode-logo`）的特征 path —— 品牌化后必须消失 */
export const UPSTREAM_INLINE_LOGO_PATH = 'M11.1999 12.8H4.79993V6.40002H11.1999V12.8Z';

/**
 * 归档内需要整文件替换的二进制 UI 资产 → 由物料生成的图标名。
 * 前 5 个是 public/ 根目录副本；`icons/dev/*` 是 index.html / site.webmanifest 实际引用
 * 的路径（上游 vite.icons.ts 生成，dev channel），必须一起换否则界面仍是上游图标。
 */
export const ARCHIVE_ICON_ASSETS = {
  'favicon.ico': 'favicon.ico',
  'favicon.svg': 'favicon.svg',
  'apple-touch-icon.png': 'apple-touch-icon.png',
  'web-app-manifest-192x192.png': 'web-app-manifest-192x192.png',
  'web-app-manifest-512x512.png': 'web-app-manifest-512x512.png',
  'icons/dev/favicon.ico': 'favicon.ico',
  'icons/dev/apple-touch-icon.png': 'apple-touch-icon.png',
  'icons/dev/web-app-manifest-192x192.png': 'web-app-manifest-192x192.png',
  'icons/dev/web-app-manifest-512x512.png': 'web-app-manifest-512x512.png',
  // 真机 DOM 探针实测（2026-10-14）：首页左上角那个图标就是这个资产
  // （`<img class="shrink-0 rounded-[4px] shadow-[var(--v2-elevation-raised)] size-5" src="/_assets/64x64-*.png">`），
  // 上游给的是**蓝底白字 opencode 图标**，必须换成自家品牌。
  '_assets/64x64-D8-3fHil.png': 'app-64.png',
};

/** 由物料生成的 UI 图标（archive 替换与断言共用同一份字节） */
export const WEB_ICON_SPECS = [
  { name: 'favicon.ico', kind: 'copy', from: 'ico' },
  { name: 'favicon.svg', kind: 'copy', from: 'svg' },
  { name: 'apple-touch-icon.png', kind: 'brand', from: 'logo-180-transparent.png', size: 180 },
  { name: 'web-app-manifest-192x192.png', kind: 'brand', from: 'logo-192-transparent.png', size: 192 },
  { name: 'web-app-manifest-512x512.png', kind: 'brand', from: 'logo-512-transparent.png', size: 512 },
  // UI 内的应用图标（真机实测：`<img src="/_assets/64x64-*.png">`，首页左上角按 20×20 显示）——
  // 上游给的是蓝底 opencode 图标，必须换成自家品牌（2026-10-14 需求）。
  { name: 'app-64.png', kind: 'brand', from: 'logo-64-transparent.png', size: 64 },
];

/**
 * AppScope 应用/窗口图标（FR-brand-008/009）。
 * **2026-10-14 需求变更**：应用级图标原先要求「不带 alpha」（白底母版），真机表现是「白方块」，
 * 用户判定不可接受 ⇒ 改为**保留透明**的入库位图（`assets/brand/*-transparent.png`）：
 * 图案与父工程 `logo.png` 一致（橙 + 白），不再有白色底块。
 * 代价（如实登记）：与 specs/103-branding FR-brand-009 的旧口径相反，应用市场是否接受带 Alpha 的
 * 应用图标**未验证**，若被驳回需回退到「压深色/品牌色底」的方案（见该 spec 的 R6）。
 */
export const APP_ICON_TARGETS = [
  { path: 'AppScope/resources/base/media/app_icon.png', from: 'logo-1024-transparent.png', size: 1024, alpha: true },
  { path: 'AppScope/resources/base/media/icon.png', from: 'logo-512-transparent.png', size: 512, alpha: true },
  { path: 'AppScope/resources/base/media/startIcon.png', from: 'logo-512-transparent.png', size: 512, alpha: true },
  { path: 'AppScope/resources/base/media/product_logo_32.png', from: 'logo-32-transparent.png', size: 32, alpha: true },
  { path: 'AppScope/resources/base/media/window_icon.png', from: 'logo-200-transparent.png', size: 200, alpha: true },
];

/** 归档内被当作文本处理的后缀（白名单：新类型不会被误当二进制乱码重编码） */
const TEXT_EXTENSIONS = new Set([
  'js', 'mjs', 'cjs', 'css', 'html', 'htm', 'json', 'webmanifest', 'svg', 'txt', 'xml', 'map', 'md', 'csv', 'yml', 'yaml',
]);
/** 无后缀但确知是文本的资产（index.html 的 CSP/headers 配置） */
const TEXT_NO_EXTENSION = new Set(['_headers', 'robots.txt']);

// ==================================================================== PNG

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/** 解码 PNG → { width, height, rgba }；只支持 8bit 非隔行，其余一律硬失败（绝不产出错图） */
export function decodePng(bytes, label = '<buffer>') {
  require_(bytes.length > 8 && bytes.subarray(0, 8).equals(PNG_SIGNATURE), `不是 PNG（签名不符）: ${label}`);
  let header = null;
  let palette = null;
  let transparency = null;
  const idat = [];
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.subarray(offset + 4, offset + 8).toString('ascii');
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      header = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        compression: data[10],
        filter: data[11],
        interlace: data[12],
      };
    } else if (type === 'PLTE') palette = Buffer.from(data);
    else if (type === 'tRNS') transparency = Buffer.from(data);
    else if (type === 'IDAT') idat.push(Buffer.from(data));
    else if (type === 'IEND') break;
    offset += 12 + length;
  }
  require_(header, `PNG 缺少 IHDR: ${label}`);
  require_(header.interlace === 0, `不支持隔行 PNG（interlace=${header.interlace}）: ${label}`);
  require_(header.compression === 0 && header.filter === 0, `PNG 压缩/过滤方法不支持: ${label}`);
  require_(
    header.bitDepth === 8,
    `仅支持 8bit PNG（bitDepth=${header.bitDepth}，colorType=${header.colorType}）: ${label}`,
  );
  require_(PNG_CHANNELS[header.colorType] !== undefined, `不支持的 PNG colorType=${header.colorType}: ${label}`);
  require_(idat.length > 0, `PNG 缺少 IDAT: ${label}`);
  const pixels = unfilter(inflateSync(Buffer.concat(idat)), header, label);
  return { width: header.width, height: header.height, rgba: toRgba(pixels, header, palette, transparency, label) };
}

function unfilter(raw, header, label) {
  const channels = PNG_CHANNELS[header.colorType];
  const stride = header.width * channels;
  require_(
    raw.length >= (stride + 1) * header.height,
    `PNG 像素数据不完整: ${label}（期望 ≥ ${(stride + 1) * header.height}，实际 ${raw.length}）`,
  );
  const out = Buffer.alloc(stride * header.height);
  for (let y = 0; y < header.height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const at = y * stride;
    const prev = at - stride;
    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? out[at + x - channels] : 0;
      const b = y > 0 ? out[prev + x] : 0;
      const c = y > 0 && x >= channels ? out[prev + x - channels] : 0;
      let value = src[x];
      if (filter === 1) value += a;
      else if (filter === 2) value += b;
      else if (filter === 3) value += (a + b) >> 1;
      else if (filter === 4) value += paeth(a, b, c);
      else require_(filter === 0, `不支持的 PNG 行过滤器 ${filter}: ${label}（行 ${y}）`);
      out[at + x] = value & 0xff;
    }
  }
  return out;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

function toRgba(pixels, header, palette, transparency, label) {
  const count = header.width * header.height;
  const out = Buffer.alloc(count * 4);
  if (header.colorType === 6) {
    pixels.copy(out);
    return out;
  }
  if (header.colorType === 2) {
    const key = transparency && transparency.length >= 6 ? [transparency.readUInt16BE(0), transparency.readUInt16BE(2), transparency.readUInt16BE(4)] : null;
    for (let i = 0; i < count; i += 1) {
      const r = pixels[i * 3];
      const g = pixels[i * 3 + 1];
      const b = pixels[i * 3 + 2];
      out[i * 4] = r;
      out[i * 4 + 1] = g;
      out[i * 4 + 2] = b;
      out[i * 4 + 3] = key && r === key[0] && g === key[1] && b === key[2] ? 0 : 255;
    }
    return out;
  }
  if (header.colorType === 0) {
    const key = transparency && transparency.length >= 2 ? transparency.readUInt16BE(0) : null;
    for (let i = 0; i < count; i += 1) {
      const v = pixels[i];
      out[i * 4] = v;
      out[i * 4 + 1] = v;
      out[i * 4 + 2] = v;
      out[i * 4 + 3] = key !== null && v === key ? 0 : 255;
    }
    return out;
  }
  if (header.colorType === 4) {
    for (let i = 0; i < count; i += 1) {
      const v = pixels[i * 2];
      out[i * 4] = v;
      out[i * 4 + 1] = v;
      out[i * 4 + 2] = v;
      out[i * 4 + 3] = pixels[i * 2 + 1];
    }
    return out;
  }
  if (header.colorType === 3) {
    require_(palette, `调色板 PNG 缺少 PLTE: ${label}`);
    const size = palette.length / 3;
    require_(Number.isInteger(size), `PNG PLTE 长度非法: ${label}`);
    for (let i = 0; i < count; i += 1) {
      const index = pixels[i];
      require_(index < size, `调色板索引越界（${index} ≥ ${size}）: ${label}`);
      out[i * 4] = palette[index * 3];
      out[i * 4 + 1] = palette[index * 3 + 1];
      out[i * 4 + 2] = palette[index * 3 + 2];
      out[i * 4 + 3] = transparency && index < transparency.length ? transparency[index] : 255;
    }
    return out;
  }
  return fail(`不支持的 PNG colorType=${header.colorType}: ${label}`);
}

/** 编码 PNG（确定性：filter=None + deflate level 9）；channels 3=RGB(colorType 2)，4=RGBA(colorType 6) */
export function encodePng({ width, height, channels, data }) {
  const stride = width * channels;
  require_(data.length === stride * height, `PNG 编码像素长度不符（${data.length} ≠ ${stride * height}）`);
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    data.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = channels === 4 ? 6 : 2;
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0, 0);
  return Buffer.concat([length, body, crc]);
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

/**
 * RGBA 缩放（纯 JS）。
 * 整数比（source % target === 0）走 box 均值——192/512/32 这类目标零插值误差；
 * 其余（含放大）走中心对齐双线性。确定性：只依赖 IEEE754 与 Math.round。
 */
export function resizeRgba(source, width, height) {
  const { width: sw, height: sh, rgba } = source;
  require_(sw > 0 && sh > 0 && width > 0 && height > 0, `缩放尺寸非法: ${sw}×${sh} → ${width}×${height}`);
  const out = Buffer.alloc(width * height * 4);
  const fx = sw / width;
  const fy = sh / height;
  const box = Number.isInteger(fx) && Number.isInteger(fy);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const target = (y * width + x) * 4;
      if (box) {
        const sx0 = x * fx;
        const sy0 = y * fy;
        for (let channel = 0; channel < 4; channel += 1) {
          let sum = 0;
          for (let by = 0; by < fy; by += 1) {
            const row = (sy0 + by) * sw;
            for (let bx = 0; bx < fx; bx += 1) sum += rgba[(row + sx0 + bx) * 4 + channel];
          }
          out[target + channel] = Math.round(sum / (fx * fy));
        }
        continue;
      }
      const sx = Math.min(sw - 1, Math.max(0, (x + 0.5) * fx - 0.5));
      const sy = Math.min(sh - 1, Math.max(0, (y + 0.5) * fy - 0.5));
      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const x1 = Math.min(sw - 1, x0 + 1);
      const y1 = Math.min(sh - 1, y0 + 1);
      const wx = sx - x0;
      const wy = sy - y0;
      for (let channel = 0; channel < 4; channel += 1) {
        const p00 = rgba[(y0 * sw + x0) * 4 + channel];
        const p10 = rgba[(y0 * sw + x1) * 4 + channel];
        const p01 = rgba[(y1 * sw + x0) * 4 + channel];
        const p11 = rgba[(y1 * sw + x1) * 4 + channel];
        out[target + channel] = Math.round(
          p00 * (1 - wx) * (1 - wy) + p10 * wx * (1 - wy) + p01 * (1 - wx) * wy + p11 * wx * wy,
        );
      }
    }
  }
  return { width, height, rgba: out };
}

/** 丢弃 alpha 通道 → RGB（应用级图标上架合规 §8.5 G2） */
export function stripAlpha(rgba) {
  const count = rgba.length / 4;
  const out = Buffer.alloc(count * 3);
  for (let i = 0; i < count; i += 1) {
    out[i * 3] = rgba[i * 4];
    out[i * 3 + 1] = rgba[i * 4 + 1];
    out[i * 3 + 2] = rgba[i * 4 + 2];
  }
  return out;
}

/** 读取 PNG 的 IHDR（合规/断言用） */
export function pngHeader(bytes, label = '<buffer>') {
  require_(bytes.length > 24 && bytes.subarray(0, 8).equals(PNG_SIGNATURE), `不是 PNG（签名不符）: ${label}`);
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), bitDepth: bytes[24], colorType: bytes[25] };
}

// ==================================================================== 物料

export function parseSvgPaths(svgText, label = '<svg>') {
  const paths = [];
  const re = /<path\b([^>]*?)\/?>/g;
  let match = re.exec(svgText);
  while (match) {
    const d = /\bd="([^"]+)"/.exec(match[1])?.[1];
    const fill = /\bfill="([^"]+)"/.exec(match[1])?.[1];
    if (d) paths.push({ d, fill: fill ?? 'currentColor' });
    match = re.exec(svgText);
  }
  require_(paths.length > 0, `SVG 中未找到任何 <path d>: ${label}（品牌物料必须可用）`);
  return paths;
}

/** 载入父工程物料；缺失/不可解析一律硬失败并给出明确指引（FR-brand-010） */
export function loadMaterial(materialDir = DEFAULT_MATERIAL_DIR, brandDir = DEFAULT_BRAND_MATERIAL_DIR) {
  const files = {
    '透明 Logo 位图（与入库位图做一致性校验）': join(materialDir, 'logo.png'),
    '矢量 Logo（入库位图的来源）': join(materialDir, 'logo.svg'),
    'favicon.ico': join(materialDir, 'logo.ico'),
  };
  for (const [role, path] of Object.entries(files)) {
    require_(
      isFile(path),
      `品牌物料缺失（${role}）: ${path}\n` +
        '  父工程物料目录必须存在（FR-brand-010：缺失即硬失败，绝不回退占位图标）。\n' +
        '  期望目录内容: logo.png / logo.svg / logo.ico（`logo-1024-with-bg.png` 自 2026-10-14 起不再使用）。',
    );
  }
  const windowSource = decodePng(readFileSync(files['透明 Logo 位图（与入库位图做一致性校验）']), files['透明 Logo 位图（与入库位图做一致性校验）']);
  const svgText = readFileSync(files['矢量 Logo（入库位图的来源）'], 'utf8');

  // 入库透明位图（图标物料的实际来源）。缺失即硬失败并指向生成脚本。
  const brand = new Map();
  for (const name of BRAND_RASTERS) {
    const path = join(brandDir, name);
    require_(
      isFile(path),
      `入库品牌位图缺失: ${path}\n` +
        '  由 `node scripts/make-brand-materials.mjs` 从父工程 `logo.svg` 生成（需要本机 Chromium）。',
    );
    brand.set(name, decodePng(readFileSync(path), path));
  }

  // 漂移守卫：入库的 200px 位图必须与父工程 `logo.png` **逐像素一致**。
  // 父工程换了 logo 却忘了重跑生成脚本时，这里立刻硬失败，而不是静默用旧图案出包。
  const stored200 = brand.get('logo-200-transparent.png');
  require_(
    stored200.width === windowSource.width && stored200.height === windowSource.height,
    `入库位图与父工程 logo.png 尺寸不一致：${stored200.width}×${stored200.height} vs ${windowSource.width}×${windowSource.height}——请重跑 node scripts/make-brand-materials.mjs`,
  );
  let drift = 0;
  for (let index = 0; index < stored200.rgba.length; index += 1) {
    drift += Math.abs(stored200.rgba[index] - windowSource.rgba[index]);
  }
  require_(
    drift === 0,
    `入库品牌位图与父工程 logo.png 不一致（平均绝对差 ${(drift / stored200.rgba.length).toFixed(2)}）——` +
      '父工程物料已变更，请重跑 node scripts/make-brand-materials.mjs 后重新构建',
  );

  return {
    dir: materialDir,
    brandDir,
    brand,
    master: windowSource, // 兼容旧调用点：不再有不透明母版，统一指向透明位图
    window: windowSource,
    svgText,
    ico: readFileSync(files['favicon.ico']),
    svgPaths: parseSvgPaths(svgText, files['矢量 Logo（入库位图的来源）']),
  };
}

/** 由物料生成 UI 图标字节（archive 替换 + 断言共用） */
export function buildWebIcons(material, materialDir) {
  const source = material ?? loadMaterial(materialDir);
  const icons = new Map();
  for (const spec of WEB_ICON_SPECS) {
    if (spec.kind === 'copy' && spec.from === 'svg') {
      icons.set(spec.name, Buffer.from(source.svgText, 'utf8'));
      continue;
    }
    if (spec.kind === 'copy' && spec.from === 'ico') {
      icons.set(spec.name, source.ico);
      continue;
    }
    // kind === 'brand'：直接取入库的透明位图（已按目标尺寸栅格化，无需再缩放）
    const raster = source.brand.get(spec.from);
    require_(Boolean(raster), `UI 图标 ${spec.name} 引用了不存在的入库位图：${spec.from}`);
    require_(
      raster.width === spec.size && raster.height === spec.size,
      `入库位图 ${spec.from} 尺寸应为 ${spec.size}（实际 ${raster.width}×${raster.height}）`,
    );
    icons.set(spec.name, encodePng({ width: spec.size, height: spec.size, channels: 4, data: raster.rgba }));
  }
  return icons;
}

/** 生成/刷新 AppScope 5 个图标；内容一致时不写盘（幂等，不污染工作树） */
export function generateAppIcons(options = {}) {
  const material = options.material ?? loadMaterial(options.materialDir);
  const root = options.projectRoot ?? PROJECT_ROOT;
  const results = [];
  for (const target of APP_ICON_TARGETS) {
    const raster = material.brand.get(target.from);
    require_(Boolean(raster), `应用图标 ${target.path} 引用了不存在的入库位图：${target.from}`);
    require_(
      raster.width === target.size && raster.height === target.size,
      `入库位图 ${target.from} 尺寸应为 ${target.size}（实际 ${raster.width}×${raster.height}）`,
    );
    const bytes = encodePng({
      width: target.size,
      height: target.size,
      channels: target.alpha ? 4 : 3,
      data: target.alpha ? raster.rgba : stripAlpha(raster.rgba),
    });
    const absolute = join(root, target.path);
    const current = isFile(absolute) ? readFileSync(absolute) : null;
    if (current === null || !current.equals(bytes)) {
      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(absolute, bytes);
    }
    const header = pngHeader(bytes, target.path);
    results.push({
      path: target.path,
      bytes: bytes.length,
      width: header.width,
      height: header.height,
      colorType: header.colorType,
      md5: md5File(absolute),
      changed: current === null || !current.equals(bytes),
    });
  }
  return results;
}

// ==================================================================== 文本品牌化

/** 是否为「可安全按 UTF-8 文本处理」的资产（白名单 + 往返一致性） */
function textOf(key, raw) {
  const base = key.split('/').pop() ?? key;
  const extension = base.includes('.') ? base.split('.').pop().toLowerCase() : '';
  if (!TEXT_EXTENSIONS.has(extension) && !TEXT_NO_EXTENSION.has(base)) return null;
  const text = raw.toString('utf8');
  // 白名单里的资产若是非法 UTF-8，toString/from 往返会改变字节 → 必须放弃而不是损坏它
  return Buffer.from(text, 'utf8').equals(raw) ? text : null;
}

function countOccurrences(text, token) {
  return text.split(token).length - 1;
}

function addCounts(target, text, tokens) {
  for (const token of tokens) {
    const count = countOccurrences(text, token);
    if (count > 0) target[token] = (target[token] ?? 0) + count;
  }
}

/**
 * 品牌替换：`OpenCode` → `OC Desktop`（仅首字母大写形态）。
 * 保护清单先掩码再还原，因此服务名/商标句/域名逐字不动。
 */
export function brandText(text) {
  const restorations = [];
  let masked = text;
  PROTECTED_SUBSTRINGS.forEach((token, index) => {
    if (countOccurrences(masked, token) === 0) return;
    const sentinel = `\u0000b${index}\u0000`;
    masked = masked.split(token).join(sentinel);
    restorations.push([sentinel, token]);
  });
  // HTML 压缩器会去掉属性值引号（如 aria-label=OpenCode）；品牌名含空格，补回引号
  // 否则会被解析成两个属性。其后的全局替换不会再碰到它。
  masked = masked.replace(/=OpenCode(?=[>\s])/g, `="${BRAND_NAME}"`);
  // 标识符守卫（见上方注释）：保护清单已掩码，所以这里看到的都是将被替换的位置
  const identifierLike = new RegExp(`${UPSTREAM_BRAND}[A-Z0-9_$]`, "g");
  const risky = masked.match(identifierLike);
  require_(
    !risky,
    `品牌替换会破坏代码标识符（${(risky ?? []).slice(0, 5).join(", ")}）。` +
      `处置：把该标识符加入 PROTECTED_SUBSTRINGS，或改进 brandText 判定；不要盲目替换。`,
  );
  const replaced = countOccurrences(masked, UPSTREAM_BRAND);
  let out = masked.split(UPSTREAM_BRAND).join(BRAND_NAME);
  for (const [sentinel, token] of restorations) out = out.split(sentinel).join(token);
  require_(!out.includes('\u0000'), '品牌化内部错误：掩码未完全还原（会破坏产物）');
  return { text: out, replaced };
}

/**
 * 用父工程 `logo.svg` 的 path 数据替换上游 16×16 `opencode-logo` 的内联 SVG 几何。
 * 保留 `data-component=opencode-logo` / `aria-hidden` / `class` 绑定与模板字面量边界。
 */
export function brandInlineLogo(text, svgPaths) {
  const anchor = 'data-component=opencode-logo';
  const at = text.indexOf(anchor);
  if (at === -1) return { text, replaced: false };
  const end = text.indexOf('`', at);
  require_(
    end !== -1,
    '内联 Logo 不在模板字面量内（上游 UI 结构已变）：拒绝替换，避免截断整个 bundle',
  );
  const fragment = text.slice(at, end);
  require_(
    fragment.includes('fill=currentColor') && fragment.includes('<path'),
    `内联 Logo 形态与预期不符（上游 UI 结构已变），拒绝盲目替换: ${JSON.stringify(fragment.slice(0, 120))}`,
  );
  const paths = svgPaths.map((path) => `<path d=\\"${path.d}\\"fill=\\"${path.fill}\\"></path>`).join('');
  const replacement =
    `data-component=opencode-logo aria-hidden=true viewBox=\\"0 0 1024 1024\\"fill=none ` +
    `xmlns=http://www.w3.org/2000/svg>${paths}</svg>`;
  return { text: `${text.slice(0, at)}${replacement}${text.slice(end)}`, replaced: true };
}

// ==================================================================== 归档

export function decodeArchive(bytes, label = '<archive>') {
  require_(bytes.length > 4, `归档过小，不是 app-archive.bin: ${label}`);
  const indexLength = bytes.readUInt32LE(0);
  require_(4 + indexLength <= bytes.length, `归档索引长度越界（${indexLength}）: ${label}`);
  const index = JSON.parse(bytes.subarray(4, 4 + indexLength).toString('utf8'));
  return { index, body: 4 + indexLength, keys: Object.keys(index) };
}

function decompressEntry(bytes, index, body, key) {
  const entry = index[key];
  require_(Array.isArray(entry) && entry.length === 2, `归档索引项非法: ${key}`);
  const [offset, length] = entry;
  const slice = bytes.subarray(body + offset, body + offset + length);
  require_(slice.length === length, `归档条目越界: ${key}（${length} 字节，实际 ${slice.length}）`);
  return brotliDecompressSync(slice);
}

/** 与上游 packages/cli/src/app-archive.ts 的 AppArchive.encode 同构 */
export function encodeArchive(entries) {
  const state = { at: 0, index: {} };
  for (const [key, value] of entries) {
    state.index[key] = [state.at, value.length];
    state.at += value.length;
  }
  const index = Buffer.from(JSON.stringify(state.index), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(index.length, 0);
  return Buffer.concat([header, index, ...entries.map(([, value]) => value)]);
}

function compressEntry(body) {
  return brotliCompressSync(body, {
    params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: body.length },
  });
}

/**
 * 归档变换：文本资产品牌化 + 内联 Logo 替换 + 二进制 UI 图标整文件替换，然后按上游格式重编码。
 * 统计与断言信息用于可复核（spec.md §5 AC-01/02/03/05/07、R2/R3）。
 */
/**
 * 用父工程 logo.svg 的 1024×1024 坐标，换算出「居中放进 720×129 字标槽位」的变换。
 *
 * 为什么单独处理：上游有**两个**品牌图形引用点 —— 16×16 的 opencode-logo 组件（见 brandInlineLogo），
 * 以及服务端配对/连接页的矢量**字标**（viewBox 0 0 720 129，由 .server-connect-brand 承载）。
 * 只替换前者会在这页留下上游字标。
 *
 * 替换边界取「本模板字面量的结束反引号」而不是 `</svg>`：上游构建产物里的该片段**没有** `</svg>`
 *（压缩器省掉了可选结束标签），按 `</svg>` 找结束位置必然失败。安全前提是该片段内**不含**
 * `${…}` 插值（有插值就说明它带动态绑定，拒绝整体替换）。
 *
 * 保留原 viewBox：上游 CSS 只给该槽位 width:160px，换成正方形 viewBox 会把它从约 29px 顶到 160px。
 * 引号说明：该片段位于模板字面量内，属性引号是普通双引号（无转义）。
 */
export function brandWordmark(text, svgPaths) {
  const quote = String.fromCharCode(34);
  const backtick = String.fromCharCode(96);
  const anchor = 'viewBox=' + quote + '0 0 720 129' + quote;
  const marker = text.indexOf(anchor);
  if (marker === -1) return { text, replaced: false };
  const start = text.lastIndexOf('<svg', marker);
  require_(start !== -1, '字标 SVG 起始标签缺失（上游 UI 结构已变），拒绝盲目替换');
  const close = text.indexOf(backtick, marker);
  require_(close !== -1, '字标 SVG 片段缺少模板字面量结束反引号（上游 UI 结构已变），拒绝盲目替换');
  const region = text.slice(start, close);
  require_(
    !region.includes('${'),
    '字标片段含模板插值（上游 UI 结构已变）：整体替换会丢掉动态绑定，拒绝替换',
  );
  // 等比缩放 129 / 1024；水平居中 (720 - 129) / 2
  const scale = 129 / 1024;
  const translateX = (720 - 129) / 2;
  const attribute = (name, value) => name + '=' + quote + value + quote;
  const paths = svgPaths
    .map((path) => '<path ' + attribute('d', path.d) + attribute('fill', path.fill) + '></path>')
    .join('');
  const replacement =
    '<svg xmlns=http://www.w3.org/2000/svg ' +
    attribute('viewBox', '0 0 720 129') +
    'fill=none>' +
    '<g ' +
    attribute('transform', 'translate(' + translateX.toFixed(4) + ' 0) scale(' + scale.toFixed(6) + ')') +
    '>' +
    paths +
    '</g></svg>';
  return { text: text.slice(0, start) + replacement + text.slice(close), replaced: true };
}

/**
 * 新建会话页的大字标（`data-component=new-session-wordmark`）→ 文字 "OC Desktop"。
 *
 * 上游把这个字标实现成 **8 个字母的矢量字形**（viewBox `0 0 234 42`，字母 o/p/e/n/c/o/d/e 每 24 单位一个），
 * 因此在 a11y 树里既不是文本、也没有可业务化的 id —— 真机 DOM 探针才定位到
 * （见 `docs/鸿蒙环境能力清单-v2.0.26.md` §12）。用户要求把它换成文字 "OC Desktop"。
 *
 * 匹配方式：锚定 `<svg ... viewBox="0 0 234 42" ...><g>` 起始标记 + 上游**最后一笔**的字形路径 `d`
 * （唯一），再补到该 path 的 `>` 为止 —— 上游压缩器**省略了 `</g></svg>`**，所以不能用闭合标签定位。
 * 任何一处锚点缺失即视为「上游结构已变」：不替换，并让断言把它暴露出来（绝不盲目替换）。
 */
export function brandNewSessionWordmark(text) {
  const quote = String.fromCharCode(34);
  const startMarker = '<svg xmlns=http://www.w3.org/2000/svg ' + 'viewBox=' + quote + '0 0 234 42' + quote;
  const marker = text.indexOf(startMarker);
  if (marker === -1) return { text, replaced: false };
  const group = text.indexOf('<g>', marker);
  require_(group !== -1, '新建会话字标缺少 <g> 起始（上游 UI 结构已变），拒绝替换');
  const lastLetter = text.indexOf('d=' + quote + UPSTREAM_NEW_SESSION_WORDMARK_LAST_PATH + quote, group);
  require_(lastLetter !== -1, '新建会话字标缺少上游最后一笔路径（上游 UI 结构已变），拒绝替换');
  const end = text.indexOf('>', lastLetter);
  require_(end !== -1, '新建会话字标路径未闭合（上游 UI 结构已变），拒绝替换');
  const region = text.slice(marker, end + 1);
  require_(
    !region.includes('${'),
    '新建会话字标片段含模板插值（上游 UI 结构已变）：整体替换会丢掉动态绑定，拒绝替换',
  );
  const attribute = (name, value) => name + '=' + quote + value + quote;
  const replacement =
    '<svg xmlns=' + quote + 'http://www.w3.org/2000/svg' + quote + ' ' +
    attribute('viewBox', '0 0 234 42') +
    ' fill=' + quote + 'none' + quote +
    '><g><text ' +
    attribute('x', '117') +
    attribute('y', '33') +
    attribute('text-anchor', 'middle') +
    attribute('font-size', '34') +
    attribute('font-weight', '600') +
    attribute('fill', 'var(--icon-base)') +
    '>' + BRAND_NAME + '</text></g></svg>';
  return { text: text.slice(0, marker) + replacement + text.slice(end + 1), replaced: true };
}

export function transformArchive(bytes, options = {}) {
  const material = options.material ?? loadMaterial(options.materialDir);
  const icons = options.icons ?? buildWebIcons(material);
  const { index, body, keys } = decodeArchive(bytes, options.label);
  const stats = {
    entries: keys.length,
    entriesAfter: 0,
    textAssets: 0,
    assetsChanged: 0,
    brandReplacements: 0,
    iconAssets: [],
    logoAssets: [],
    wordmarkAssets: [],
    titleBefore: null,
    titleAfter: null,
    protectedBefore: {},
    protectedAfter: {},
    technicalBefore: {},
    technicalAfter: {},
  };
  const pendingIcons = new Set(Object.keys(ARCHIVE_ICON_ASSETS));
  const entries = [];
  for (const key of keys) {
    const raw = decompressEntry(bytes, index, body, key);
    const iconName = ARCHIVE_ICON_ASSETS[key];
    if (iconName) {
      const generated = icons.get(iconName);
      require_(generated, `归档图标位无对应生成物: ${key} → ${iconName}`);
      pendingIcons.delete(key);
      stats.iconAssets.push(key);
      if (!generated.equals(raw)) stats.assetsChanged += 1;
      entries.push([key, generated]);
      continue;
    }
    const text = textOf(key, raw);
    if (text === null) {
      // 二进制：不做任何字节级替换（整文件替换只在图标白名单里发生）
      if (raw.includes(Buffer.from(UPSTREAM_BRAND))) {
        fail(`二进制资产含品牌字面量 ${UPSTREAM_BRAND}，字节替换会破坏结构、不替换又不满足 FR-brand-003: ${key}`);
      }
      entries.push([key, raw]);
      continue;
    }
    stats.textAssets += 1;
    addCounts(stats.protectedBefore, text, PROTECTED_SUBSTRINGS);
    addCounts(stats.technicalBefore, text, TECHNICAL_MARKERS);
    if (key === 'index.html') stats.titleBefore = /<title>([^<]*)<\/title>/.exec(text)?.[1] ?? null;
    const brandedText = brandText(text);
    stats.brandReplacements += brandedText.replaced;
    const logo = brandInlineLogo(brandedText.text, material.svgPaths);
    const withLogo = logo.replaced ? logo.text : brandedText.text;
    if (logo.replaced) stats.logoAssets.push(key);
    const wordmark = brandWordmark(withLogo, material.svgPaths);
    if (wordmark.replaced) stats.wordmarkAssets.push(key);
    // 新建会话页的大字标（`data-component=new-session-wordmark`，上游是 8 个字母矢量字形 "opencode"）
    // → 换成文字 "OC Desktop"（2026-10-14 需求）。
    const sessionWordmark = brandNewSessionWordmark(wordmark.replaced ? wordmark.text : withLogo);
    if (sessionWordmark.replaced) stats.sessionWordmarkAssets = [...(stats.sessionWordmarkAssets ?? []), key];
    const next = sessionWordmark.replaced ? sessionWordmark.text : wordmark.replaced ? wordmark.text : withLogo;
    if (key === 'index.html') stats.titleAfter = /<title>([^<]*)<\/title>/.exec(next)?.[1] ?? null;
    addCounts(stats.protectedAfter, next, PROTECTED_SUBSTRINGS);
    addCounts(stats.technicalAfter, next, TECHNICAL_MARKERS);
    const encoded = Buffer.from(next, 'utf8');
    if (!encoded.equals(raw)) stats.assetsChanged += 1;
    entries.push([key, encoded]);
  }
  require_(pendingIcons.size === 0, `归档缺少必需的图标资产位（上游 UI 结构已变，品牌化会静默失效）: ${[...pendingIcons].join(', ')}`);
  require_(stats.logoAssets.length > 0, `归档中未找到内联 Logo 资产（data-component=opencode-logo）——品牌引用点漂移，构建必须失败`);
  require_(
    stats.wordmarkAssets.length > 0,
    `归档中未找到连接页矢量字标（viewBox 0 0 720 129）——品牌引用点漂移，构建必须失败。` +
      `若上游确实移除了该字标，请同步更新 assertArchiveBranded 与 specs/103-branding/spec.md`,
  );
  require_(
    (stats.sessionWordmarkAssets ?? []).length > 0,
    '归档中未找到新建会话页大字标（viewBox 0 0 234 42，data-component=new-session-wordmark）——' +
      '品牌引用点漂移，构建必须失败。若上游确实移除了该字标，请同步更新 assertArchiveBranded 与 specs/103-branding/spec.md',
  );
  const branded = encodeArchive(entries.map(([key, raw]) => [key, compressEntry(raw)]));
  stats.entriesAfter = Object.keys(decodeArchive(branded, '<branded>').index).length;
  require_(stats.entriesAfter === stats.entries, `品牌化改变了归档条目数（${stats.entries} → ${stats.entriesAfter}）`);
  assertInvariants(stats);
  return { bytes: branded, stats };
}

/** 变换期的硬断言：保护清单未被改写、技术标识符计数不变、品牌名已落地 */
function assertInvariants(stats) {
  for (const token of PROTECTED_SUBSTRINGS) {
    const before = stats.protectedBefore[token] ?? 0;
    const after = stats.protectedAfter[token] ?? 0;
    require_(before === after, `保护清单被改写: ${token}（${before} → ${after}）`);
  }
  for (const marker of TECHNICAL_MARKERS) {
    const before = stats.technicalBefore[marker] ?? 0;
    const after = stats.technicalAfter[marker] ?? 0;
    require_(before === after, `技术标识符计数被改变: ${marker}（${before} → ${after}）`);
  }
  require_(stats.titleAfter === BRAND_NAME, `index.html 的 <title> 必须为 ${BRAND_NAME}，实际: ${stats.titleAfter}`);
  require_(stats.brandReplacements > 0, `未发生任何品牌替换——上游品牌引用点漂移`);
}

// ==================================================================== 断言

/**
 * 交付产物断言（spec.md §5 / plan.md §3）。对**任意** app-archive.bin 可跑：
 * 变换前的归档必然失败（证明断言有牙齿），变换后的归档必须全绿。
 */
export function assertArchiveBranded(bytes, options = {}) {
  const material = options.material ?? loadMaterial(options.materialDir);
  const icons = options.icons ?? buildWebIcons(material);
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail });

  let archive = null;
  let decodeError = null;
  try {
    archive = decodeArchive(bytes, options.label ?? '<archive>');
  } catch (error) {
    decodeError = error.message;
  }
  add('归档可解码（AppArchive 格式）', archive !== null, decodeError ?? `${bytes.length} 字节`);
  if (archive === null) return { ok: false, checks };

  const { index, body, keys } = archive;
  add('条目数 > 0', keys.length > 0, `${keys.length} 个条目`);

  const rawOf = {};
  let undecodable = [];
  for (const key of keys) {
    try {
      rawOf[key] = decompressEntry(bytes, index, body, key);
    } catch (error) {
      undecodable.push(`${key}: ${error.message}`);
    }
  }
  add('全部条目可 brotli 解压', undecodable.length === 0, undecodable.slice(0, 3).join(' | ') || `${keys.length}/${keys.length}`);

  // AC-01 标题
  const html = rawOf['index.html'];
  add('index.html 存在', Boolean(html), html ? `${html.length} 字节` : '缺失');
  const title = html ? /<title>([^<]*)<\/title>/.exec(html.toString('utf8'))?.[1] : undefined;
  add(`index.html <title> === ${BRAND_NAME}`, title === BRAND_NAME, `实际: ${JSON.stringify(title)}`);

  // AC-02 PWA manifest
  const manifestRaw = rawOf['site.webmanifest'];
  add('site.webmanifest 存在', Boolean(manifestRaw), manifestRaw ? `${manifestRaw.length} 字节` : '缺失');
  let manifest = null;
  try {
    manifest = manifestRaw ? JSON.parse(manifestRaw.toString('utf8')) : null;
  } catch (error) {
    add('site.webmanifest 可解析', false, error.message);
  }
  add(`manifest name/short_name === ${BRAND_NAME}`, manifest?.name === BRAND_NAME && manifest?.short_name === BRAND_NAME, `name=${JSON.stringify(manifest?.name)} short_name=${JSON.stringify(manifest?.short_name)}`);
  add(
    'manifest id/start_url/scope 与 icons 路径未被改动',
    manifest?.id === '/' &&
      manifest?.start_url === '/' &&
      manifest?.scope === '/' &&
      Array.isArray(manifest?.icons) &&
      manifest.icons.length === 2 &&
      manifest.icons.every((icon) => /^\/icons\/[a-z]+\/web-app-manifest-\d+x\d+\.png$/.test(icon.src) && icon.type === 'image/png'),
    JSON.stringify({ id: manifest?.id, start_url: manifest?.start_url, scope: manifest?.scope, icons: manifest?.icons?.map((icon) => icon.src) }),
  );

  // AC-03 保护清单 / 品牌字面量
  const allText = keys.map((key) => rawOf[key]?.toString('latin1') ?? '');
  for (const token of REQUIRED_PROTECTED_SUBSTRINGS) {
    const count = allText.reduce((sum, text) => sum + countOccurrences(text, token), 0);
    add(`保护清单仍在产物中: ${token}`, count > 0, `${count} 处`);
  }
  let unprotected = 0;
  for (const key of keys) {
    // 逐资产先掩码保护清单，再统计「以本应用为指称」的残留字面量
    let masked = rawOf[key]?.toString('utf8') ?? '';
    PROTECTED_SUBSTRINGS.forEach((token, tokenIndex) => {
      masked = masked.split(token).join(`\u0000b${tokenIndex}\u0000`);
    });
    unprotected += countOccurrences(masked, UPSTREAM_BRAND);
  }
  add(`以本应用为指称的 ${UPSTREAM_BRAND} 字面量 === 0`, unprotected === 0, `${unprotected} 处`);
  const brandCount = allText.reduce((sum, text) => sum + countOccurrences(text, BRAND_NAME), 0);
  add(`产物中出现 ${BRAND_NAME}`, brandCount > 0, `${brandCount} 处`);
  add(`index.html 中出现 ${BRAND_NAME}`, Boolean(html) && html.toString('utf8').includes(BRAND_NAME), '标题兜底');

  // 技术标识符仍在（未被误伤）
  const themeId = allText.reduce((sum, text) => sum + countOccurrences(text, 'opencode-theme-id'), 0);
  const scoped = allText.reduce((sum, text) => sum + countOccurrences(text, '@opencode/'), 0);
  add('技术标识符 opencode-theme-id 保留', themeId > 0, `${themeId} 处`);
  add('技术标识符 @opencode/ 保留', scoped > 0, `${scoped} 处`);

  // AC-05 内联 Logo
  const logoAssets = keys.filter((key) => (rawOf[key]?.toString('utf8') ?? '').includes('data-component=opencode-logo'));
  const logoText = logoAssets.map((key) => rawOf[key].toString('utf8')).join('\n');
  add('内联 Logo 组件位置存在', logoAssets.length > 0, logoAssets.join(', '));
  add('内联 Logo 命中父工程 logo.svg 的 path 数据', material.svgPaths.some((path) => logoText.includes(path.d)), `探针: ${material.svgPaths[0]?.d.slice(0, 24)}…`);
  add('上游 16×16 方框 path 已消失', !logoText.includes(UPSTREAM_INLINE_LOGO_PATH), UPSTREAM_INLINE_LOGO_PATH);
  // 连接页矢量字标：必须同样来自物料，且上游字标几何必须消失（specs/103-branding FR-brand-007）
  const wordmarkAssets = keys.filter((key) => (rawOf[key]?.toString('utf8') ?? '').includes('server-connect-brand'));
  const wordmarkText = wordmarkAssets.map((key) => rawOf[key].toString('utf8')).join(String.fromCharCode(10));
  add('连接页字标资产存在（server-connect-brand）', wordmarkAssets.length > 0, `${wordmarkAssets.length} 个资产`);
  add(
    '连接页字标命中父工程 logo.svg 的 path 数据',
    material.svgPaths.some((path) => wordmarkText.includes(path.d)),
    `探针: ${material.svgPaths[0]?.d.slice(0, 24)}…`,
  );
  add('上游 720×129 字标几何已消失', !wordmarkText.includes(UPSTREAM_WORDMARK_PATH), UPSTREAM_WORDMARK_PATH.slice(0, 48));

  // 新建会话页大字标（2026-10-14 需求）：上游 8 字母 "opencode" 字形必须消失，且换成 "OC Desktop"
  const sessionWordmarkKeys = keys.filter((key) =>
    (rawOf[key]?.toString('utf8') ?? '').includes('data-component=new-session-wordmark'),
  );
  const sessionText = sessionWordmarkKeys
    .concat(keys.filter((key) => (rawOf[key]?.toString('utf8') ?? '').includes('viewBox="0 0 234 42"')))
    .map((key) => rawOf[key].toString('utf8'))
    .join('\n');
  add('新建会话字标资产存在（viewBox 0 0 234 42）', sessionText.includes('viewBox="0 0 234 42"'), `${sessionWordmarkKeys.length} 个容器资产`);
  add(
    `新建会话字标已换成 ${BRAND_NAME} 文本`,
    sessionText.includes('>' + BRAND_NAME + '</text>'),
    `探针: >${BRAND_NAME}</text>`,
  );
  add(
    '上游 234×42 字标最后一笔几何已消失',
    !sessionText.includes(UPSTREAM_NEW_SESSION_WORDMARK_LAST_PATH),
    UPSTREAM_NEW_SESSION_WORDMARK_LAST_PATH.slice(0, 40),
  );

  // AC-05/AC-07 归档内图标与物料生成物逐字节一致
  for (const [key, iconName] of Object.entries(ARCHIVE_ICON_ASSETS)) {
    const generated = icons.get(iconName);
    const actual = rawOf[key];
    add(
      `归档图标 ${key} 与物料生成物一致`,
      Boolean(actual) && Boolean(generated) && actual.equals(generated),
      actual ? `${actual.length} 字节 → 期望 ${generated?.length}` : '条目缺失',
    );
  }

  return { ok: checks.every((check) => check.ok), checks };
}

/** 断言 + 逐条日志（scope 可换，便于在 verify-branding / collect-opencode 里区分来源） */
export function requireBranded(bytes, options = {}) {
  const report = assertArchiveBranded(bytes, options);
  for (const check of report.checks) {
    log(options.scope ?? 'branding', `${check.ok ? '✓' : '✗'} ${check.name} — ${check.detail}`);
  }
  return report;
}

// ==================================================================== CLI

function selfTest(materialDir) {
  log('branding', `物料目录: ${materialDir}`);
  for (const name of ['logo-1024-with-bg.png', 'logo.png']) {
    const path = join(materialDir, name);
    const original = readFileSync(path);
    const first = decodePng(original, path);
    const encoded = encodePng({ width: first.width, height: first.height, channels: 4, data: first.rgba });
    const second = decodePng(encoded, `${name}:reencoded`);
    require_(first.rgba.equals(second.rgba), `PNG 往返像素不一致: ${name}`);
    const twice = encodePng({ width: first.width, height: first.height, channels: 4, data: first.rgba });
    require_(encoded.equals(twice), `PNG 编码不确定: ${name}`);
    log('branding', `✓ PNG 往返一致 ${name}（${first.width}×${first.height}，${encoded.length} 字节）`);
  }
  const first = generateAppIcons({ materialDir, projectRoot: process.env.PI_BRANDING_SELFTEST_ROOT ?? PROJECT_ROOT });
  const second = generateAppIcons({ materialDir, projectRoot: process.env.PI_BRANDING_SELFTEST_ROOT ?? PROJECT_ROOT });
  first.forEach((icon, index) => {
    require_(icon.md5 === second[index].md5, `图标生成不确定: ${icon.path}`);
    log('branding', `✓ 确定性 ${icon.path} ${icon.width}×${icon.height} colorType=${icon.colorType} md5=${icon.md5}`);
  });
  const icons = buildWebIcons(null, materialDir);
  const iconsAgain = buildWebIcons(null, materialDir);
  for (const [name, bytes] of icons) {
    require_(bytes.equals(iconsAgain.get(name)), `UI 图标生成不确定: ${name}`);
    log('branding', `✓ UI 图标 ${name} ${bytes.length} 字节`);
  }
  log('branding', '自检通过（往返一致 + 生成确定性）');
}

function main() {
  const args = process.argv.slice(2);
  const parsed = parseArgs(args);
  const materialDir = resolve(parsed.get('assets', DEFAULT_MATERIAL_DIR));
  if (args.includes('--self-test')) {
    selfTest(materialDir);
    return;
  }
  if (args.includes('--generate-icons')) {
    const icons = generateAppIcons({ materialDir });
    for (const icon of icons) {
      log('branding', `${icon.changed ? '生成' : '未变'} ${icon.path}（${icon.width}×${icon.height} colorType=${icon.colorType} ${icon.bytes} B md5=${icon.md5}）`);
    }
    return;
  }
  const input = parsed.get('brand') ?? parsed.get('verify');
  if (input) {
    require_(isFile(resolve(input)), `归档不存在: ${resolve(input)}`);
    const bytes = readFileSync(resolve(input));
    const output = parsed.get('out');
    if (output === undefined) {
      const report = requireBranded(bytes, { materialDir, label: resolve(input) });
      require_(report.ok, `品牌化断言失败（${report.checks.filter((check) => !check.ok).length} 项）`);
      log('branding', `断言全绿（${report.checks.length} 项）`);
      return;
    }
    const { bytes: branded, stats } = transformArchive(bytes, { materialDir, label: resolve(input) });
    mkdirSync(dirname(resolve(output)), { recursive: true });
    writeFileSync(resolve(output), branded);
    log('branding', `已写出 ${resolve(output)}（${branded.length} 字节）`);
    log('branding', `条目 ${stats.entries}（其中文本 ${stats.textAssets}，变更 ${stats.assetsChanged}，品牌替换 ${stats.brandReplacements} 处，图标 ${stats.iconAssets.length} 个，Logo ${stats.logoAssets.length} 处）`);
    log('branding', `title: ${JSON.stringify(stats.titleBefore)} → ${JSON.stringify(stats.titleAfter)} sha256=${sha256File(resolve(output)).slice(0, 16)}…`);
    return;
  }
  fail('用法: node scripts/lib/branding.mjs --generate-icons | --self-test | --brand <in.bin> --out <out.bin> | --verify <archive.bin> [--assets <dir>]');
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) main();
