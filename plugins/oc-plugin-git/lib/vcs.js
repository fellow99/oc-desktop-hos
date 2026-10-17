/**
 * VCS provider：用同一套 JS 实现**覆盖内置的 `id: "git"` provider**。
 *
 * 为什么不改上游：内置 provider（`packages/core/src/plugin/vcs/git.ts`）必然走
 * `gitExecutable` + 子进程，在没有 git 的设备上必然失败。`VcsEditor.add` 的语义是
 * `Map.set(provider.id, provider)`，而配置插件在 `internal.pre` 之后激活，因此同 id 覆盖成立。
 *
 * 失败策略：上游对 provider 异常是「吞掉 + warning」（`protect` / `review`），所以这里对每个方法
 * 都自行 catch 并打一行归因日志（落 hilog），返回保守值（空数组 / 空分支），让 UI 不至于崩。
 */
import { createFence } from "./fence.js"
import { openRepository, currentBranch, headOid } from "./repo.js"
import { walkDiff } from "./walk-diff.js"
import { MAX_TOTAL_DIFF_BYTES, renderFileDiff } from "./diff.js"

export const VCS_PROVIDER_ID = "git"
const MAX_STATUS_FILES = 500

function scopeOf(scope) {
  const root = typeof scope?.worktree === "string" && scope.worktree.length > 0 ? scope.worktree : scope?.directory
  if (typeof root !== "string" || root.length === 0) return undefined
  return createFence({ root, cwd: typeof scope?.directory === "string" ? scope.directory : root })
}

async function openFromScope(workspace, scope) {
  const fence = scopeOf(scope)
  if (!fence) throw new Error("vcs: scope has no directory")
  return openRepository({ fence, auth: workspace.auth, log: workspace.log }, undefined)
}

async function detectDefaultBranch(repository) {
  const branches = await repository.git.listBranches({ fs: repository.fs, dir: repository.dir })
  let configured
  try {
    configured = await repository.git.getConfig({ fs: repository.fs, dir: repository.dir, path: "init.defaultBranch" })
  } catch {
    configured = undefined
  }
  if (typeof configured === "string" && configured.length > 0 && branches.includes(configured)) return configured
  if (branches.includes("main")) return "main"
  if (branches.includes("master")) return "master"
  return branches[0]
}

export function createVcsProvider(workspace) {
  const log = workspace.log ?? (() => {})
  const fail = (operation) => (error) => {
    log(`vcs provider ${operation} failed: ${error && error.message ? error.message : String(error)}`)
  }

  return {
    id: VCS_PROVIDER_ID,
    name: "Git",

    async init(input) {
      try {
        const repository = await openFromScope(workspace, input)
        await repository.git.init({ fs: repository.fs, dir: repository.dir, defaultBranch: "main" })
      } catch (error) {
        fail("init")(error)
        throw error
      }
    },

    async info(input) {
      try {
        const repository = await openFromScope(workspace, input)
        const current = await currentBranch(repository)
        const defaultBranch = await detectDefaultBranch(repository)
        return {
          provider: VCS_PROVIDER_ID,
          branch: { ...(current ? { current } : {}), ...(defaultBranch ? { default: defaultBranch } : {}) },
        }
      } catch (error) {
        fail("info")(error)
        return { provider: VCS_PROVIDER_ID, branch: {} }
      }
    },

    async base(input) {
      try {
        const repository = await openFromScope(workspace, input)
        const defaultBranch = await detectDefaultBranch(repository)
        if (!defaultBranch) return null
        const head = await headOid(repository)
        if (!head) return null
        return { name: defaultBranch, ref: defaultBranch, source: "default" }
      } catch (error) {
        fail("base")(error)
        return null
      }
    },

    async branches(input) {
      try {
        const repository = await openFromScope(workspace, input)
        const all = await repository.git.listBranches({ fs: repository.fs, dir: repository.dir })
        const search = typeof input?.search === "string" ? input.search.toLowerCase() : ""
        const filtered = search ? all.filter((branch) => branch.toLowerCase().includes(search)) : all
        const limit = Number.isInteger(input?.limit) && input.limit > 0 ? input.limit : filtered.length
        return filtered.slice(0, limit)
      } catch (error) {
        fail("branches")(error)
        return []
      }
    },

    async status(input) {
      try {
        const repository = await openFromScope(workspace, input)
        const { entries } = await walkDiff(repository, { mode: "head" })
        return entries.slice(0, MAX_STATUS_FILES).map((entry) => {
          const rendered = renderFileDiff({ diff: repository.diff, file: entry.file, before: entry.before, after: entry.after })
          return {
            file: entry.file,
            additions: rendered.additions,
            deletions: rendered.deletions,
            status: entry.status,
          }
        })
      } catch (error) {
        fail("status")(error)
        return []
      }
    },

    async diff(input) {
      try {
        const repository = await openFromScope(workspace, input)
        const mode = input?.mode ?? "working"
        const base = typeof input?.base === "string" && input.base.length > 0 ? input.base : undefined
        const context = Number.isInteger(input?.context) ? input.context : undefined

        if (mode === "committed" && !base) return []

        // 与上游同语义：以 merge-base 为基线。`branch` 比到**工作区**（含未提交改动），
        // `committed` 只比到 HEAD —— 直接用两点 diff 会漏掉工作区改动、并把基线自身的提交算成反向变更。
        let collected
        if (base && (mode === "branch" || mode === "committed")) {
          const head = await headOid(repository)
          const baseOid = await repository.git.resolveRef({ fs: repository.fs, dir: repository.dir, ref: base })
          let mergeBase = baseOid
          if (head) {
            const bases = await repository.git.findMergeBase({ fs: repository.fs, dir: repository.dir, oids: [baseOid, head] })
            if (bases && bases.length > 0) mergeBase = bases[0]
          }
          collected =
            mode === "branch"
              ? await walkDiff(repository, { mode: "treeWorkdir", ref: mergeBase })
              : await walkDiff(repository, { mode: "refs", ref: mergeBase, ref2: head ?? mergeBase })
        } else {
          collected = await walkDiff(repository, { mode: "head" })
        }

        // 总量预算（上游同样按字节封顶）：超出后不再追加文件，避免把整仓 diff 塞给界面
        let budget = MAX_TOTAL_DIFF_BYTES
        const files = []
        for (const entry of collected.entries) {
          let rendered
          try {
            rendered = renderFileDiff({
              diff: repository.diff,
              file: entry.file,
              before: entry.before,
              after: entry.after,
              ...(context === undefined ? {} : { context }),
            })
          } catch (error) {
            // 单个文件渲染失败不该让整个 diff 变空：打一行归因日志后跳过该文件。
            fail("diff")(error)
            continue
          }
          const bytes = Buffer.byteLength(rendered.patch, "utf8")
          if (bytes > budget) break
          budget -= bytes
          files.push({
            file: entry.file,
            patch: rendered.patch,
            additions: rendered.additions,
            deletions: rendered.deletions,
            status: entry.status,
          })
        }
        return files
      } catch (error) {
        fail("diff")(error)
        return []
      }
    },
  }
}
