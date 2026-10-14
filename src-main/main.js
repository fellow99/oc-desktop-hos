/**
 * OC Desktop —— Electron 主进程（工程规划 §5「运行架构」）。
 *
 * 阶段：环境装配 → 插件物化 → 产物就位 → 启动宿主 → 鉴权引导 → 建窗 → 加载内嵌 UI → 生命周期收尾。
 * 每个阶段都必须可观测（统一 [oc-desktop] 前缀日志 + loading 页阶段文本），禁止「卡住但不说」。
 *
 * 宿主形态三候选（工程规划 §3.2，由 Phase 0 P0-1 探针定标）：
 *   inprocess（默认，dsh 已验证形态）| utility（utilityProcess.fork）| worker（worker_threads）
 * 通过 OCR_HOST_MODE 切换；三者共用 sidecar.js 作为入口。
 *
 * 渲染通道（工程规划 §3.3）：
 *   chromium（默认，可用性回退基线）| arkweb（目标形态：由 ArkTS 侧 Web 组件承载，主进程不建窗）
 */
'use strict';

// ─── 启动期自证（必须早于任何可能触发原生崩溃的调用）────────────────────────────
// 真机教训：崩溃若发生在「探针」里，进程会 SIGSEGV，连一条日志都来不及写，
// 于是所有可观测面（trace / 状态文件 / hilog）全是空白，无法区分「没跑」与「跑到一半崩了」。
// 因此这里用最小依赖（仅 node:fs）先把「main.js 已被加载」落盘，再继续后面的初始化。
try {
  require('node:fs').appendFileSync(
    process.env.OCR_TRACE_FILE || '/data/storage/el2/base/files/ocr-trace.log',
    `${new Date().toISOString()} BOOT main.js loaded pid=${process.pid}\n`,
  );
} catch {}

const { app, BrowserWindow, session } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { ensureExtracted, readMarker } = require('./tar-extract.js');

const LOG = '[oc-desktop]';
// 真机上 console.error 不入 hilog：日志与异常必须同时落盘，否则失败既不可见也不可查。
const DEFAULT_TRACE_FILE = '/data/storage/el2/base/files/ocr-trace.log';
/** trace 体积上限：真机长期运行不能无限追加；超过即轮换成单份 .1 */
const TRACE_MAX_BYTES = Number(process.env.OCR_TRACE_MAX_BYTES || 4 * 1024 * 1024);
const TRACE_FILE = process.env.OCR_TRACE_FILE || DEFAULT_TRACE_FILE;
/**
 * 启动状态文件（应用域可写、`sh` 域可读 0666）。
 *
 * 为什么必须落文件：真机上 `console.error` 不入 hilog，而加载页在就绪后已被真实 UI 取代，
 * 于是「插件物化失败」与「一切正常」在所有可观测面上完全一样。该文件是设备侧唯一能区分二者的证据
 * （FR-tool-018 的 fail-visible 要求）。
 */
const STARTUP_STATUS_FILE =
  process.env.OCR_STARTUP_STATUS_FILE || '/data/storage/el2/base/files/ocr-startup-status.json';
const trace = (level, args) => {
  try {
    rotateTraceIfNeeded();
    fs.appendFileSync(TRACE_FILE, `${new Date().toISOString()} ${level} ${args.map((a) => (a && a.stack) || String(a)).join(' ')}\n`);
  } catch {}
};
/** 超过上限就把当前 trace 改名为 .1（覆盖旧 .1），避免无限增长 */
function rotateTraceIfNeeded() {
  try {
    if (fs.statSync(TRACE_FILE).size <= TRACE_MAX_BYTES) return;
    fs.renameSync(TRACE_FILE, `${TRACE_FILE}.1`);
  } catch {}
}
const log = (...args) => {
  trace('LOG', args);
  console.log(LOG, ...args);
};
const fail = (stage, error) => {
  const message = error && error.stack ? error.stack : String(error);
  trace('FAIL', [`[${stage}]`, message]);
  console.error(`${LOG}[${stage}] 失败: ${message}`);
  // 累积而不是覆盖：`__ocError` 保留最后一条（历史行为，兼容），`__ocErrors` 保留全部 ——
  // 否则「先失败、后成功」会把失败证据丢掉。
  const entry = { stage, message, at: new Date().toISOString() };
  globalThis.__ocError = entry;
  if (!Array.isArray(globalThis.__ocErrors)) globalThis.__ocErrors = [];
  globalThis.__ocErrors.push(entry);
  writeStartupStatus();
  return message;
};
/** 把累积的失败落成可读状态文件（见 STARTUP_STATUS_FILE 的说明） */
function writeStartupStatus() {
  try {
    const errors = Array.isArray(globalThis.__ocErrors) ? globalThis.__ocErrors : [];
    fs.writeFileSync(
      STARTUP_STATUS_FILE,
      `${JSON.stringify({ ok: errors.length === 0, stage: currentStage, errors, updatedAt: new Date().toISOString() }, null, 2)}\n`,
      { mode: 0o666 },
    );
  } catch {}
}
process.on('uncaughtException', (error) => trace('UNCAUGHT_EXCEPTION', [error]));
process.on('unhandledRejection', (reason) => trace('UNHANDLED_REJECTION', [reason]));

