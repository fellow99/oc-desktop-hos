/**
 * `~/.git-credentials` —— 与 `git credential-store` 同形的凭据文件。
 *
 * 为什么用它做**唯一真值**：本壳没有 git 维度的凭据库（上游 Credential 是 provider/integration 维度、
 * 落在 SQLite），所以设置页直接读写这个文件；`auth.js` 也只读它。单一真值 = 无镜像时序、无
 * 「保存后文件里还没有」的时间窗。
 *
 * 规则（与 git 的行为对齐）：
 *   - 一行一条带 userinfo 的 URL：`<协议>://<用户名>:<口令>@<主机>[:<端口>][/路径]`；userinfo 百分号编码
 *   - 匹配键 = 协议 + `host[:port]`（大小写不敏感）；带路径的行按前缀匹配且**优先于**裸主机行
 *   - 同分时文件里靠后的行覆盖靠前的（git 的记录覆盖规则）
 *   - 坏行 / 注释 / 空行一律跳过，不让手工编辑把全部 git 操作搞挂
 */
import nodeFs from "node:fs"
import os from "node:os"
import path from "node:path"

/** 凭据文件路径：`$HOME/.git-credentials`（设备上 HOME 已被宿主改写到应用私有目录） */
export function gitCredentialsPath(env = process.env) {
  const home = env.HOME || env.USERPROFILE || os.homedir()
  return path.join(path.resolve(home), ".git-credentials")
}

/** 把一条凭据格式化为文件行（userinfo 百分号编码） */
export function formatCredential(entry) {
  const user = encodeURIComponent(entry.username ?? "")
  const password = encodeURIComponent(entry.password ?? "")
  const suffix = typeof entry.path === "string" && entry.path.length > 0 ? entry.path : ""
  return `${entry.protocol}://${user}:${password}@${entry.host}${suffix}`
}

/**
 * 解析一行；不是可用凭据时返回 `null`（不抛错）。
 * @returns {{protocol: string, host: string, username: string, password: string, path: string} | null}
 */
export function parseCredential(line) {
  if (typeof line !== "string") return null
  const text = line.trim()
  if (text.length === 0 || text.startsWith("#")) return null
  let url
  try {
    url = new URL(text)
  } catch {
    return null
  }
  if (!url.username || !url.password) return null
  return {
    protocol: url.protocol.replace(/:$/, "").toLowerCase(),
    host: url.host.toLowerCase(),
    username: safeDecode(url.username),
    password: safeDecode(url.password),
    path: url.pathname && url.pathname !== "/" ? url.pathname : "",
  }
}

/** 读取并解析整个文件；文件不存在读作「没有凭据」，不抛错 */
export function readCredentials(file = gitCredentialsPath()) {
  let text
  try {
    text = nodeFs.readFileSync(file, "utf8")
  } catch {
    return []
  }
  const entries = []
  for (const line of text.split(/\r?\n/u)) {
    const parsed = parseCredential(line)
    if (parsed) entries.push(parsed)
  }
  return entries
}

/**
 * 按目标地址匹配凭据。
 * @param {Array} entries readCredentials() 的结果
 * @param {{protocol: string, host: string, path?: string}} target
 */
export function matchCredential(entries, target) {
  const protocol = String(target?.protocol ?? "").toLowerCase()
  const host = String(target?.host ?? "").toLowerCase()
  const targetPath = typeof target?.path === "string" && target.path.length > 0 ? target.path : ""
  let best
  let bestRank = 0
  for (const entry of entries) {
    if (entry.protocol !== protocol || entry.host !== host) continue
    const rank = entry.path && targetPath.startsWith(entry.path) ? 2 : entry.path ? 0 : 1
    if (rank === 0) continue
    // `>=`：同分时让文件里靠后的行覆盖靠前的行
    if (rank >= bestRank) {
      best = entry
      bestRank = rank
    }
  }
  return best
}

/**
 * 写入（更新或追加）一条凭据；保留其它行与注释；临时文件 + rename 原子替换；强制 0600。
 * @returns {{file: string, replaced: boolean}}
 */
export function saveCredential(entry, file = gitCredentialsPath()) {
  const lines = readLines(file)
  const formatted = formatCredential(entry)
  let replaced = false
  const next = []
  for (const line of lines) {
    const parsed = parseCredential(line)
    const same =
      parsed &&
      parsed.protocol === entry.protocol &&
      parsed.host === String(entry.host).toLowerCase() &&
      parsed.username === entry.username
    if (same) {
      if (!replaced) {
        next.push(formatted)
        replaced = true
      }
      continue
    }
    next.push(line)
  }
  if (!replaced) next.push(formatted)
  writeLines(file, next)
  return { file, replaced }
}

/**
 * 删除匹配的凭据行；删空则删除文件本身。
 * @returns {{file: string, removed: number}}
 */
export function removeCredential(entry, file = gitCredentialsPath()) {
  const lines = readLines(file)
  let removed = 0
  const next = []
  for (const line of lines) {
    const parsed = parseCredential(line)
    const same =
      parsed &&
      parsed.protocol === entry.protocol &&
      parsed.host === String(entry.host).toLowerCase() &&
      (entry.username === undefined || parsed.username === entry.username)
    if (same) {
      removed += 1
      continue
    }
    next.push(line)
  }
  if (removed > 0) {
    if (next.every((line) => line.trim().length === 0)) {
      try {
        nodeFs.unlinkSync(file)
      } catch (error) {
        if (error?.code !== "ENOENT") throw error
      }
      return { file, removed }
    }
    writeLines(file, next)
  }
  return { file, removed }
}

/** 文件形态诊断（不含任何凭据内容） */
export function describeCredentialsFile(file = gitCredentialsPath()) {
  try {
    const stat = nodeFs.statSync(file)
    const entries = readCredentials(file)
    return {
      path: file,
      exists: true,
      mode: (stat.mode & 0o777).toString(8),
      count: entries.length,
      message: "",
    }
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { path: file, exists: false, mode: "", count: 0, message: "credential file does not exist yet" }
    }
    return { path: file, exists: false, mode: "", count: 0, message: String(error?.message ?? error) }
  }
}

function readLines(file) {
  try {
    return nodeFs.readFileSync(file, "utf8").split(/\r?\n/u)
  } catch (error) {
    if (error?.code === "ENOENT") return []
    throw error
  }
}

function writeLines(file, lines) {
  const text = `${lines.join("\n").replace(/\n+$/u, "")}\n`
  const directory = path.dirname(file)
  nodeFs.mkdirSync(directory, { recursive: true })
  const temporary = path.join(directory, `.git-credentials.${process.pid}.${Date.now().toString(36)}`)
  nodeFs.writeFileSync(temporary, text, { mode: 0o600 })
  try {
    nodeFs.chmodSync(temporary, 0o600)
  } catch {
    // 某些文件系统不支持 chmod：不因此让保存失败
  }
  nodeFs.renameSync(temporary, file)
  try {
    nodeFs.chmodSync(file, 0o600)
  } catch {
    // 同上
  }
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}
