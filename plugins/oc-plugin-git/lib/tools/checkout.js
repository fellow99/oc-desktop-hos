import { openExistingRepository, guarded, currentBranch } from "../repo.js"
import { objectSchema, text, PATHS_PROPERTY } from "./shared.js"

export function createGitCheckout(workspace) {
  return {
    name: "git_checkout",
    description:
      "Switch to a branch or commit, or restore specific paths from a ref. " +
      "Restoring paths overwrites the working tree copies of those paths only.",
    input: objectSchema(
      {
        ref: { type: "string", description: "Branch, tag or commit to check out (default: current branch)." },
        paths: PATHS_PROPERTY,
        force: { type: "boolean", description: "Discard conflicting local changes (default: false when switching)." },
      },
      [],
    ),
    options: { codemode: false },
    execute: async (input) =>
      guarded("git_checkout", async () => {
        const repository = await openExistingRepository(workspace, input?.dir)
        const paths = Array.isArray(input?.paths) ? input.paths.filter((path) => typeof path === "string" && path.length > 0) : []

        if (paths.length > 0) {
          await repository.git.checkout({
            fs: repository.fs,
            dir: repository.dir,
            filepaths: paths,
            force: true,
            ...(input?.ref ? { ref: input.ref } : {}),
          })
          return text(`Restored ${paths.length} path${paths.length === 1 ? "" : "s"} from ${input?.ref ?? "HEAD"}: ${paths.join(", ")}`, {
            dir: repository.dir,
            paths,
          })
        }

        const ref = typeof input?.ref === "string" && input.ref.length > 0 ? input.ref : undefined
        if (!ref) return text("git_checkout: `ref` is required when not restoring paths.")
        await repository.git.checkout({
          fs: repository.fs,
          dir: repository.dir,
          ref,
          ...(input?.force ? { force: true } : {}),
        })
        const branch = await currentBranch(repository)
        return text(`Checked out ${ref} (now on ${branch ?? "a detached HEAD"}).`, { dir: repository.dir, ref, branch: branch ?? null })
      }),
  }
}