/**
/**
 * 设备运行时能力自证（Unicode 属性转义）。
 *
 * 为什么需要：上游产物在**模块初始化期**就会构造 `/^\p{Emoji}\p{Mark}*$/u` 这类正则
 * （`string-width`）；一旦设备的 ICU/Unicode 数据不完整，服务端产物会**import 即失败**，
 * 表现为「白屏」且 hilog 里看不出原因。把这条事实在启动时落进 trace，失败才可查。
 *
 * 真机实测（2026-10-14，设备 OpenHarmony-7.0.0.105 / API 26）：
 *   - 本应用曾因为 resfile 下 `icudtl.dat` 被 CRLF 归一化损坏（−51 B）而**全面失去 ICU 能力**：
 *     `\p{Emoji}` → `Invalid property name`，`new Intl.Collator()` → `RangeError: Internal error. Icu error.`；
 *   - 修好 `icudtl.dat` 后，`\p{L}` / `\p{Mark}` / `\p{Nd}` / `\p{Z}` / `\p{Cc}` / `\p{Script=Latin}`
 *     与 `\p{Emoji}` / `\p{Emoji_Presentation}` / `\p{Emoji_Component}` / `\p{Extended_Pictographic}`
 *     全部可用，原生 `Intl.Collator` / `Intl.Segmenter` / `Intl.DateTimeFormat` / `Intl.NumberFormat`
 *     （含显式 locale）也全部可用。
 *
 * 结论与边界：**设备 ICU 本身完整，不做任何兜底替换**。本函数只做 Unicode 属性转义探测 ——
 * 这类调用即使属性名非法也只会抛**可捕获**的 SyntaxError。绝不在此探测 Intl：在 ICU 数据损坏的
 * 设备上，`new Intl.Segmenter(...)` 会让进程**原生崩溃**（SIGSEGV，连一条日志都来不及写），
 * 即「探测本身就会打死应用」；Intl 是否可用交给上游产物自己的使用路径暴露（fail-visible）。
 */
function probeRuntimeCapabilities() {
  const properties = [
    'Emoji',
    'Emoji_Presentation',
    'Emoji_Component',
    'Extended_Pictographic',
    'Default_Ignorable_Code_Point',
    'Mark',
    'L',
    'Nd',
    'Z',
    'Cc',
    'Script=Latin',
  ];
  const result = {};
  for (const property of properties) {
    try {
      new RegExp(`\\p{${property}}`, 'u');
      result[property] = 'ok';
    } catch (error) {
      result[property] = `FAIL(${error && error.message})`;
    }
  }
  trace('UNICODE_PROPERTY_PROBE', [JSON.stringify(result)]);
  log(`[探针] Unicode 属性转义：${JSON.stringify(result)}`);
}

/**
 * 阶段状态机（loading 页据此显示；fail-visible）。
 * 每个阶段都有明确出口，失败即停在该阶段并把原因写进 __ocError。
 */
const STAGES = {
  ENV: '环境装配',
  PLUGINS: '插件物化',
  ARTIFACT: '产物就位',
  HOST: '启动服务端宿主',
  AUTH: '鉴权引导',
  WINDOW: '创建窗口',
  LOAD: '加载界面',
  READY: '就绪',
};
let currentStage = STAGES.ENV;

