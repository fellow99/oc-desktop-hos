/**
 * 服务端宿主入口（工程规划 §3.2 / §3.5）。
 *
 * 三种宿主形态共用本文件，由主进程通过环境变量选择：
 *   - inprocess：主进程直接 import 本文件（宿主与主进程同进程，dsh 已验证形态）
 *   - utility  ：主进程 utilityProcess.fork 本文件
 *   - worker   ：主进程 new Worker(本文件)
 *
 * 本文件只做三件事：设 argv → 设环境契约 → 动态 import opencode 的 Node 产物。
 * 服务端以 CLI 语义启动，等价于在设备内执行：
 *   opencode serve --hostname 0.0.0.0 --port <随机>
 * 密码来自 OPENCODE_PASSWORD（v2 强制要求密码，缺失时进程内随机生成）。
 */
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

function report(message) {
  const line = `[oc-desktop][host] ${message}`;
  console.log(line);
  try {
    const { isMainThread, parentPort } = require('node:worker_threads');
    if (!isMainThread && parentPort) parentPort.postMessage(line);
  } catch {
    // worker_threads 不可用（Electron 主进程侧）：忽略
  }
}

const runtimeDir = process.env.OCR_RUNTIME_DIR || path.join(process.env.HOME || __dirname, 'opencode-dist');
const entry = path.join(runtimeDir, 'opencode.mjs');
const port = process.env.OCR_SERVER_PORT || '0';
const hostname = process.env.OCR_SERVER_HOSTNAME || '0.0.0.0';

if (!fs.existsSync(entry)) {
  report(`产物缺失: ${entry}（产物就位阶段未成功，宿主无法启动）`);
  process.exit(1);
}

// 运行时时序产物自带 prelude：它会设置 OPENCODE_NODE_ASSETS_DIR 等资产路径。
// 这里仅补齐宿主侧必需项，避免依赖调用方的环境遗留。
process.env.OPENCODE_NODE_ASSETS_DIR = process.env.OPENCODE_NODE_ASSETS_DIR || path.join(runtimeDir, 'assets');
process.env.OPENCODE_BETTER_SQLITE3_PATH =
  process.env.OPENCODE_BETTER_SQLITE3_PATH || path.join(runtimeDir, 'node_modules', 'better-sqlite3');
process.env.OPENCODE_DISABLE_MODELS_FETCH = process.env.OPENCODE_DISABLE_MODELS_FETCH || '1';
process.env.OPENCODE_FILEWATCHER_DISABLE = process.env.OPENCODE_FILEWATCHER_DISABLE || '1';
process.env.OPENCODE_DISABLE_FFF = process.env.OPENCODE_DISABLE_FFF || '1';

// CLI 语义：serve（mode=default → 常驻，密码取自 OPENCODE_PASSWORD）
process.argv = ['node', 'opencode.mjs', 'serve', '--hostname', hostname, '--port', String(port)];

report(`启动服务端 hostname=${hostname} port=${port} entry=${entry}`);

import(pathToFileURL(entry).href).catch((error) => {
  report(`加载失败: ${error && error.stack ? error.stack : String(error)}`);
  process.exit(1);
});
