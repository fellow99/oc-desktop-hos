import { openRepository, guarded } from "../repo.js"
import { objectSchema, text } from "./shared.js"

export function createGitInit(workspace) {
  return {
    name: "git_init",
    description:
      "Initialize a new git repository (creates .git) in a directory inside the workspace. " +
      "Use git_clone instead when the repository already exists on a remote.",
    input: objectSchema({
      defaultBranch: { type: "string", description: 'Name of the initial branch (default: "main").' },
    }),
    options: { codemode: false },
    execute: async (input) =>
      guarded("git_init", async () => {
        const repository = await openRepository(workspace, input?.dir)
        const defaultBranch = typeof input?.defaultBranch === "string" && input.defaultBranch.length > 0 ? input.defaultBranch : "main"
        await repository.git.init({ fs: repository.fs, dir: repository.dir, defaultBranch })
        return text(`Initialized empty git repository in ${repository.dir} (default branch "${defaultBranch}").`, {
          dir: repository.dir,
          defaultBranch,
        })
      }),
  }
}
