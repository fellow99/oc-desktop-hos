import { openExistingRepository, guarded, resolveIdentity } from "../repo.js"
import { objectSchema, text } from "./shared.js"

export function createGitCommit(workspace) {
  return {
    name: "git_commit",
    description:
      "Create a commit from the current index. Set `stageAll` to stage every pending change first. " +
      "Author defaults to the repository's user.name/user.email configuration.",
    input: objectSchema(
      {
        message: { type: "string", description: "Commit message (first line becomes the subject)." },
        authorName: { type: "string", description: "Override the author name for this commit." },
        authorEmail: { type: "string", description: "Override the author email for this commit." },
        stageAll: { type: "boolean", description: "Stage all pending changes before committing (default: false)." },
        amend: { type: "boolean", description: "Amend the previous commit instead of creating a new one (default: false)." },
      },
      ["message"],
    ),
    options: { codemode: false },
    execute: async (input) =>
      guarded("git_commit", async () => {
        const repository = await openExistingRepository(workspace, input?.dir)
        const message = typeof input?.message === "string" ? input.message : ""
        if (message.trim().length === 0) return text("git_commit: `message` is required.")

        if (input?.stageAll) {
          const matrix = await repository.git.statusMatrix({ fs: repository.fs, dir: repository.dir })
          for (const [file, head, workdir, stage] of matrix) {
            if (head === 1 && workdir === 1 && stage === 1) continue
            if (head === 0 && workdir === 0) continue
            if (workdir === 0) await repository.git.remove({ fs: repository.fs, dir: repository.dir, filepath: file })
            else if (head === 0 || workdir === 2) {
              await repository.git.add({ fs: repository.fs, dir: repository.dir, filepath: file })
            }
          }
        }

        const identity = await resolveIdentity(repository)
        const author = {
          name: typeof input?.authorName === "string" && input.authorName.length > 0 ? input.authorName : identity.name,
          email: typeof input?.authorEmail === "string" && input.authorEmail.length > 0 ? input.authorEmail : identity.email,
        }
        const oid = await repository.git.commit({
          fs: repository.fs,
          dir: repository.dir,
          message,
          author,
          ...(input?.amend ? { amend: true } : {}),
        })
        const subject = message.split("\n")[0]
        return text(`Created commit ${oid.slice(0, 10)} (${author.name} <${author.email}>): ${subject}`, {
          dir: repository.dir,
          oid,
          author,
        })
      }),
  }
}
