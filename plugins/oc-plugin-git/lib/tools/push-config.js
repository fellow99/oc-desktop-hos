import { openExistingRepository, guarded, withRemoteAuth, currentBranch } from "../repo.js"
import { objectSchema, text } from "./shared.js"

function fullRef(name, tag) {
  if (name.startsWith("refs/")) return name
  return tag ? `refs/tags/${name}` : `refs/heads/${name}`
}

export function createGitPush(workspace) {
  return {
    name: "git_push",
    description:
      "Push a branch or tag to a remote. `force` and `delete` are explicit switches and are never implied. " +
      "Server-side rejections are reported verbatim; there is no automatic retry.",
    input: objectSchema(
      {
        remote: { type: "string", description: 'Remote name (default: "origin").' },
        ref: { type: "string", description: "Local branch or tag to push (default: the current branch)." },
        remoteRef: { type: "string", description: "Remote branch/tag name (default: same as ref)." },
        tag: { type: "boolean", description: "Treat ref/remoteRef as a tag (default: false)." },
        force: { type: "boolean", description: "Force push (default: false)." },
        delete: { type: "boolean", description: "Delete the remote ref instead of pushing (default: false)." },
      },
      [],
    ),
    options: { codemode: false },
    execute: async (input) =>
      guarded("git_push", async () => {
        const repository = await openExistingRepository(workspace, input?.dir)
        const remote = typeof input?.remote === "string" && input.remote.length > 0 ? input.remote : "origin"
        const remotes = await repository.git.listRemotes({ fs: repository.fs, dir: repository.dir })
        const target = (remotes ?? []).find((entry) => entry.remote === remote)
        if (!target) return text(`git_push: remote "${remote}" is not configured. Use git_remote to add it first.`)

        const tag = Boolean(input?.tag)
        const localName =
          typeof input?.ref === "string" && input.ref.length > 0
            ? input.ref
            : tag
              ? ""
              : (await currentBranch(repository)) ?? ""
        if (localName.length === 0) return text("git_push: `ref` is required (no current branch detected).")
        const ref = fullRef(localName, tag)
        const remoteRef = fullRef(
          typeof input?.remoteRef === "string" && input.remoteRef.length > 0 ? input.remoteRef : localName,
          tag,
        )

        const started = Date.now()
        const result = await withRemoteAuth(workspace, target.url, () =>
          repository.git.push({
            fs: repository.fs,
            http: repository.http,
            dir: repository.dir,
            remote,
            ref,
            remoteRef,
            onAuth: repository.auth.onAuth,
            onAuthFailure: repository.auth.onAuthFailure,
            ...(input?.force ? { force: true } : {}),
            ...(input?.delete ? { delete: true } : {}),
          }),
        )
        const elapsed = Date.now() - started
        const refs = result?.refs ?? {}
        const lines = [`${remote}: push finished in ${elapsed} ms (ok=${Boolean(result?.ok)})`]
        for (const [name, value] of Object.entries(refs)) {
          lines.push(`  ${name}: ${value?.ok ? "ok" : `NOT updated — ${value?.error ?? "unknown error"}`}`)
        }
        if (result?.error) lines.push(`  server error: ${result.error}`)
        if (Object.keys(refs).length === 0 && !result?.ok) lines.push("  no ref was updated")
        return text(lines.join("\n"), {
          dir: repository.dir,
          remote,
          ref,
          remoteRef,
          ok: Boolean(result?.ok),
          elapsedMs: elapsed,
        })
      }),
  }
}

export function createGitConfig(workspace) {
  return {
    name: "git_config",
    description:
      "Read or write repository-local git configuration (for example user.name / user.email). " +
      'Use action "get" (default) or "set"; "getAll" returns every value for a key.',
    input: objectSchema(
      {
        action: { type: "string", enum: ["get", "getAll", "set"], description: 'Operation to perform (default: "get").' },
        path: { type: "string", description: 'Configuration key, for example "user.name".' },
        value: { type: "string", description: 'Value to write (required for action "set").' },
      },
      ["path"],
    ),
    options: { codemode: false },
    execute: async (input) =>
      guarded("git_config", async () => {
        const repository = await openExistingRepository(workspace, input?.dir)
        const key = typeof input?.path === "string" ? input.path : ""
        if (key.length === 0) return text("git_config: `path` is required.")
        const action = input?.action ?? "get"

        if (action === "set") {
          if (typeof input?.value !== "string") return text('git_config: `value` is required for action "set".')
          await repository.git.setConfig({ fs: repository.fs, dir: repository.dir, path: key, value: input.value })
          return text(`Set ${key}=${input.value} (repository-local).`, { dir: repository.dir, path: key })
        }
        if (action === "getAll") {
          const values = await repository.git.getConfigAll({ fs: repository.fs, dir: repository.dir, path: key })
          return text(values.length > 0 ? values.map((value) => `${key}=${value}`).join("\n") : `${key} is not set.`, {
            dir: repository.dir,
            path: key,
            count: values.length,
          })
        }
        try {
          const value = await repository.git.getConfig({ fs: repository.fs, dir: repository.dir, path: key })
          if (value === undefined) return text(`${key} is not set.`, { dir: repository.dir, path: key })
          return text(`${key}=${value}`, { dir: repository.dir, path: key })
        } catch {
          return text(`${key} is not set.`, { dir: repository.dir, path: key })
        }
      }),
  }
}
