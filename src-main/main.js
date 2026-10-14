/**
 * OC Desktop —— Electron 主进程（工程规划 §5「运行架构」）。
 *
 * 阶段：环境装配 → 插件物化 → 产物就位 → 启动宿主 → 鉴权引导 → 建窗 → 加载内嵌 UI → 生命周期收尾。
 * 每个阶段都必须可观测（统一 [oc-desktop] 前缀日志 + loading 页阶段文本），禁止「卡住但不说」。
 *
 * 宿主形态三候选（工程规划 §3.2，由 Phase 0 P0-1 探针定标）：
 *   inprocess（默认，dsh 已验证形态）| utility（utilityProcess.fork）| worker（worker_threads）
 * 通过 OCR_HOST_MODE 切换；utility / worker 走 sidecar.js，inprocess（默认）由本文件直接 import 产物。
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

  // 设备侧**没有 `/bin/sh`**：OpenHarmony 的应用域里 `/bin` 不可读，`stat('/bin/sh')` 直接抛
  // `EACCES`（不是 ENOENT —— 上游 `stat` 的 `throwIfNoEntry` 兜不住 EACCES，已由补丁
  // `patches/v2.0.26/0006-shell-select-ohos.patch` 在 `ShellSelect.stat` 内兜住）。
  // 后果很隐蔽：opencode 在**每次模型请求前**解析 shell
  // （`SessionModelRequest.prepare → environment() → select(process.env.SHELL) → executable → stat`），
  // 于是会话能建、用户消息能进、SSE 也连得上，但助手**永远不回复**，日志只有
  // `ERROR "Failed to drain Session" cause="EACCES: permission denied, stat '/bin/sh'"`。
  // 应用域真正可用的是 `/system/bin/sh`（插件 `oc-plugin-harmony-shell` 就是为它写的）。
  // 三重保证（可用 OCR_SHELL 覆盖）：① SHELL 指向它，stat 可读时 `select` 直接返回；
  // ② `OC_SHELL_FALLBACK` 让 0006 的 `fallback()` 在 stat 不可读时仍回落到它；
  // ③ `/system/bin` 入 PATH，避免 `fallback()` 的 `which('bash')` 找空后落到不可用的 `/bin/sh`。
  process.env.SHELL = process.env.OCR_SHELL || '/system/bin/sh';
  process.env.OC_SHELL_FALLBACK = process.env.OCR_SHELL || '/system/bin/sh';
  const systemBins = ['/system/bin'];
  const pathParts = (process.env.PATH || '').split(':').filter(Boolean);
  for (const dir of systemBins.reverse()) {
    if (!pathParts.includes(dir)) pathParts.unshift(dir);
  }
  process.env.PATH = pathParts.join(':');

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

/**
 * 设备侧 `better-sqlite3` 原生模块缺陷兜底（真机实测 2026-10-14，属**依赖缺陷**，非上游逻辑问题）。
 *
 * 现象：aarch64-ohos 预编译的 `better_sqlite3.node`（来自发行侧 `better-sqlite3-ohos-v138.tar.gz`，
 * 与 JS 半边同为 12.4.5、哈希一致）在读 **SQL NULL** 时返回整数 **98304**（0x18000），而不是 `null`。
 * 证据链：
 *   - 同一份产物 + 同一 JS 代码在 host 侧 better-sqlite3 12.4.5 上返回 `null`（复现脚本见测试记录）；
 *   - 设备侧 SQL 自身 `SELECT quote(vcs), typeof(vcs) FROM project` → `'NULL' / 'null'`，
 *     说明**存进去的就是 NULL**，是「读」被歪曲；
 *   - `SELECT * FROM project` 里所有可空列（vcs / name / icon_url / time_initialized …）都读出 98304。
 * 后果：`Project.vcs`、`Session.parent_id` 等可空字段读出 98304 ⇒ effect schema 校验失败 ⇒
 *   `GET /api/project` 400、`POST /api/session` 500（UI 只显示「服务器请求失败 HTTP 500」），
 *   表现为「能连上模型、一句话都发不出去」。
 *
 * 处置（与工程既有做法一致：`os.tmpdir()` 同样是壳侧 monkey-patch）：
 *   在本进程内、且**仅当自检确认存在该缺陷时**，把语句结果的取值归一化：
 *   只对**声明类型为 TEXT/BLOB**（亲和 TEXT）的列把该哨兵还原成 `null` —— 这类列上出现数值
 *   本来就不可能是合法值，因此该还原是**有原则的**，不会把真实数据误判为 NULL；
 *   其它列（例如可空的 INTEGER 时间戳）不做猜测，保持原值（已在能力清单登记为已知偏差）。
 *   根因修复仍应由发行侧重编/更换该 `.node`（仓库内 `better-sqlite3编译指南.md` + headers 已备）。
 *   覆盖范围（如实登记）：只包 `Statement.prototype.all` —— 服务端数据路径（`#sqlite` 的 ohos
 *   变体）只有 `all`/`run`，真机 `GET /api/project`、`POST /api/session` 都走 `all`；
 *   `get()` / `iterate()` **未覆盖**（TUI 编辑器的 `#zed-sqlite` 走 `get`，本工程设备上无终端，
 *   该面不启用）。若将来在设备上启用 TUI 编辑器，这里需要一并覆盖。
 *   形态限制：只在**本进程**生效（`OCR_HOST_MODE=utility`/`worker` 时服务端跑在 `sidecar.js`
 *   子进程/worker 里，本补丁不随过去），因此那两个宿主形态下 NULL 缺陷仍会复现 ——
 *   已登记为已知限制（默认与已验证形态是 `inprocess`）。
 */
