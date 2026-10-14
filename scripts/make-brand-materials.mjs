#!/usr/bin/env node
// ============================================================================
// make-brand-materials.mjs —— 由父工程矢量物料生成「透明」品牌位图（入库的构建输入）
// ----------------------------------------------------------------------------
// 为什么需要它（2026-10-14 需求变更）：
//   应用图标原先用父工程的**不透明白底母版** `assets/logo-1024-with-bg.png`，真机上表现为
//   「白方块 + 橙色环/白脸」（白色部分与白底融为一体）—— 用户判定不可接受，要求改用
//   `assets/logo.png`（**透明**底的橙 + 白图案）。而 `logo.png` 只有 200×200，
//   直接放大到 1024 会发虚（specs/103-branding/spec.md R5 禁止无谓放大）。
//
// 做法：用**父工程的矢量** `assets/logo.svg`（与 `logo.png` 同一图案）栅格化出各尺寸的透明 PNG，
//   落到本仓 `assets/brand/`，由构建流水线当**物料**消费（构建期不再依赖本机浏览器）。
//   自证：200px 栅格化结果必须与父工程 `../../assets/logo.png` **逐像素一致**（同一图案的硬证据）。
//
// 何时需要重跑：父工程 `assets/logo.svg` / `logo.png` 变更后。
//   构建期还有一道守卫（scripts/lib/branding.mjs `assertBrandMaterials`）：入库位图与父工程
//   `logo.png` 像素不一致时**硬失败**并提示重跑本脚本，因此不会静默漂移。
//
// 依赖：本机任一 Chromium（Chrome / Edge）。可用 `OCR_CHROMIUM=<可执行文件>` 覆盖查找。
// 用法：node scripts/make-brand-materials.mjs [--check]
//   --check 只校验（不写文件）：入库位图与父工程 logo.png 的像素一致性。
// ============================================================================

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { LOG_PREFIX } from './lib/util.mjs'
import { decodePng } from './lib/branding.mjs'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = join(SCRIPT_DIR, '..')
const PARENT_ASSETS = join(PROJECT_ROOT, '..', 'assets')
const OUT_DIR = join(PROJECT_ROOT, 'assets', 'brand')
const CHECK_ONLY = process.argv.includes('--check')

/** 需要生成的位图（尺寸 → 文件名）；全部保留 Alpha（本次需求变更的核心） */
const TARGETS = [
  { size: 1024, file: 'logo-1024-transparent.png' },
  { size: 512, file: 'logo-512-transparent.png' },
  { size: 200, file: 'logo-200-transparent.png' },
  { size: 192, file: 'logo-192-transparent.png' },
  { size: 180, file: 'logo-180-transparent.png' },
  { size: 64, file: 'logo-64-transparent.png' },
  { size: 32, file: 'logo-32-transparent.png' },
]

function fail(message) {
  console.error(`${LOG_PREFIX}[brand-material] FAIL ${message}`)
  process.exit(1)
}

function findChromium() {
  const candidates = [
    process.env.OCR_CHROMIUM,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'chromium',
    'google-chrome',
    'chromium-browser',
  ].filter(Boolean)
  for (const candidate of candidates) {
    try {
      if (candidate.includes('/') || candidate.includes('\\')) {
        if (existsSync(candidate)) return candidate
      } else {
        execFileSync(candidate, ['--version'], { stdio: 'ignore' })
        return candidate
      }
    } catch {
      // 继续找下一个
    }
  }
  fail(
    '未找到本机 Chromium（Chrome/Edge）。SVG→PNG 栅格化需要它。\n' +
      '  用 OCR_CHROMIUM=<chrome/msedge 可执行文件> 指定，或在装有 Chrome/Edge 的机器上重跑本脚本。',
  )
}

/**
 * 把 SVG 栅格化成 size×size 的**透明** PNG。
 * 走「HTML 包裹 + <img> 固定尺寸」而不是直接截 SVG：SVG 自带 width/height 属性（200×200），
 * 直接截会被按固有尺寸摆放，得不到目标尺寸。
 */
