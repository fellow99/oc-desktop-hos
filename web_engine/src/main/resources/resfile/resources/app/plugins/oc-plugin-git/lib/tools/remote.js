import { openExistingRepository, guarded, withRemoteAuth } from "../repo.js"
import { objectSchema, text } from "./shared.js"

export function createGitRemote(workspace) {
  return {
    name: "git_remote",
    description:
      "List, add or remove remotes, or probe a remote server's refs without writing anything locally " +
      '(action "probe"; needs a url or a configured remote). Probing is the cheapest way to check connectivity and credentials.',
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
        const repository = await openExistingRepository(workspace, input?.dir)
        const action = input?.action ?? "list"
        const name = typeof input?.name === "string" && input.name.length > 0 ? input.name : "origin"

        if (action === "list") {
          const remotes = await repository.git.listRemotes({ fs: repository.fs, dir: repository.dir })
          if (!remotes || remotes.length === 0) return text("No remotes configured.", { dir: repository.dir, count: 0 })
          const lines = remotes.map((remote) => `${remote.remote}\t${remote.url}`)
          return text(lines.join("\n"), { dir: repository.dir, count: remotes.length, remotes })
        }

        if (action === "add") {
          const url = typeof input?.url === "string" ? input.url : ""
          if (url.length === 0) return text("git_remote: `url` is required for action \"add\".")
          await repository.git.addRemote({
            fs: repository.fs,
            dir: repository.dir,
            remote: name,
            url,
            ...(input?.force ? { force: true } : {}),
          })
          return text(`Added remote ${name} → ${url}.`, { dir: repository.dir, name, url })
        }

        if (action === "remove") {
          await repository.git.deleteRemote({ fs: repository.fs, dir: repository.dir, remote: name })
          return text(`Removed remote ${name}.`, { dir: repository.dir, name })
        }

        let url = typeof input?.url === "string" ? input.url : ""
        if (url.length === 0) {
          const remotes = await repository.git.listRemotes({ fs: repository.fs, dir: repository.dir })
          const found = (remotes ?? []).find((remote) => remote.remote === name)
          if (!found) return text(`git_remote: remote "${name}" is not configured; pass \`url\` to probe directly.`)
          url = found.url
        }
        const started = Date.now()
        const refs = await withRemoteAuth(workspace, url, () =>
          repository.git.listServerRefs({
            http: repository.http,
            url,
            onAuth: repository.auth.onAuth,
            onAuthFailure: repository.auth.onAuthFailure,
          }),
        )
        const branches = (refs ?? []).filter((ref) => ref.ref.startsWith("refs/heads/"))
        const tags = (refs ?? []).filter((ref) => ref.ref.startsWith("refs/tags/"))
        const elapsed = Date.now() - started
        const lines = [
          `${url}: ${refs?.length ?? 0} refs in ${elapsed} ms (${branches.length} branches, ${tags.length} tags)`,
          ...branches.slice(0, 50).map((ref) => `  ${ref.ref}`),
        ]
        if (branches.length > 50) lines.push(`  … and ${branches.length - 50} more branches`)
        return text(lines.join("\n"), {
          dir: repository.dir,
          url,
          elapsedMs: elapsed,
          branches: branches.length,
          tags: tags.length,
        })
      }),
  }
}
