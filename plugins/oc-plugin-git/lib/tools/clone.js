import path from "node:path"
import { openRepository, guarded, withRemoteAuth } from "../repo.js"
import { redactUrl } from "../auth.js"
import { objectSchema, text } from "./shared.js"

function defaultTarget(url) {
  const cleaned = String(url ?? "")
    .replace(/\.git$/u, "")
    .replace(/[/\\]+$/u, "")
  const name = path.basename(cleaned) || "repository"
  return name
}

export function createGitClone(workspace) {
  return {
    name: "git_clone",
    description:
      "Clone a remote git repository into the workspace. Authentication uses the credential configured in Settings → Git; " +
      "public repositories need no credential. Large repositories are much faster with `depth: 1` and `singleBranch: true`.",
    input: {
      type: "object",
      properties: {
        dir: {
          type: "string",
          description:
            "Destination directory, relative to the workspace root. Defaults to a directory named after the repository.",
        },
        url: { type: "string", description: "Remote URL (https://…). SSH URLs are not supported." },
        ref: { type: "string", description: "Branch or tag to check out instead of the remote default branch." },
        depth: { type: "integer", minimum: 1, description: "Shallow clone depth. Omit for a full clone." },
        noTags: { type: "boolean", description: "Do not fetch tags (default: false)." },
        singleBranch: { type: "boolean", description: "Fetch only the requested/default branch (default: false)." },
      },
      required: ["url"],
      additionalProperties: false,
    },
    options: { codemode: false },
    execute: async (input) =>
      guarded("git_clone", async () => {
        const url = String(input?.url ?? "")
        if (url.length === 0) return text("git_clone: `url` is required.")
        const relative = input?.dir && input.dir.length > 0 ? input.dir : defaultTarget(url)
        const repository = await openRepository(workspace, relative)
        const started = Date.now()
        const result = await withRemoteAuth(workspace, url, () =>
          repository.git.clone({
            fs: repository.fs,
            http: repository.http,
            dir: repository.dir,
            url,
            onAuth: repository.auth.onAuth,
            onAuthFailure: repository.auth.onAuthFailure,
            ...(input?.ref ? { ref: input.ref } : {}),
            ...(input?.depth ? { depth: input.depth } : {}),
            ...(input?.noTags ? { noTags: true } : {}),
            ...(input?.singleBranch ? { singleBranch: true } : {}),
          }),
        )
        const elapsed = Date.now() - started
        return text(
          `Cloned ${redactUrl(url)} into ${repository.dir} in ${elapsed} ms (${result ? "history complete" : "no new commits"}).`,
          { dir: repository.dir, url: redactUrl(url), elapsedMs: elapsed },
        )
      }),
  }
}
