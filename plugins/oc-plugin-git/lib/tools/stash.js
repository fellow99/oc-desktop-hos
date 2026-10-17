import { openExistingRepository, guarded, ensureIdentity } from "../repo.js"
import { objectSchema, text } from "./shared.js"

const OPERATIONS = ["push", "pop", "apply", "drop", "list", "clear"]

export function createGitStash(workspace) {
  return {
    name: "git_stash",
    description:
      "Stash the current changes, or list/apply/pop/drop/clear stash entries. " +
      '"pop" restores the newest entry and removes it; "apply" keeps it.',
    input: objectSchema(
      {
        op: { type: "string", enum: OPERATIONS, description: 'Stash operation (default: "push").' },
        message: { type: "string", description: 'Message for the stash entry (only for op "push").' },
        refIdx: { type: "integer", minimum: 0, description: 'Stash entry index for "apply"/"pop"/"drop" (default: 0).' },
      },
      [],
    ),
    options: { codemode: false },
    execute: async (input) =>
      guarded("git_stash", async () => {
        const repository = await openExistingRepository(workspace, input?.dir)
        const op = OPERATIONS.includes(input?.op) ? input.op : "push"

        if (op === "list") {
          const entries = await repository.git.stash({ fs: repository.fs, dir: repository.dir, op: "list" })
          if (!entries || entries.length === 0) return text("The stash is empty.", { dir: repository.dir, count: 0 })
          const lines = entries.map((entry, index) => `[${index}] ${entry}`)
          return text(`Stash (${entries.length} entr${entries.length === 1 ? "y" : "ies"}):\n${lines.join("\n")}`, {
            dir: repository.dir,
            count: entries.length,
          })
        }
        if (op === "clear") {
          await repository.git.stash({ fs: repository.fs, dir: repository.dir, op: "clear" })
          return text("Cleared the stash.", { dir: repository.dir })
        }
        if (op === "push") {
          // `stash` 原语直接读 config 里的身份（不接受 author 参数）：缺身份时先落占位身份并如实说明
          const identity = await ensureIdentity(repository)
          const result = await repository.git.stash({
            fs: repository.fs,
            dir: repository.dir,
            op: "push",
            ...(typeof input?.message === "string" && input.message.length > 0 ? { message: input.message } : {}),
          })
          const note = identity.applied
            ? ` (repository had no user.name/user.email; wrote the placeholder ${identity.identity.name} <${identity.identity.email}> — change it with git_config)`
            : ""
          if (!result) {
            return text(`Nothing to stash (the working tree has no changes).${note}`, {
              dir: repository.dir,
              identityApplied: identity.applied,
            })
          }
          return text(`Stashed the current changes (${String(result).slice(0, 10)}).${note}`, {
            dir: repository.dir,
            identityApplied: identity.applied,
          })
        }
        const refIdx = Number.isInteger(input?.refIdx) && input.refIdx >= 0 ? input.refIdx : 0
        await repository.git.stash({ fs: repository.fs, dir: repository.dir, op, refIdx })
        return text(`Stash ${op} completed for entry [${refIdx}].`, { dir: repository.dir, op, refIdx })
      }),
  }
}