// ------------------------------------------------------------------ 配置

const APP_HOME = app.getPath('userData');
const TMP_DIR = path.join(APP_HOME, 'tmp');
const DATA_DIR = path.join(APP_HOME, 'data');
const RUNTIME_DIR = path.join(APP_HOME, 'opencode-dist');
const CACHE_DIR = path.join(APP_HOME, 'cache');
const CONFIG_DIR = path.join(APP_HOME, 'config');
const STATE_DIR = path.join(APP_HOME, 'state');
/** 包内插件源码（resfile/resources/app/plugins，由 scripts/collect-app.mjs 投放） */
const PACKAGED_PLUGINS_DIR = path.join(__dirname, 'plugins');
/** 插件物化目标：XDG_CONFIG_HOME=<userData>/config ⇒ opencode 的全局配置目录为 <userData>/config/opencode */
const PLUGIN_DIR = path.join(CONFIG_DIR, 'opencode', 'plugin');
const CONNECTION_FILE = path.join(APP_HOME, 'ocr-connection.json');

const HOST_MODE = process.env.OCR_HOST_MODE || 'inprocess'; // inprocess | utility | worker
const RENDER_MODE = process.env.OCR_RENDER_MODE || 'chromium'; // chromium | arkweb
const LOAD_TIMEOUT_MS = Number(process.env.OCR_LOAD_TIMEOUT_MS || 30_000);
const SERVER_PASSWORD = process.env.OPENCODE_PASSWORD || crypto.randomBytes(32).toString('base64url');

let serverPort = Number(process.env.OCR_SERVER_PORT || 0);
let lanAddress = '127.0.0.1';
let sessionToken = null;
let hostHandle = null;
let mainWindow = null;

// ------------------------------------------------------------------ 阶段 1：环境装配

/**
 * 沙箱映射（工程规划 §5.3）：真机上 homedir 不可写、/tmp 与 os.tmpdir() 不可写、TMPDIR 无效，
 * 因此必须显式改写 HOME/XDG_* 并 monkey-patch os.tmpdir()。
 */
