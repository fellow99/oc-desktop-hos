import { openExistingRepository, guarded, currentBranch, resolveIdentity, withRemoteAuth } from "../repo.js"
import { objectSchema, text } from "./shared.js"

export function createGitFetch(workspace) {
  return {
    name: "git_fetch",
    description:
      "Download objects and refs from a remote without touching the working tree. " +
      "Use `depth` for a shallow fetch and `prune` to drop refs that no longer exist on the remote.",
    input: objectSchema(
      {
        remote: { type: "string", description: 'Remote name (default: "origin").' },
        ref: { type: "string", description: "Single branch/ref to fetch instead of all refs." },
        depth: { type: "integer", minimum: 1, description: "Shallow fetch depth." },
        prune: { type: "boolean", description: "Delete local refs that no longer exist on the remote." },
        tags: { type: "boolean", description: "Fetch tags as well." },
      },
      [],
    ),
    options: { codemode: false },
    execute: async (input) =>
      guarded("git_fetch", async () => {
        const repository = await openExistingRepository(workspace, input?.dir)
        const remote = typeof input?.remote === "string" && input.remote.length > 0 ? input.remote : "origin"
        const remotes = await repository.git.listRemotes({ fs: repository.fs, dir: repository.dir })
        const target = (remotes ?? []).find((entry) => entry.remote === remote)
        if (!target) return text(`git_fetch: remote "${remote}" is not configured. Use git_remote to add it first.`)
        const started = Date.now()
        const result = await withRemoteAuth(workspace, target.url, () =>
          repository.git.fetch({
            fs: repository.fs,
            http: repository.http,
            dir: repository.dir,
            remote,
            onAuth: repository.auth.onAuth,
            onAuthFailure: repository.auth.onAuthFailure,
            ...(input?.ref ? { ref: input.ref } : {}),
            ...(input?.depth ? { depth: input.depth } : {}),
            ...(input?.prune ? { prune: true } : {}),
            ...(input?.tags ? { tags: true } : {}),
          }),
        )
        const elapsed = Date.now() - started
        const refs = result?.fetchHead ? `fetchHead ${String(result.fetchHead).slice(0, 10)}` : "no new objects"
        const updated = result?.pruned?.length ? `, pruned ${result.pruned.length}` : ""
        return text(`Fetched from ${remote} in ${elapsed} ms (${refs}${updated}).`, {
          dir: repository.dir,
          remote,
          elapsedMs: elapsed,
        })
      }),
  }
}

export function createGitPull(workspace) {
  return {
    name: "git_pull",
    description:
      "Fetch from a remote and merge into the current branch. Set `fastForwardOnly` to refuse merges that would create a commit.",
    input: objectSchema(
      {
        remote: { type: "string", description: 'Remote name (default: "origin").' },
        ref: { type: "string", description: "Branch to pull (default: the current branch)." },
        fastForwardOnly: { type: "boolean", description: "Only allow fast-forward updates (default: false)." },
      },
      [],
    ),
    options: { codemode: false },
    execute: async (input) =>
      guarded("git_pull", async () => {
        const repository = await openExistingRepository(workspace, input?.dir)
        const remote = typeof input?.remote === "string" && input.remote.length > 0 ? input.remote : "origin"
        const remotes = await repository.git.listRemotes({ fs: repository.fs, dir: repository.dir })
        const target = (remotes ?? []).find((entry) => entry.remote === remote)
        if (!target) return text(`git_pull: remote "${remote}" is not configured. Use git_remote to add it first.`)
        const started = Date.now()
        // isomorphic-git 的 pull 内部走 merge，即使只是快进也要 author/committer：
        // 不传就在「本来无事可做」的仓库上抛 MissingNameError（真机实测）。
        const identity = await resolveIdentity(repository)
        const result = await withRemoteAuth(workspace, target.url, () =>
          repository.git.pull({
            fs: repository.fs,
            http: repository.http,
            dir: repository.dir,
            remote,
            author: identity,
            committer: identity,
            onAuth: repository.auth.onAuth,
            onAuthFailure: repository.auth.onAuthFailure,
            ...(input?.ref ? { ref: input.ref } : {}),
            ...(input?.fastForwardOnly ? { fastForwardOnly: true } : {}),
          }),
        )
        const elapsed = Date.now() - started
        // 与 merge 同源问题：pull 成功后索引/工作树不会自动跟随 HEAD，这里补一次检出。
        if (result?.oid && !result.alreadyMerged) {
          const branch = await currentBranch(repository)
          await repository.git.checkout({ fs: repository.fs, dir: repository.dir, ref: branch ?? result.oid, force: true })
        }
        if (!result || !result.oid) return text(`Already up to date (${elapsed} ms).`, { dir: repository.dir, elapsedMs: elapsed })
        return text(
          `Pulled from ${remote} in ${elapsed} ms → ${result.oid.slice(0, 10)}` +
            `${result.alreadyMerged ? " (already merged)" : result.fastForward ? " (fast-forward)" : " (merge commit)"}.`,
          { dir: repository.dir, oid: result.oid, elapsedMs: elapsed },
        )
      }),
  }
}