function rasterize(chromium, svgPath, size) {
  const workDir = mkdtempSync(join(tmpdir(), 'oc-brand-'))
  try {
    const svgTarget = join(workDir, 'logo.svg')
    const htmlPath = join(workDir, 'page.html')
    const outPath = join(workDir, 'out.png')
    writeFileSync(svgTarget, readFileSync(svgPath))
    writeFileSync(
      htmlPath,
      '<!doctype html><html><head><meta charset=utf-8><style>' +
        'html,body{margin:0;padding:0;background:transparent;overflow:hidden}' +
        `img{display:block;width:${size}px;height:${size}px}</style></head>` +
        '<body><img src="logo.svg"></body></html>',
    )
    execFileSync(
      chromium,
      [
        '--headless',
        '--disable-gpu',
        '--hide-scrollbars',
        // 关键：让截图的默认背景全透明（否则会得到纯白底，正是本次要修掉的问题）
        '--default-background-color=00000000',
        '--force-device-scale-factor=1',
        `--window-size=${size},${size}`,
        `--screenshot=${outPath}`,
        `file:///${htmlPath.replace(/\\/g, '/')}`,
      ],
      { stdio: 'ignore' },
    )
    if (!existsSync(outPath)) fail(`栅格化未产出文件（${size}px）`)
    return readFileSync(outPath)
  } finally {
    rmSync(workDir, { recursive: true, force: true })
  }
}

/** 逐像素比较两个 PNG（要求同尺寸），返回平均绝对差（4 通道） */
function pixelDiff(a, b, label) {
  if (a.width !== b.width || a.height !== b.height)
    fail(`${label} 尺寸不一致：${a.width}×${a.height} vs ${b.width}×${b.height}`)
  let sum = 0
  for (let index = 0; index < a.rgba.length; index += 1) sum += Math.abs(a.rgba[index] - b.rgba[index])
  return sum / a.rgba.length
}

function main() {
  const svgPath = join(PARENT_ASSETS, 'logo.svg')
  const logoPng = join(PARENT_ASSETS, 'logo.png')
  if (!existsSync(svgPath)) fail(`父工程矢量物料缺失：${svgPath}`)
  if (!existsSync(logoPng)) fail(`父工程透明物料缺失：${logoPng}`)
  const reference = decodePng(readFileSync(logoPng), logoPng)

  if (CHECK_ONLY) {
    const stored = decodePng(readFileSync(join(OUT_DIR, 'logo-200-transparent.png')), 'logo-200-transparent.png')
    const diff = pixelDiff(stored, reference, '入库 200px 与父工程 logo.png')
    if (diff > 0) fail(`入库 200px 位图与父工程 logo.png 不一致（平均绝对差 ${diff.toFixed(2)}）——请重跑本脚本`)
    console.log(`${LOG_PREFIX}[brand-material] PASS 入库位图与父工程 logo.png 逐像素一致`)
    return
  }

  const chromium = findChromium()
  console.log(`${LOG_PREFIX}[brand-material] 使用 Chromium: ${chromium}`)
  mkdirSync(OUT_DIR, { recursive: true })

  // 自证：200px 栅格化结果必须与父工程 logo.png 逐像素一致（证明同一图案，而不是「看起来像」）
  const checkBytes = rasterize(chromium, svgPath, 200)
  const check = decodePng(checkBytes, 'chrome-200.png')
  const diff = pixelDiff(check, reference, '栅格化 200px 与父工程 logo.png')
  if (diff > 0) fail(`栅格化 200px 与父工程 logo.png 不一致（平均绝对差 ${diff.toFixed(2)}）——物料可能已变更，请确认`)
  console.log(`${LOG_PREFIX}[brand-material] PASS 200px 栅格化与父工程 logo.png 逐像素一致（平均绝对差 0.00）`)

  for (const target of TARGETS) {
    const bytes = rasterize(chromium, svgPath, target.size)
    const decoded = decodePng(bytes, target.file)
    if (decoded.width !== target.size || decoded.height !== target.size)
      fail(`${target.file} 尺寸不符：${decoded.width}×${decoded.height}`)
    let opaque = 0
    for (let index = 3; index < decoded.rgba.length; index += 4) if (decoded.rgba[index] > 16) opaque += 1
    if (opaque === 0) fail(`${target.file} 全透明（栅格化失败）`)
    const outPath = join(OUT_DIR, target.file)
    writeFileSync(outPath, bytes)
    console.log(
      `${LOG_PREFIX}[brand-material] 写出 ${target.file} ${target.size}×${target.size}（不透明像素 ${((opaque / (target.size * target.size)) * 100).toFixed(1)}%，${bytes.length} 字节）`,
    )
  }
  console.log(`${LOG_PREFIX}[brand-material] 完成：${TARGETS.length} 个透明位图已写入 assets/brand/`)
}

main()
