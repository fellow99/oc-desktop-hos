import { openExistingRepository, guarded, headOid } from "../repo.js"
import { formatCommit, formatCommitSummary } from "../report.js"
import { objectSchema, text } from "./shared.js"

export function createGitLog(workspace) {
  return {
    name: "git_log",
    description:
      "Show commit history, newest first (hash, date, author, subject). " +
      "Limit with `depth`; use `file` to list only commits that touched a path.",
    input: objectSchema({
      depth: { type: "integer", minimum: 1, description: "Maximum number of commits to return (default: 10)." },
      ref: { type: "string", description: "Start from this branch, tag or commit instead of HEAD." },
      file: { type: "string", description: "Only list commits that changed this path (relative to the repository root)." },
    }),
    options: { codemode: false },
    execute: async (input) =>
      guarded("git_log", async () => {
        const repository = await openExistingRepository(workspace, input?.dir)
        const depth = Number.isInteger(input?.depth) && input.depth > 0 ? input.depth : 10
        const commits = await repository.git.log({
          fs: repository.fs,
          dir: repository.dir,
          depth,
          ...(input?.ref ? { ref: input.ref } : {}),
          ...(input?.file ? { filepath: input.file } : {}),
        })
        if (!commits || commits.length === 0) {
          return text("No commits yet.", { dir: repository.dir, count: 0 })
        }
        const lines = commits.map((commit) => formatCommitSummary(commit))
        const head = await headOid(repository)
        return text(
          `${commits.length} commit${commits.length === 1 ? "" : "s"} (HEAD ${head ? head.slice(0, 10) : "unborn"}):\n` +
            lines.join("\n"),
          { dir: repository.dir, count: commits.length, head: head ?? null },
        )
      }),
  }
}

export function createGitShow(workspace) {
  return {
    name: "git_show",
    description:
      "Show one commit: metadata, changed paths versus its parent, and optionally the content of one file at that commit. " +
      "Tags are resolved to the commit they point at.",
    input: objectSchema({
      oid: { type: "string", description: "Commit hash, branch or tag (default: HEAD)." },
      file: { type: "string", description: "Also show this file's content at that commit." },
    }),
    options: { codemode: false },
    execute: async (input) =>
      guarded("git_show", async () => {
        const repository = await openExistingRepository(workspace, input?.dir)
        const ref = typeof input?.oid === "string" && input.oid.length > 0 ? input.oid : "HEAD"
        const oid = await repository.git.resolveRef({ fs: repository.fs, dir: repository.dir, ref })
        let commit = await repository.git.readCommit({ fs: repository.fs, dir: repository.dir, oid })
        // 标签 → 指向的提交
        if (commit.commit?.object) {
          commit = await repository.git.readCommit({ fs: repository.fs, dir: repository.dir, oid: commit.commit.object })
        }
        const parentOid = commit.commit?.parent?.[0]
        let changed = []
        if (parentOid) {
          const before = await repository.git.readTree({ fs: repository.fs, dir: repository.dir, oid: parentOid })
          const after = await repository.git.readTree({ fs: repository.fs, dir: repository.dir, oid: commit.oid })
          const index = (tree) => {
            const map = new Map()
            for (const entry of tree.tree) if (entry.type === "blob") map.set(entry.path, entry.oid)
            return map
          }
          const left = index(before)
          const right = index(after)
          for (const [file, oid2] of right) {
            if (!left.has(file)) changed.push(`A ${file}`)
            else if (left.get(file) !== oid2) changed.push(`M ${file}`)
          }
          for (const file of left.keys()) if (!right.has(file)) changed.push(`D ${file}`)
          changed = changed.sort()
        } else {
          const tree = await repository.git.readTree({ fs: repository.fs, dir: repository.dir, oid: commit.oid })
          changed = tree.tree.filter((entry) => entry.type === "blob").map((entry) => `A ${entry.path}`)
        }

        let content = formatCommit(commit, { changed })
        if (input?.file) {
          try {
            const blob = await repository.git.readBlob({
              fs: repository.fs,
              dir: repository.dir,
              oid: commit.oid,
              filepath: input.file,
            })
            const body = Buffer.from(blob.blob).toString("utf8")
            content += `\n\n--- ${input.file} @ ${commit.oid.slice(0, 10)} ---\n${body}`
          } catch {
            content += `\n\n[${input.file} does not exist at ${commit.oid.slice(0, 10)}]`
          }
        }
        return text(content, { dir: repository.dir, oid: commit.oid, changed: changed.length })
      }),
  }
}