function patchBetterSqlite3NullBug() {
  const candidates = [
    process.env.OPENCODE_BETTER_SQLITE3_PATH,
    path.join(RUNTIME_DIR, 'node_modules', 'better-sqlite3'),
    'better-sqlite3',
  ].filter(Boolean);
  // 取候选导出的构造函数：目录形态导出构造函数本身，而 env 直接指向 `.node` 时拿到的是
  // 原生 addon 的导出对象（`{ Database }` / `{ default }`）—— 后者必须在**同一个循环内**归一化，
  // 否则「首次 require 成功」就 break 会让自检在拿到非构造函数时静默放弃（日志还会误导成
  // 「未能加载 better-sqlite3」），NULL 兜底就不生效了。
  const asConstructor = (loaded) => {
    if (typeof loaded === 'function') return loaded;
    if (loaded && typeof loaded === 'object') {
      if (typeof loaded.Database === 'function') return loaded.Database;
      if (typeof loaded.default === 'function') return loaded.default;
    }
    return null;
  };
  let Database = null;
  for (const specifier of candidates) {
    try {
      Database = asConstructor(require(specifier));
    } catch {
      Database = null;
    }
    if (Database) break;
  }
  if (!Database) {
    log('[依赖兜底] 未能加载 better-sqlite3，跳过 NULL 缺陷自检');
    return;
  }

  let sentinel;
  let Statement;
  try {
    const probe = new Database(':memory:');
    const statement = probe.prepare('SELECT NULL AS v');
    const row = statement.get();
    Statement = statement.constructor;
    probe.close();
    if (row && row.v === null) {
      log('[依赖兜底] better-sqlite3 NULL 语义正常，未做任何改写');
      return;
    }
    sentinel = row && row.v;
  } catch (error) {
    log(`[依赖兜底] NULL 自检失败（跳过改写）：${error && error.message}`);
    return;
  }
  if (!Statement || typeof Statement.prototype.all !== 'function') {
    log('[依赖兜底] 未取到 Statement 原型，跳过改写');
    return;
  }

  const patchStats = {
    calls: 0,
    conversions: 0,
    columnsLen: null,
    touched: new Set(),
    firstRowLogged: false,
    degenerateLogged: false,
  };

  const seen = new WeakSet();
  const applyNullFix = (DatabaseClass) => {
    if (typeof DatabaseClass !== 'function') return;
    // 幂等 + 不重复建内存库：探测用的 `new DatabaseClass(':memory:')` 必须能取到拥有 `prepare`
    // 的那个构造函数才有意义，且**必须 close**（此前每次 require 都会泄漏一个连接与一条语句）。
    if (seen.has(DatabaseClass)) return;
    seen.add(DatabaseClass);
    let Klass = null;
    let probe = null;
    try {
      probe = new DatabaseClass(':memory:');
      Klass = probe.prepare('SELECT 1').constructor;
    } catch {
      Klass = null;
    } finally {
      if (probe) {
        try {
          probe.close();
        } catch {
          // 探测库关闭失败无关紧要：不阻断补丁
        }
      }
    }
    if (!Klass || typeof Klass.prototype.all !== 'function' || Klass.prototype.all.__ocNullFix === true) return;
    const originalAll = Klass.prototype.all;
    const wrapped = function all(...params) {
      const rows = originalAll.apply(this, params);
      let columns = [];
      try {
        columns = this.columns() || [];
      } catch {
        columns = [];
      }
      // 亲和判定只按 SQLite 规则取 TEXT 亲和（CHAR/CLOB/TEXT）；**不**把空声明类型当作 TEXT
      // （SQLite 里「无声明类型」是 BLOB 亲和，且本工程 schema 的列全部显式声明类型）。
      const affinity = (declared) => /CHAR|CLOB|TEXT/i.test(String(declared || ''));
      // 退化为「按哨兵值判定」的情形（`columns()` 不可用或返回空）：真机 trace 显示真实的
      // `project` 查询里 `columns()` 是有内容的（`columns()=1`、命中列恰好是可空 TEXT 列），
      // 因此退化路径不是常态；但一旦走到这里就无法区分类型，只能按哨兵值改写 ——
      // 取舍：**宁可保留兜底**（否则 `GET /api/project` 400 / `POST /api/session` 500 会复活），
      // 代价是「`columns()` 不可用 + 该列合法值恰为哨兵 98304」会被误写为 null；
      // 因此退化路径**显式落 trace**（含累计次数），出现误判可一眼看见。
      patchStats.calls += 1;
      patchStats.columnsLen = columns.length;
      const degenerate = columns.length === 0;
      const touched = new Set();
      for (const row of rows) {
        if (Array.isArray(row)) {
          for (let index = 0; index < row.length; index += 1) {
            const allowed = degenerate || (columns[index] && affinity(columns[index].type));
            if (allowed && row[index] === sentinel) {
              row[index] = null;
              touched.add(`#${index}`);
            }
          }
        } else if (row && typeof row === 'object') {
          const names = columns.length ? columns.map((column) => column.name) : Object.keys(row);
          for (const name of names) {
            const column = columns.find((entry) => entry.name === name);
            const allowed = degenerate || (column && affinity(column.type));
            if (allowed && row[name] === sentinel) {
              row[name] = null;
              touched.add(name);
            }
          }
        }
      }
      for (const name of touched) patchStats.touched.add(name);
      patchStats.conversions += touched.size;
      if (!patchStats.firstRowLogged && rows.length > 0) {
        patchStats.firstRowLogged = true;
        trace('SQLITE_NULL_FIX_SELFCHECK', [
          `columns()=${columns.length}; rows=${rows.length}; 数组行=${Array.isArray(rows[0])}; 本次还原=${touched.size}; 命中列=${[...touched].slice(0, 12).join(',')}`,
        ]);
      }
      // 退化路径（拿不到声明类型）**必须留痕**：这是唯一可能误伤合法值 98304 的分支，
      // 一旦出现就有据可查（含累计次数与被改写的列）。
      if (degenerate && touched.size > 0 && !patchStats.degenerateLogged) {
        patchStats.degenerateLogged = true;
        trace('SQLITE_NULL_FIX_DEGENERATE', [
          `columns() 不可用（长度 0）⇒ 按哨兵值判定：本次改写 ${touched.size} 列；calls=${patchStats.calls}; 累计改写=${patchStats.conversions}; 命中列=${[...touched].slice(0, 12).join(',')}`,
        ]);
      }
      if (patchStats.conversions > 0 && !patchStats.firstHitLogged) {
        patchStats.firstHitLogged = true;
        log(
          `[依赖兜底] NULL 缺陷兜底已生效：首个命中的列 = ${[...patchStats.touched].slice(0, 12).join(',')}` +
            `（累计 calls=${patchStats.calls}, 改写=${patchStats.conversions}）`,
        );
      }
      return rows;
    };
    wrapped.__ocNullFix = true;
    Klass.prototype.all = wrapped;
  };

  applyNullFix(Database);

  // 产物的 ESM 前导注册了模块钩子，直接 require 未必拿到宿主那份实例（真机实测：只打直接引用未生效）。
  // 因此在 CJS 加载器上挂钩：无论谁、从什么 base 加载 better-sqlite3，拿到类后立即打补丁（幂等）。
  try {
    const Module = require('node:module');
    const originalLoad = Module._load;
    Module._load = function load(request, parent, isMain) {
      const loaded = originalLoad.call(this, request, parent, isMain);
      if (typeof loaded === 'function' && /better-sqlite3$/.test(String(request))) {
        try {
          applyNullFix(loaded);
        } catch {
          // 忽略：打不上补丁时下面还有自检 trace 可查
        }
      }
      return loaded;
    };
    trace('SQLITE_NULL_FIX_HOOKED', ['已挂钩 Module._load（覆盖 ESM 前导的再加载路径）']);
  } catch (error) {
    trace('SQLITE_NULL_FIX_HOOKED', [`挂钩失败：${error && error.message}`]);
  }

  trace('SQLITE_NULL_BUG_PATCHED', [`哨兵=${String(sentinel)}；仅对 TEXT/BLOB 亲和列还原为 null`]);
  log(`[依赖兜底] 检出 better-sqlite3 NULL 缺陷（NULL 读作 ${String(sentinel)}），已按声明类型做有原则的还原`);
}

