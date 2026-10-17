import { openExistingRepository, guarded, withRemoteAuth } from "../repo.js"
import { loadRuntime } from "../runtime.js"
import { redactUrl } from "../auth.js"
import { text } from "./shared.js"

export function createGitRemote(workspace) {
  return {
    name: "git_remote",
    description:
      "List, add or remove remotes, or probe a remote server's refs without writing anything locally " +
      '(action "probe"; needs a url or a configured remote). Probing is the cheapest way to check connectivity and credentials, ' +
      "and it works before anything is cloned when `url` is given.",
    input: {
      type: "object",
      properties: {
        dir: { type: "string", description: "Repository directory, relative to the workspace root." },
        action: { type: "string", enum: ["list", "add", "remove", "probe"], description: 'Operation to perform (default: "list").' },
        name: { type: "string", description: 'Remote name (default: "origin").' },
        url: { type: "string", description: "Remote URL for add/probe." },
        force: { type: "boolean", description: "Overwrite an existing remote with the same name on add." },
      },
      additionalProperties: false,
    },
    options: { codemode: false },
    execute: async (input) =>
      guarded("git_remote", async () => {
        const action = input?.action ?? "list"
        const name = typeof input?.name === "string" && input.name.length > 0 ? input.name : "origin"

        // probe：有 url 时不需要仓库（连接性/凭据检查往往发生在 clone 之前）
        if (action === "probe") {
          let url = typeof input?.url === "string" ? input.url : ""
          let dir
          if (url.length === 0) {
            const repository = await openExistingRepository(workspace, input?.dir)
            const remotes = await repository.git.listRemotes({ fs: repository.fs, dir: repository.dir })
            const found = (remotes ?? []).find((remote) => remote.remote === name)
            if (!found) return text(`git_remote: remote "${name}" is not configured; pass \`url\` to probe directly.`)
            url = found.url
            dir = repository.dir
          }
          const { git, http } = await loadRuntime()
          const started = Date.now()
          const refs = await withRemoteAuth(workspace, url, () =>
            git.listServerRefs({
              http,
              url,
              onAuth: workspace.auth.onAuth,
              onAuthFailure: workspace.auth.onAuthFailure,
            }),
          )
          return summarize(refs, url, started, dir)
        }

        const repository = await openExistingRepository(workspace, input?.dir)

        if (action === "list") {
          const remotes = await repository.git.listRemotes({ fs: repository.fs, dir: repository.dir })
          if (!remotes || remotes.length === 0) return text("No remotes configured.", { dir: repository.dir, count: 0 })
          const lines = remotes.map((remote) => `${remote.remote}\t${redactUrl(remote.url)}`)
          return text(lines.join("\n"), {
            dir: repository.dir,
            count: remotes.length,
            remotes: remotes.map((remote) => ({ remote: remote.remote, url: redactUrl(remote.url) })),
          })
        }

        if (action === "add") {
          const url = typeof input?.url === "string" ? input.url : ""
          if (url.length === 0) return text('git_remote: `url` is required for action "add".')
          await repository.git.addRemote({
            fs: repository.fs,
            dir: repository.dir,
            remote: name,
            url,
            ...(input?.force ? { force: true } : {}),
          })
          return text(`Added remote ${name} → ${redactUrl(url)}.`, { dir: repository.dir, name, url: redactUrl(url) })
        }

        await repository.git.deleteRemote({ fs: repository.fs, dir: repository.dir, remote: name })
        return text(`Removed remote ${name}.`, { dir: repository.dir, name })
      }),
  }
}

function summarize(refs, url, started, dir) {
  const branches = (refs ?? []).filter((ref) => ref.ref.startsWith("refs/heads/"))
  const tags = (refs ?? []).filter((ref) => ref.ref.startsWith("refs/tags/"))
  const elapsed = Date.now() - started
  const lines = [
    `${redactUrl(url)}: ${refs?.length ?? 0} refs in ${elapsed} ms (${branches.length} branches, ${tags.length} tags)`,
    ...branches.slice(0, 50).map((ref) => `  ${ref.ref}`),
  ]
  if (branches.length > 50) lines.push(`  … and ${branches.length - 50} more branches`)
  return text(lines.join("\n"), {
    ...(dir === undefined ? {} : { dir }),
    url: redactUrl(url),
    elapsedMs: elapsed,
    branches: branches.length,
    tags: tags.length,
  })
}
