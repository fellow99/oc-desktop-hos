import nodeFs from "node:fs"
import path from "node:path"
import { openExistingRepository, guarded } from "../repo.js"
import { objectSchema, text, PATHS_PROPERTY } from "./shared.js"

export function createGitAdd(workspace) {
  return {
    name: "git_add",
    description:
      "Stage paths for the next commit (`remove: true` stages a deletion instead). " +
      "Directories are walked recursively. Paths must be inside the repository root.",
    input: objectSchema(
      {
        files: PATHS_PROPERTY,
        remove: { type: "boolean", description: "Stage these paths as deleted (default: false)." },
      },
      ["files"],
    ),
    options: { codemode: false },
    execute: async (input) =>
      guarded("git_add", async () => {
        const repository = await openExistingRepository(workspace, input?.dir)
        const files = Array.isArray(input?.files) ? input.files.filter((file) => typeof file === "string" && file.length > 0) : []
        if (files.length === 0) return text("git_add: `files` must list at least one path.")

        const staged = []
        const missing = []
        for (const file of files) {
          const absolute = path.resolve(repository.dir, file)
          const exists = nodeFs.existsSync(absolute)
          if (input?.remove || !exists) {
            if (!exists) missing.push(file)
            await repository.git.remove({ fs: repository.fs, dir: repository.dir, filepath: file })
            staged.push(`D ${file}`)
            continue
          }
          await repository.git.add({ fs: repository.fs, dir: repository.dir, filepath: file })
          staged.push(`A/M ${file}`)
        }

        const lines = [`Staged for commit (${staged.length}):`, ...staged.map((item) => `  ${item}`)]
        if (missing.length > 0) lines.push("", `Not on disk (staged as deletion): ${missing.join(", ")}`)
        return text(lines.join("\n"), { dir: repository.dir, staged })
      }),
  }
}
