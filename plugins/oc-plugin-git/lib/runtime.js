/**
 * 运行时装载：isomorphic-git（含 http/node 传输）与 jsdiff。
 *
 * 为什么是**懒加载**：构建期 `scripts/collect-app.mjs` 的「导入式工具元数据检查」会 import 本插件并
 * 跑一遍 `setup()` 收集工具表，而那时插件目录里的 `node_modules/` 可能还没物化（物化发生在投放之后）。
 * 顶层 `import "isomorphic-git"` 会让那道门禁因模块缺失而失败，把构建期门禁变成假阴性来源。
 * 因此第三方模块一律在**首次使用时**装载并缓存。
 *
 * 版本纪律：`ISOMORPHIC_GIT_VERSION` 与 `JSDIFF_VERSION` 必须与 `scripts/collect-app.mjs` 里的
 * 物化 pin 一致；运行时断言不一致即抛错（fail-visible），不做「凑合跑」。
 */

export const ISOMORPHIC_GIT_VERSION = "1.44.2"
export const JSDIFF_VERSION = "9.0.0"
/** jsdiff 只断言主版本（其发布物不导出可读版本号） */
export const SUPPORTED_JSDIFF_MAJOR = 9

let cached

/** 装载失败时抛出的错误（工具层据此给出「git 运行时缺失」的可读文案） */
export class RuntimeUnavailableError extends Error {
  constructor(message, cause) {
    super(message)
    this.name = "RuntimeUnavailableError"
    if (cause) this.cause = cause
  }
}

/**
 * 装载并缓存运行时。
 * @returns {Promise<{ git: any, http: any, diff: any, version: string }>}
 */
export async function loadRuntime() {
  if (cached) return cached
  let gitModule
  let httpModule
  let diffModule
  try {
    gitModule = await import("isomorphic-git")
    httpModule = await import("isomorphic-git/http/node")
    diffModule = await import("diff")
  } catch (error) {
    throw new RuntimeUnavailableError(
      `git runtime is not available (expected isomorphic-git@${ISOMORPHIC_GIT_VERSION} and diff@${JSDIFF_VERSION}); ` +
        `the plugin dependencies were probably not materialized at build time. Cause: ${messageOf(error)}`,
      error,
    )
  }

  const git = gitModule.default ?? gitModule
  const http = httpModule.default ?? httpModule
  const diff = diffModule.default ?? diffModule

  const version = typeof git.version === "function" ? git.version() : String(gitModule.version ?? "unknown")
  if (version !== ISOMORPHIC_GIT_VERSION) {
    throw new RuntimeUnavailableError(
      `git runtime version mismatch: expected isomorphic-git@${ISOMORPHIC_GIT_VERSION}, got ${version}`,
    )
  }
  for (const name of ["createTwoFilesPatch", "structuredPatch", "formatPatch"]) {
    if (typeof diff?.[name] !== "function") {
      throw new RuntimeUnavailableError(`jsdiff runtime is not usable: missing ${name}()`)
    }
  }

  cached = { git, http, diff, version }
  return cached
}

/** 仅供测试：清空缓存 */
export function resetRuntimeCache() {
  cached = undefined
}

function messageOf(error) {
  return error && error.message ? error.message : String(error)
}
