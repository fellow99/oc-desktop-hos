#!/usr/bin/env node
/**
 * scripts/verify-branding.mjs —— 交付产物品牌化断言（独立工具，可对**任意** app-archive.bin 跑）。
 *
 * 判据（specs/103-branding/spec.md §5 / plan.md §3）：
 *   ① index.html 的 <title> 必须恰为 `OC Desktop`；
 *   ② site.webmanifest 的 name/short_name 必须是 `OC Desktop`，且 id/start_url/scope/icons 路径未变；
 *   ③ 保护清单（上游服务名 / 商标句 / 域名）逐条仍在产物中；
 *   ④ 排除保护清单后，「以本应用为指称」的 `OpenCode` 字面量必须为 0，`OC Desktop` 必须出现；
 *   ⑤ 内联 Logo 命中父工程 logo.svg 的 path 数据，且上游 16×16 path 已消失；
 *   ⑥ favicon / apple-touch-icon / PWA 图标与物料生成物**逐字节一致**；
 *   ⑦ 全部条目可 brotli 解压。
 *
 * 用法：
 *   node scripts/verify-branding.mjs <app-archive.bin> [--assets <物料目录>]
 * 退出码：
 *   0 = 全部断言通过；1 = 任一断言失败（**变换前的归档必然非零退出**，用于证明断言有牙齿）。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { BRAND_NAME, DEFAULT_MATERIAL_DIR, requireBranded, UPSTREAM_BRAND } from './lib/branding.mjs';
import { fail, isFile, log, parseArgs } from './lib/util.mjs';

const argv = process.argv.slice(2);
const args = parseArgs(argv);
const flagValues = new Set(Object.values(args.values));
const positional = argv.filter((arg) => !arg.startsWith('--') && !flagValues.has(arg));
const target = positional[0];

if (target === undefined) {
  fail(
    `用法: node scripts/verify-branding.mjs <app-archive.bin> [--assets <物料目录>]\n` +
      `  默认物料目录: ${DEFAULT_MATERIAL_DIR}`,
  );
}

const archivePath = resolve(target);
if (!isFile(archivePath)) fail(`归档不存在: ${archivePath}`);

const bytes = readFileSync(archivePath);
const materialDir = resolve(args.get('assets', DEFAULT_MATERIAL_DIR));
log('verify-branding', `断言目标: ${archivePath}（${bytes.length} 字节）`);
log('verify-branding', `品牌: ${UPSTREAM_BRAND} → ${BRAND_NAME}；物料: ${materialDir}`);

const report = requireBranded(bytes, { materialDir, label: archivePath, scope: 'verify-branding' });
const failed = report.checks.filter((check) => !check.ok);
log('verify-branding', `断言汇总: ${report.checks.length - failed.length}/${report.checks.length} 通过`);
if (!report.ok) fail(`品牌化断言失败 ${failed.length} 项: ${failed.map((check) => check.name).join(' / ')}`);
log('verify-branding', '品牌化断言全部通过');