function configureEnvironment() {
  currentStage = STAGES.ENV;
  for (const dir of [TMP_DIR, DATA_DIR, CACHE_DIR, CONFIG_DIR, STATE_DIR, RUNTIME_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  process.env.HOME = APP_HOME;
  process.env.USERPROFILE = APP_HOME;
  process.env.XDG_DATA_HOME = DATA_DIR;
  process.env.XDG_CACHE_HOME = CACHE_DIR;
  process.env.XDG_CONFIG_HOME = CONFIG_DIR;
  process.env.XDG_STATE_HOME = STATE_DIR;
  process.env.TMPDIR = TMP_DIR;
  process.env.TEMP = TMP_DIR;
  process.env.TMP = TMP_DIR;

  // 真机上 TMPDIR 对 Node 无效：必须直接改 os.tmpdir 的实现
  os.tmpdir = () => TMP_DIR;

  // 服务端契约（工程规划 §3.5 / §5.3）：密码必填；离线快照；关闭 filewatcher 与 fff（设备不可用）
  process.env.OPENCODE_PASSWORD = SERVER_PASSWORD;
  delete process.env.OPENCODE_SERVER_PASSWORD;
  process.env.OPENCODE_CLIENT = 'desktop';
  process.env.OPENCODE_DISABLE_MODELS_FETCH = process.env.OPENCODE_DISABLE_MODELS_FETCH || '1';
  process.env.OPENCODE_FILEWATCHER_DISABLE = process.env.OPENCODE_FILEWATCHER_DISABLE || '1';
  process.env.OPENCODE_DISABLE_FFF = process.env.OPENCODE_DISABLE_FFF || '1';
  process.env.OPENCODE_NODE_ASSETS_DIR = path.join(RUNTIME_DIR, 'assets');

  // 原生 SQLite 绑定位于运行时时序产物内（.node 不能从 resfile 目录 dlopen，见工程规划 §3.6）
  process.env.OPENCODE_BETTER_SQLITE3_PATH =
    process.env.OPENCODE_BETTER_SQLITE3_PATH || path.join(RUNTIME_DIR, 'node_modules', 'better-sqlite3');

  // 代理/回环：本机回环被网络隔离拦截，必须走局域网地址并绕过代理
  const bypass = [process.env.NO_PROXY, lanAddress, '127.0.0.1', 'localhost'].filter(Boolean).join(',');
  process.env.NO_PROXY = bypass;
  process.env.no_proxy = bypass;

  log(`[${currentStage}] HOME=${APP_HOME}`);
  log(`[${currentStage}] XDG_DATA_HOME=${DATA_DIR} TMPDIR=${TMP_DIR}`);
}


// ------------------------------------------------------------------ 阶段 1.5：插件物化

/**
 * 插件物化（工程规划 §3.9 / specs/102-harmony-js-tools FR-tool-016…019）。
 *
 * opencode 只扫描**配置目录**下的 `plugin/` 与 `plugins/`；包内 `resfile/resources/app/plugins/`
 * 不在配置目录集合内，因此启动期必须 **copy** 到 `<userData>/config/opencode/plugin/<oc-plugin-name>/`。
 *   - 禁 symlink：真机同域 `symlink` 报 EACCES（doc 能力清单 #5）；
 *   - 幂等可重复：同名目标目录先删再写，避免旧版本文件残留；
 *   - 失败可见：经 fail() 写日志 + globalThis.__ocError（loading 页/ArkTS 侧可读），**不阻塞**启动
 *     （插件缺席只降级工具能力，不得回归「启动就绪 / 会话可建」）。
 */
function materializePlugins() {
  currentStage = STAGES.PLUGINS;
  if (!fs.existsSync(PACKAGED_PLUGINS_DIR)) {
    fail(currentStage, new Error(`包内插件目录缺失: ${PACKAGED_PLUGINS_DIR}（请先运行 scripts/collect-app.mjs）`));
    return;
  }
  const plugins = fs
    .readdirSync(PACKAGED_PLUGINS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  if (plugins.length === 0) {
    fail(currentStage, new Error(`包内插件目录为空: ${PACKAGED_PLUGINS_DIR}`));
    return;
  }
  let materialized = 0;
  for (const name of plugins) {
    const source = path.join(PACKAGED_PLUGINS_DIR, name);
    const target = path.join(PLUGIN_DIR, name);
    try {
      fs.mkdirSync(PLUGIN_DIR, { recursive: true });
      fs.rmSync(target, { recursive: true, force: true });
      fs.cpSync(source, target, { recursive: true, force: true });
      if (!fs.existsSync(path.join(target, 'index.js'))) throw new Error('物化后缺少 index.js');
      materialized += 1;
      log(`[${currentStage}] ${name} → ${target}`);
    } catch (error) {
      fail(currentStage, error);
    }
  }
  log(`[${currentStage}] 完成：${materialized}/${plugins.length} 个插件已就位（${PLUGIN_DIR}）`);
}

// ------------------------------------------------------------------ 阶段 2：产物就位

async function bootstrapArtifact() {
  currentStage = STAGES.ARTIFACT;
  const result = await ensureExtracted({
    runtimeDir: RUNTIME_DIR,
    archive: process.env.OCR_DIST_ARCHIVE || null,
    onProgress: (message) => log(`[${currentStage}] ${message}`),
  });
  log(`[${currentStage}] ${result.extracted ? '已解压' : '跳过解压'}（marker=${result.marker}）`);
}

// ------------------------------------------------------------------ 阶段 3：启动宿主

/** 选一个空闲端口：先绑 0 取得系统分配端口再释放（避免与既有服务抢占） */
function pickPort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '0.0.0.0', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/** 取非 internal 的 IPv4 作为渲染层访问地址（回环隔离，工程规划 §5.4） */
function pickLanAddress() {
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address;
    }
  }
  return '127.0.0.1';
}

function startHost() {
  currentStage = STAGES.HOST;
  const sidecar = path.join(__dirname, 'sidecar.js');
  const env = {
    ...process.env,
    OCR_SERVER_PORT: String(serverPort),
    OCR_SERVER_HOSTNAME: process.env.OCR_SERVER_HOSTNAME || '0.0.0.0',
    OCR_RUNTIME_DIR: RUNTIME_DIR,
  };

  if (HOST_MODE === 'utility') {
    const { utilityProcess } = require('electron');
    hostHandle = utilityProcess.fork(sidecar, [], { env, stdio: 'inherit' });
    hostHandle.on('exit', (code) => log(`[${currentStage}] utility 进程退出 code=${code}`));
    log(`[${currentStage}] utilityProcess.fork pid=${hostHandle.pid}`);
    return Promise.resolve();
  }

  if (HOST_MODE === 'worker') {
    const { Worker } = require('node:worker_threads');
    hostHandle = new Worker(sidecar, { env, workerData: { mode: 'worker' } });
    hostHandle.on('error', (error) => fail(currentStage, error));
    log(`[${currentStage}] worker_threads 已启动 threadId=${hostHandle.threadId}`);
    return Promise.resolve();
  }

  // inprocess：宿主与主进程同进程（dsh 已在真机长期验证的形态）
  process.argv = ['node', 'opencode.mjs', 'serve', '--hostname', '0.0.0.0', '--port', String(serverPort)];
  hostHandle = { mode: 'inprocess' };
  const entry = path.join(RUNTIME_DIR, 'opencode.mjs');
  if (!fs.existsSync(entry)) {
    return Promise.reject(new Error(`服务端产物缺失: ${entry}（请先运行 scripts/build-opencode.mjs）`));
  }
  log(`[${currentStage}] 进程内加载 ${entry}`);
  return import(pathToFileURL(entry).href)
    .then((loaded) => {
      trace('IMPORT_RESOLVED', [`exports=${Object.keys(loaded).length}`]);
      return loaded;
    })
    .catch((error) => {
      fail(currentStage, error);
      throw error;
    });
}

// ------------------------------------------------------------------ 阶段 4：鉴权引导

function basicAuthHeader(password = SERVER_PASSWORD) {
  return `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;
}

async function fetchJson(url, init = {}) {
  const response = await fetch(url, {
    ...init,
    headers: { authorization: basicAuthHeader(), accept: 'application/json', ...(init.headers || {}) },
  });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: response.status, body, headers: response.headers };
}

/** 等待服务端就绪：GET /api/info（v2 的健康/版本端点，工程规划 §2.1） */
async function waitForHealth() {
  const deadline = Date.now() + LOAD_TIMEOUT_MS;
  const url = `http://${lanAddress}:${serverPort}/api/info`;
  while (Date.now() < deadline) {
    try {
      const { status, body } = await fetchJson(url);
      if (status === 200) {
        log(`[${currentStage}] /api/info 就绪 version=${body && body.version} pid=${body && body.pid}`);
        return body;
      }
    } catch (error) {
      // 服务端尚未监听：继续重试，超时后统一报错
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`服务端在 ${LOAD_TIMEOUT_MS}ms 内未就绪: ${url}`);
}

/**
 * 鉴权引导（工程规划 §5.4）。
 * v2 的浏览器侧鉴权是「配对码 → 会话 Cookie」（packages/server/src/handlers/server.ts#server.connect：
 * /auth/connect/{code} 以 HTML 导航返回 Set-Cookie: opencode_session_<port>，httpOnly/sameSite=lax），
 * 会话令牌与密码等价（packages/server/src/auth.ts）。因此这里：
 *   ① POST /api/pair（Basic 密码）取配对码；
 *   ② 消费配对码换令牌；
 *   ③ 把令牌写入 Electron 会话 Cookie，使渲染层后续 /api/* 请求自动携带凭据（无需 Host/Origin 改写）。
 * 令牌同时写入 ocr-connection.json 供 ArkWeb（R2）与 ArkTS 侧使用（⬜ P0-2 探针验证 ArkWeb 侧通道）。
 */
async function bootstrapAuth() {
  currentStage = STAGES.AUTH;
  const base = `http://${lanAddress}:${serverPort}`;
  const pairing = await fetchJson(`${base}/api/pair`, { method: 'POST' });
  if (pairing.status !== 200 || !pairing.body || typeof pairing.body.code !== 'string') {
    throw new Error(`取配对码失败（HTTP ${pairing.status}）`);
  }
  const connect = await fetchJson(`${base}/auth/connect/${encodeURIComponent(pairing.body.code)}`, {
    method: 'POST',
    headers: { accept: 'application/json' },
  });
  if (connect.status === 200 && connect.body && typeof connect.body.token === 'string') {
    sessionToken = connect.body.token;
    log(`[${currentStage}] 已取得会话令牌（与密码等价，用于渲染层凭据）`);
  } else {
    // 退路：配对通道不可用时回落到 Basic 注入（§5.4 的兜底路径）
    log(`[${currentStage}] 配对通道未返回令牌（HTTP ${connect.status}），回落到 Basic 凭据注入`);
  }

  fs.writeFileSync(
    CONNECTION_FILE,
    `${JSON.stringify(
      {
        url: `http://${lanAddress}:${serverPort}/`,
        host: lanAddress,
        port: serverPort,
        hostMode: HOST_MODE,
        renderMode: RENDER_MODE,
        cookieName: `opencode_session_${serverPort}`,
        password: sessionToken || SERVER_PASSWORD,
        passwordKind: sessionToken ? 'session-token' : 'server-password',
        pid: process.pid,
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  log(`[${currentStage}] 连接信息已写入 ${CONNECTION_FILE}（含凭据，权限 0600）`);
}

/** 给渲染层装凭据：优先 Cookie（v2 原生），兜底改写 Basic 头 */
function installRendererCredentials() {
  const cookieName = `opencode_session_${serverPort}`;
  const credentials = sessionToken || SERVER_PASSWORD;
  if (sessionToken) {
    return session.defaultSession.cookies
      .set({
        url: `http://${lanAddress}:${serverPort}/`,
        name: cookieName,
        value: sessionToken,
        path: '/',
        httpOnly: true,
        sameSite: 'lax',
      })
      .then(() => log(`[${STAGES.AUTH}] 已写入渲染层会话 Cookie ${cookieName}`))
      .catch((error) => log(`[${STAGES.AUTH}] 写 Cookie 失败(${error.message})，转用 Basic 头注入`));
  }
  session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
    const url = new URL(details.url);
    if (url.hostname === lanAddress && Number(url.port) === serverPort) {
      details.requestHeaders.authorization = basicAuthHeader(credentials);
    }
    callback({ requestHeaders: details.requestHeaders });
  });
  return Promise.resolve(log(`[${STAGES.AUTH}] 已安装 Basic 凭据注入钩子（兜底路径）`));
}

// ------------------------------------------------------------------ 阶段 5/6：建窗与加载

function loadingPageHtml(stageText, detail) {
  const html = `<!doctype html>
<meta charset="utf-8" />
<title>OC Desktop</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; height: 100vh; display: flex; align-items: center; justify-content: center;
         font: 14px/1.6 system-ui, "HarmonyOS Sans SC", sans-serif; background: #14161a; color: #e6e8eb; }
  .box { text-align: center; max-width: 520px; padding: 0 24px; }
  .title { font-size: 20px; font-weight: 600; margin-bottom: 8px; }
  .stage { color: #8b93a1; }
  .detail { margin-top: 16px; font-size: 12px; color: #6b7280; white-space: pre-wrap; }
  .bar { margin-top: 20px; height: 4px; border-radius: 2px; background: #23262c; overflow: hidden; }
  .bar > i { display: block; width: 40%; height: 100%; background: #1f6feb; animation: slide 1.2s ease-in-out infinite; }
  @keyframes slide { 0% { margin-left: -40%; } 100% { margin-left: 100%; } }
</style>
<div class="box">
  <div class="title">OC Desktop</div>
  <div class="stage">${stageText}</div>
  <div class="bar"><i></i></div>
  ${detail ? `<div class="detail">${detail}</div>` : ''}
</div>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

/**
 * 建窗（窗口尺寸 = App 的可见分辨率）。
 *
 * 尺寸来源：`OCR_WINDOW_WIDTH` / `OCR_WINDOW_HEIGHT`（默认 **1280×720**）。
 * 为什么改默认：需求要求「把 App 分辨率设为 1280x720」——这是 UI 走查/截图的常用基准尺寸。
 * 作用机制：runtime 的 `web_engine/src/main/ets/adapter/AppWindowAdapter.ets` 会把 Electron 窗口的
 * bounds 映射到 HarmonyOS 窗口（`windowClass.resize(bounds.width, bounds.height, ...)`），
 * 因此这里改尺寸即改 App 的可见窗口分辨率。
 */
function createWindow() {
  currentStage = STAGES.WINDOW;
  const width = Number(process.env.OCR_WINDOW_WIDTH || 1280);
  const height = Number(process.env.OCR_WINDOW_HEIGHT || 720);
  log(`[${currentStage}] 建窗 ${width}×${height}`);
  mainWindow = new BrowserWindow({
    width,
    height,
    // 最小尺寸不得大于建窗尺寸，否则系统会按最小值撑开（截取 1280×720 会失败）
    minWidth: Math.min(960, width),
    minHeight: Math.min(640, height),
    title: 'OC Desktop',
    backgroundColor: '#14161a',
    show: true,
    autoHideMenuBar: true,
    webPreferences: {
      // 内嵌 UI 与 API 同源，不需要 preload 桥（工程规划 §3.3/§4.3）
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  return mainWindow;
}

async function loadRenderer() {
  currentStage = STAGES.LOAD;
  const target = `http://${lanAddress}:${serverPort}/`;
  if (RENDER_MODE === 'arkweb') {
    // R2：UI 由 ArkTS 的 ArkWeb Web 组件承载，主进程只负责把地址与凭据交给 ArkTS（见 ocr-connection.json）
    log(`[${currentStage}] ArkWeb 模式：等待 ArkTS 侧加载 ${target}（主进程不建渲染窗口）`);
    currentStage = STAGES.READY;
    return;
  }
  const window = createWindow();
  await window.loadURL(loadingPageHtml(`${currentStage}：${STAGES.LOAD}`, target));
  await window.loadURL(target);
  // 应用域自证：把窗口**实际** bounds 落进 trace（真机 sh 域可读），用于客观核对分辨率
  try {
    const bounds = window.getBounds();
    const content = window.getContentBounds();
    log(`[${currentStage}] 窗口实际尺寸 bounds=${JSON.stringify(bounds)} content=${JSON.stringify(content)}`);
  } catch (error) {
    log(`[${currentStage}] 读取窗口尺寸失败：${error && error.message}`);
  }
  currentStage = STAGES.READY;
  log(`[${currentStage}] 界面已加载 ${target}`);
}

// ------------------------------------------------------------------ 生命周期

function shutdown(reason) {
  log(`收尾：${reason}`);
  try {
    if (hostHandle && typeof hostHandle.kill === 'function') hostHandle.kill();
    else if (hostHandle && typeof hostHandle.terminate === 'function') hostHandle.terminate();
  } catch (error) {
    log(`收尾失败（忽略）：${error.message}`);
  }
}

async function main() {
  // 启动即落一份「暂无失败」的状态文件：让设备侧能区分「没有失败」与「状态文件从未写出」
  // Unicode 属性转义自证必须在导入服务端产物之前：上游产物在**模块初始化期**就会构造 `\p{...}` 正则
  probeRuntimeCapabilities();
  writeStartupStatus();
  writeStartupStatus();
  // 渲染层地址与端口在 app ready 前确定：Chromium 的安全来源开关只能在 ready 前设置
  lanAddress = process.env.OCR_LAN_ADDRESS || pickLanAddress();
  serverPort = serverPort || (await pickPort());
  app.commandLine.appendSwitch('proxy-bypass-list', '<-loopback>');
  // http://<局域网IP>:<端口> 不是安全上下文，显式提升为可信来源（工程规划 §5.4）
  app.commandLine.appendSwitch('unsafely-treat-insecure-origin-as-secure', `http://${lanAddress}:${serverPort}`);

  configureEnvironment();

  await app.whenReady();
  configureEnvironment(); // app.getPath 在 ready 后才稳定，重复一次保证 HOME/XDG 指向 userData

  materializePlugins(); // 插件必须在服务端启动前就位（opencode 只在启动时做插件发现）
  await bootstrapArtifact();
  await startHost();
  await waitForHealth();
  await bootstrapAuth();
  await installRendererCredentials();
  await loadRenderer();
}

try {
  if (!app.requestSingleInstanceLock()) app.quit();
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => shutdown('before-quit'));
  app.on('will-quit', () => shutdown('will-quit'));
  app.whenReady().then(main).catch((error) => {
    const message = fail(currentStage, error);
    if (mainWindow) {
      mainWindow.loadURL(loadingPageHtml(`${currentStage} 失败`, message));
    }
  });
} catch (error) {
  fail(STAGES.ENV, error);
  app.quit();
}

module.exports = { readMarker };
