import { openExistingRepository, guarded, currentBranch, headOid, inProgressOperations } from "../repo.js"
import { formatStatus, groupStatus } from "../report.js"
import { objectSchema, text } from "./shared.js"

export function createGitStatus(workspace) {
  return {
    name: "git_status",
    description:
      "Show the working tree status of a repository: staged changes, unstaged modifications/deletions, untracked files, " +
      "and any merge/cherry-pick/revert operation that is still in progress.",
    input: objectSchema({}),
    options: { codemode: false },
    execute: async (input) =>
      guarded("git_status", async () => {
        const repository = await openExistingRepository(workspace, input?.dir)
        const matrix = await repository.git.statusMatrix({ fs: repository.fs, dir: repository.dir })
        const groups = groupStatus(matrix)
        const branch = await currentBranch(repository)
        const head = await headOid(repository)
        const inProgress = inProgressOperations(repository.dir)
        const content = formatStatus(groups, { branch, head, inProgress })
        return text(content, {
          dir: repository.dir,
          branch: branch ?? null,
          head: head ?? null,
          staged: groups.staged.length,
          modified: groups.modified.length,
          deleted: groups.deleted.length,
          untracked: groups.untracked.length,
          inProgress,
        })
      }),
  }
}