/**
 * 沙箱工作区：服务端的「项目/工作区根」= 起宿主时的**进程工作目录**。
 *
 * 为什么必须显式准备：产物里没有 `--directory` 之类的开关，opencode 直接以 cwd 作为
 * `Location.directory`。设备上 Electron 主进程的 cwd 是 `/`，而应用域读不了 `/`（EACCES），
 * 于是真机表现为（实测 2026-10-14）：
 *   - session 的 `directory` 被记成 `/`，`worktree discovery failed`；
 *   - `GET /api/fs/list` / `/api/fs/find` 一律 500（还把目录选择器拖死，见
 *     「unsupported platform for ripgrep: arm64-openharmony」）；
 *   - 建会话时 `Session.create` 回读校验失败 ⇒ UI 只显示「服务器请求失败 HTTP 500」，
 *     即「能连上模型却一句话都发不出去」。
 * 因此这里在起宿主**之前**把 cwd 切到沙箱内的工作区并确保其存在（`<userData>/workspace`，
 * 可用 `OCR_WORKSPACE_DIR` 覆盖）。这个目录同时就是需求里「沙箱中的测试目录」。
 */
function ensureWorkspace() {
  const dir = process.env.OCR_WORKSPACE_DIR || path.join(APP_HOME, 'workspace');
  try {
    fs.mkdirSync(dir, { recursive: true });
    process.chdir(dir);
    log(`[${currentStage}] 工作区（服务端 cwd）= ${process.cwd()}`);
  } catch (error) {
    // 不静默、也不阻断启动：切不动时把原因留在 trace，会话异常时才能对上因果
    log(`[${currentStage}] 准备工作区失败（会话/项目可能不可用）：${error && error.message}`);
  }
  return dir;
}

function startHost() {
  currentStage = STAGES.HOST;
  // 依赖缺陷兜底必须在宿主 import better-sqlite3 **之前**（同一进程、同一模块实例）
  const sidecar = path.join(__dirname, 'sidecar.js');
  patchBetterSqlite3NullBug();
  const workspace = ensureWorkspace();
  const env = {
    ...process.env,
    OCR_SERVER_PORT: String(serverPort),
    OCR_SERVER_HOSTNAME: process.env.OCR_SERVER_HOSTNAME || '0.0.0.0',
    OCR_RUNTIME_DIR: RUNTIME_DIR,
    OCR_WORKSPACE_DIR: workspace,
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
