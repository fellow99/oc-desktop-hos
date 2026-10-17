import { openExistingRepository, guarded, currentBranch } from "../repo.js"
import { objectSchema, text } from "./shared.js"

export function createGitBranch(workspace) {
  return {
    name: "git_branch",
    description:
      "List, create, delete or rename branches. Listing marks the current branch with `*`. " +
      "Deleting a branch does not touch the remote.",
    input: {
      type: "object",
      properties: {
        dir: { type: "string", description: "Repository directory, relative to the workspace root." },
        action: {
          type: "string",
          enum: ["list", "create", "delete", "rename"],
          description: 'Operation to perform (default: "list").',
        },
        name: { type: "string", description: "Branch name (required for create/delete/rename)." },
        newName: { type: "string", description: "New name for rename." },
        checkout: { type: "boolean", description: "Switch to the branch right after creating it (default: false)." },
        remote: { type: "boolean", description: "List remote-tracking branches instead of local ones (default: false)." },
      },
      additionalProperties: false,
    },
    options: { codemode: false },
    execute: async (input) =>
      guarded("git_branch", async () => {
        const repository = await openExistingRepository(workspace, input?.dir)
        const action = input?.action ?? "list"
        if (action === "list") {
          const branches = await repository.git.listBranches({
            fs: repository.fs,
            dir: repository.dir,
            ...(input?.remote ? { remote: input.remote } : {}),
          })
          const current = await currentBranch(repository)
          const lines = branches.map((branch) => (branch === current ? `* ${branch}` : `  ${branch}`))
          return text(lines.length > 0 ? lines.join("\n") : "No branches yet.", {
            dir: repository.dir,
            count: branches.length,
            current: current ?? null,
          })
        }
        const name = typeof input?.name === "string" ? input.name : ""
        if (name.length === 0) return text(`git_branch: \`name\` is required for action "${action}".`)
        if (action === "create") {
          await repository.git.branch({
            fs: repository.fs,
            dir: repository.dir,
            ref: name,
            ...(input?.checkout ? { checkout: true } : {}),
          })
          return text(`Created branch ${name}${input?.checkout ? " and switched to it" : ""}.`, { dir: repository.dir, name })
        }
        if (action === "delete") {
          await repository.git.deleteBranch({ fs: repository.fs, dir: repository.dir, ref: name })
          return text(`Deleted branch ${name}.`, { dir: repository.dir, name })
        }
        const newName = typeof input?.newName === "string" ? input.newName : ""
        if (newName.length === 0) return text('git_branch: `newName` is required for action "rename".')
        await repository.git.renameBranch({ fs: repository.fs, dir: repository.dir, oldref: name, ref: newName })
        return text(`Renamed branch ${name} → ${newName}.`, { dir: repository.dir, name, newName })
      }),
  }
}
