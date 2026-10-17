import { openExistingRepository, guarded } from "../repo.js"
import { countLineChanges, renderFileDiff } from "../diff.js"
import { formatDiff } from "../report.js"
import { walkDiff } from "../walk-diff.js"
import { objectSchema, text, PATHS_PROPERTY } from "./shared.js"

const MODES = ["workdir", "staged", "head", "refs"]

export function createGitDiff(workspace) {
  return {
    name: "git_diff",
    description:
      'Show a unified diff. mode "head" compares HEAD with the working tree, "workdir" compares the index with the working tree, ' +
      '"staged" compares HEAD with the index, and "refs" compares two refs (needs ref and ref2). ' +
      "Binary files are reported as differing without content.",
    input: objectSchema(
      {
        mode: { type: "string", enum: MODES, description: 'Comparison mode (default: "head").' },
        ref: { type: "string", description: 'Only meaningful with mode "refs" (left side); passing it in other modes is an error.' },
        ref2: { type: "string", description: 'Only meaningful with mode "refs" (right side); passing it in other modes is an error.' },
        paths: PATHS_PROPERTY,
        stat: { type: "boolean", description: "Only report per-file added/deleted line counts (default: false)." },
      },
      [],
    ),
    options: { codemode: false },
    execute: async (input) =>
      guarded("git_diff", async () => {
        const repository = await openExistingRepository(workspace, input?.dir)
        const mode = MODES.includes(input?.mode) ? input.mode : "head"
        if (mode !== "refs" && (input?.ref || input?.ref2)) {
          return text(
            `git_diff: ref/ref2 are only meaningful with mode "refs" (which needs both). ` +
              `mode "${mode}" always compares ${
                mode === "workdir" ? "the index with the working tree" : mode === "staged" ? "HEAD with the index" : "HEAD with the working tree"
              }.`,
          )
        }
        if (mode === "refs" && (!input?.ref || !input?.ref2)) {
          return text('git_diff: mode "refs" needs both `ref` and `ref2`.')
        }

        const { label, entries } = await walkDiff(repository, {
          mode,
          ref: input?.ref,
          ref2: input?.ref2,
          paths: Array.isArray(input?.paths) ? input.paths : undefined,
        })
        if (entries.length === 0) return text(`No changes (${label}).`, { mode, files: 0 })

        const rendered = entries.map((entry) => {
          if (input?.stat) {
            const counts = countLineChanges(repository.diff, entry.before, entry.after)
            return { ...entry, patch: "", additions: counts.additions, deletions: counts.deletions, binary: counts.binary }
          }
          const result = renderFileDiff({ diff: repository.diff, file: entry.file, before: entry.before, after: entry.after })
          return { ...entry, patch: result.patch, additions: result.additions, deletions: result.deletions, binary: result.binary }
        })

        if (input?.stat) {
          const lines = rendered.map((entry) => `${entry.binary ? "bin" : `${entry.additions}+/${entry.deletions}-`}  ${entry.file}`)
          return text(`${label}: ${rendered.length} changed path${rendered.length === 1 ? "" : "s"}\n${lines.join("\n")}`, {
            mode,
            files: rendered.length,
          })
        }

        return text(`diff (${label})\n${formatDiff(rendered)}`, {
          mode,
          files: rendered.length,
          additions: rendered.reduce((total, entry) => total + entry.additions, 0),
          deletions: rendered.reduce((total, entry) => total + entry.deletions, 0),
        })
      }),
  }
}
