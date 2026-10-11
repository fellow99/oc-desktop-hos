import { appTasks, OhosAppContext, OhosPluginId } from '@ohos/hvigor-ohos-plugin';
import { getNode } from '@ohos/hvigor';
import * as fs from 'fs';
import * as path from 'path';

/**
 * 签名材料注入（仅内存，绝不写回 build-profile.json5）。
 *
 * 设计依据：docs/工程规划-V2.md §3.7 / §8。本工程使用自定义 bundleName
 * （rg.fellow99.oc.OCDesktop），因此**不能**复用 com.huawei.ohos_electron 的共享签名，
 * 必须用 DevEco Studio 为本包名重新生成证书，并据本包名单独申请 ACL（JIT 权限）。
 *
 * 材料来源（按优先级）：
 *   1. CI 环境变量 CERTPATH / STORE_FILE / STORE_PASSWORD / KEY_PASSWORD（+ 可选 PROFILE / KEY_ALIAS / SIGN_ALG）
 *   2. 本地文件 signing.<mode>.local.json（gitignored；样例见 signing.<mode>.local.json.sample）
 * 两者都缺失时不修改 signingConfigs（交由 DevEco 自动签名或产出未签名包），并打印明确警告。
 */

const PROJECT_ROOT = __dirname;

/** 期望的应用身份：与 AppScope/app.json5 单一事实源对照，防「改了包名忘了签名」 */
const EXPECTED_BUNDLE_NAME = 'rg.fellow99.oc.OCDesktop';

type SignMode = 'debug' | 'release';

interface SigningMaterial {
  certpath: string;
  storeFile: string;
  profile: string;
  keyAlias: string;
  keyPassword: string;
  storePassword: string;
  signAlg: string;
}

const REQUIRED_FIELDS = ['certpath', 'storeFile', 'profile', 'keyPassword', 'storePassword'] as const;

/** 统一失败出口：打印清晰错误并以非零码退出，绝不静默回退（防止误产错误签名的包）。 */
function fail(message: string): never {
  console.error(`[oc-desktop][hvigorfile] 签名配置错误：${message}`);
  throw new Error(message);
}

/**
 * 解析 SIGN_MODE：
 *   未设置 / 空字符串 → debug（默认）
 *   "debug" | "release" → 原样返回
 *   其它值 → 直接失败（避免「以为签的是 release、实际签的是 debug」）
 */
function resolveSignMode(): SignMode {
  const raw = (process.env.SIGN_MODE || '').trim();
  if (raw === '') return 'debug';
  if (raw === 'debug' || raw === 'release') return raw;
  return fail(`非法的 SIGN_MODE="${raw}"：只允许 "debug" 或 "release"（未设置时默认为 "debug"）。`);
}

/** 相对路径按工程根解析，便于在 JSON 里写 ".ohos/release/release.p12" */
function resolveMaterialPaths(m: SigningMaterial): SigningMaterial {
  const abs = (p: string) => (path.isAbsolute(p) ? p : path.resolve(PROJECT_ROOT, p));
  return { ...m, certpath: abs(m.certpath), storeFile: abs(m.storeFile), profile: abs(m.profile) };
}

function loadMaterialFile(file: string): SigningMaterial {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (e) {
    return fail(`无法解析签名配置 ${file}：${(e as Error).message}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return fail(`签名配置 ${file} 的顶层必须是 JSON 对象。`);
  }
  const raw = parsed as Record<string, unknown>;
  const str = (key: string): string => (typeof raw[key] === 'string' ? (raw[key] as string) : '');
  const missing = REQUIRED_FIELDS.filter((k) => str(k).trim() === '');
  if (missing.length > 0) return fail(`签名配置 ${file} 缺少必填字段：${missing.join(', ')}。`);
  return resolveMaterialPaths({
    certpath: str('certpath'),
    storeFile: str('storeFile'),
    profile: str('profile'),
    keyAlias: str('keyAlias') || 'debugKey',
    keyPassword: str('keyPassword'),
    storePassword: str('storePassword'),
    signAlg: str('signAlg') || 'SHA256withECDSA',
  });
}

function loadSigningConfig(mode: SignMode): SigningMaterial | null {
  const env = process.env;
  if (env.CERTPATH && env.STORE_FILE && env.STORE_PASSWORD && env.KEY_PASSWORD) {
    return resolveMaterialPaths({
      certpath: env.CERTPATH,
      storeFile: env.STORE_FILE,
      profile: env.PROFILE || '',
      keyAlias: env.KEY_ALIAS || 'debugKey',
      keyPassword: env.KEY_PASSWORD,
      storePassword: env.STORE_PASSWORD,
      signAlg: env.SIGN_ALG || 'SHA256withECDSA',
    });
  }
  const file = path.join(PROJECT_ROOT, `signing.${mode}.local.json`);
  if (fs.existsSync(file)) return loadMaterialFile(file);
  return null;
}

/** AppScope/app.json5 的 bundleName 是唯一事实源；签名材料与它不一致时装不上（9568289 类错误） */
function readAppBundleName(): string | null {
  const appJson5 = path.join(PROJECT_ROOT, 'AppScope', 'app.json5');
  if (!fs.existsSync(appJson5)) return null;
  const matched = fs.readFileSync(appJson5, 'utf-8').match(/"bundleName"\s*:\s*"([^"]+)"/);
  return matched ? matched[1] : null;
}

getNode(__filename).afterNodeEvaluate((node) => {
  const mode = resolveSignMode();
  const bundleName = readAppBundleName();
  if (bundleName !== EXPECTED_BUNDLE_NAME) {
    console.warn(
      `[oc-desktop][hvigorfile] AppScope bundleName=${bundleName ?? '解析失败'}，期望 ${EXPECTED_BUNDLE_NAME}；` +
        `签名证书与 ACL 都是按包名申请的，请确认这是有意的。`,
    );
  }

  const appContext = node.getContext(OhosPluginId.OHOS_APP_PLUGIN) as OhosAppContext;
  const buildProfileOpt = appContext.getBuildProfileOpt();
  const material = loadSigningConfig(mode);
  if (!material) {
    const expected = path.join(PROJECT_ROOT, `signing.${mode}.local.json`);
    console.warn(
      `[oc-desktop][hvigorfile] SIGN_MODE=${mode}，但未找到签名材料：${expected}` +
        `（也未提供 CERTPATH/STORE_FILE/STORE_PASSWORD/KEY_PASSWORD 环境变量）。` +
        `本次构建将产出未签名 / IDE 自动签名的包。`,
    );
    return;
  }
  buildProfileOpt['app']['signingConfigs'] = [
    {
      name: 'default',
      type: 'HarmonyOS',
      material,
    },
  ];
  appContext.setBuildProfileOpt(buildProfileOpt);
  console.log(`[oc-desktop][hvigorfile] 已注入签名材料（SIGN_MODE=${mode}，bundleName=${bundleName ?? 'unknown'}）`);
});

export default {
  system: appTasks, /* Built-in plugin of hvigor. It cannot be modified. */
  plugins: [], /* Custom plugin to extend the functionality of hvigor. */
};
