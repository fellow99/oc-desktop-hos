/**
 * 认证注入：把凭据文件里的用户名/口令喂给 isomorphic-git 的 `onAuth` / `onAuthFailure`。
 *
 * 纪律：
 *   - 明文只在进程内存里流转；日志与错误文案只允许出现 `host` 与长度，**绝不出现值**
 *   - 未配置凭据时 `onAuth` 返回 `{cancel:true}`（isomorphic-git 会抛 UserCanceledError），
 *     工具层据此给出「怎么配」的可照抄指引，而不是把裸 401/404 丢给模型
 *   - `onAuthFailure` 明确失败并点名主机，最多由调用方重试 1 次（本模块不做自动重试）
 */
import { matchCredential, readCredentials } from "./credentials.js"

export class CredentialMissingError extends Error {
  constructor(message, host) {
    super(message)
    this.name = "CredentialMissingError"
    this.host = host
    this.code = "CREDENTIAL_MISSING"
  }
}

export class CredentialRejectedError extends Error {
  constructor(message, host) {
    super(message)
    this.name = "CredentialRejectedError"
    this.host = host
    this.code = "CREDENTIAL_REJECTED"
  }
}

/** 回显前的 URL 脱敏：去掉 userinfo，避免把 token/口令带进对话与元数据 */
export function redactUrl(url) {
  return String(url ?? "").replace(/\/\/[^@/]*@/u, "//")
}

/** 从 git 远端 URL 取出匹配所需的三元组 */
export function parseRemoteTarget(url) {
  try {
    const parsed = new URL(String(url))
    return {
      protocol: parsed.protocol.replace(/:$/, "").toLowerCase(),
      host: parsed.host.toLowerCase(),
      path: parsed.pathname && parsed.pathname !== "/" ? parsed.pathname : "",
    }
  } catch {
    return { protocol: "", host: String(url ?? ""), path: "" }
  }
}

/** 缺凭据时的可照抄指引（点名主机、设置入口、文件路径与占位行） */
export function missingCredentialMessage(url, file) {
  const target = parseRemoteTarget(url)
  return (
    `No credential is configured for ${target.protocol}://${target.host}. ` +
    `Add it in Settings → Git, or append one line to ${file} (chmod 600): ` +
    `${target.protocol || "https"}://<username>:<password>@${target.host}`
  )
}

/** 凭据被拒时的文案（不回显口令） */
export function rejectedCredentialMessage(url, file) {
  const target = parseRemoteTarget(url)
  return (
    `The credential for ${target.protocol}://${target.host} was rejected by the server. ` +
    `Check the username/password in Settings → Git or in ${file}.`
  )
}

/**
 * @param {{file: string, log?: (message: string) => void}} input
 */
export function createAuth(input) {
  const file = input.file
  const log = input.log ?? (() => {})

  return {
    /** isomorphic-git 的 onAuth 回调 */
    onAuth: async (url) => {
      const target = parseRemoteTarget(url)
      const hit = matchCredential(readCredentials(file), target)
      if (!hit) {
        log(`credential missing for ${target.protocol}://${target.host}`)
        return { cancel: true }
      }
      log(`credential found for ${target.protocol}://${target.host} (passwordLength=${hit.password.length})`)
      return { username: hit.username, password: hit.password }
    },
    /** isomorphic-git 的 onAuthFailure 回调 */
    onAuthFailure: async (url) => {
      throw new CredentialRejectedError(rejectedCredentialMessage(url, file), parseRemoteTarget(url).host)
    },
    missingMessage: (url) => missingCredentialMessage(url, file),
    rejectedMessage: (url) => rejectedCredentialMessage(url, file),
    file,
  }
}

/** 判断错误是否来自「用户取消认证」（即我们自己返回的 cancel） */
export function isUserCanceled(error) {
  return Boolean(error && (error.name === "UserCanceledError" || error.code === "UserCanceledError"))
}
