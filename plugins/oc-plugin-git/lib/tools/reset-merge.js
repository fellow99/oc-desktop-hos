import { openExistingRepository, guarded, currentBranch, resolveIdentity } from "../repo.js"
import { objectSchema, text } from "./shared.js"

const MODES = ["soft", "mixed", "hard"]

async function moveHead(repository, oid) {
  const branch = await currentBranch(repository)
  if (branch) {
    await repository.git.writeRef({ fs: repository.fs, dir: repository.dir, ref: `refs/heads/${branch}`, value: oid, force: true })
  } else {
    await repository.git.writeRef({ fs: repository.fs, dir: repository.dir, ref: "HEAD", value: oid, force: true })
  }
}

export function createGitReset(workspace) {
  return {
    name: "git_reset",
    description:
      'Reset the current branch to a ref. "soft" only moves the branch pointer, "mixed" also resets the index, ' +
      '"hard" also overwrites the working tree (destructive).',
    input: objectSchema(
      {
        mode: { type: "string", enum: MODES, description: 'Reset mode (default: "mixed").' },
        ref: { type: "string", description: "Target commit/branch/tag (default: HEAD)." },
      },
      [],
    ),
    options: { codemode: false },
    execute: async (input) =>
      guarded("git_reset", async () => {
        const repository = await openExistingRepository(workspace, input?.dir)
        const mode = MODES.includes(input?.mode) ? input.mode : "mixed"
        const ref = typeof input?.ref === "string" && input.ref.length > 0 ? input.ref : "HEAD"
        const oid = await repository.git.resolveRef({ fs: repository.fs, dir: repository.dir, ref })

        await moveHead(repository, oid)

        if (mode !== "soft") {
          const { git, fs, dir } = repository
          const matrix = await git.statusMatrix({ fs, dir, ref: oid })
          for (const [file, head, workdir, stage] of matrix) {
            if (head === 1 && workdir === 1 && stage === 1) continue
            await git.resetIndex({ fs, dir, filepath: file, ref: oid })
          }
        }

        if (mode === "hard") {
          await repository.git.checkout({ fs: repository.fs, dir: repository.dir, ref: oid, force: true })
        }

        return text(
          `Reset (${mode}) to ${ref} (${oid.slice(0, 10)})` +
            `${mode === "hard" ? "; working tree overwritten" : mode === "mixed" ? "; index reset" : "; index and working tree untouched"}.`,
          { dir: repository.dir, mode, oid },
        )
      }),
  }
}

export function createGitMerge(workspace) {
  return {
    name: "git_merge",
    description:
      "Merge a branch into the current branch. Conflicts abort the merge by default so the working tree stays clean; " +
      'pass `abort: true` to discard an in-progress merge.',
    input: objectSchema(
      {
        theirs: { type: "string", description: "Branch (or ref) to merge into the current branch." },
        fastForwardOnly: { type: "boolean", description: "Refuse non-fast-forward merges (default: false)." },
        noFastForward: { type: "boolean", description: "Always create a merge commit (default: false)." },
        dryRun: { type: "boolean", description: "Only check whether the merge would succeed (default: false)." },
        abort: { type: "boolean", description: "Abort an in-progress merge instead of starting one." },
      },
      [],
    ),
    options: { codemode: false },
    execute: async (input) =>
      guarded("git_merge", async () => {
        const repository = await openExistingRepository(workspace, input?.dir)
        if (input?.abort) {
          await repository.git.abortMerge({ fs: repository.fs, dir: repository.dir })
          return text("Aborted the in-progress merge.", { dir: repository.dir })
        }
        const theirs = typeof input?.theirs === "string" ? input.theirs : ""
        if (theirs.length === 0) return text("git_merge: `theirs` is required unless `abort` is set.")
        const identity = await resolveIdentity(repository)
        const result = await repository.git.merge({
          fs: repository.fs,
          dir: repository.dir,
          theirs,
          author: identity,
          fastForward: input?.noFastForward ? false : true,
          fastForwardOnly: Boolean(input?.fastForwardOnly),
          dryRun: Boolean(input?.dryRun),
          abortOnConflict: true,
        })
        if (input?.dryRun) {
          return text(`Merge of ${theirs} would succeed (dry run, nothing changed).`, { dir: repository.dir, dryRun: true })
        }
        return text(
          result && result.oid
            ? `Merged ${theirs} (${result.alreadyMerged ? "already merged" : result.fastForward ? "fast-forward" : `merge commit ${result.oid.slice(0, 10)}`}).`
            : `Merged ${theirs}.`,
          { dir: repository.dir, oid: result?.oid ?? null },
        )
      }),
  }
}

export function createGitCherryPick(workspace) {
  return {
    name: "git_cherry_pick",
    description: "Apply one commit from another branch onto the current branch. Conflicts abort the operation.",
    input: objectSchema(
      {
        oid: { type: "string", description: "Commit to apply (hash or ref)." },
        abort: { type: "boolean", description: "Abort an in-progress cherry-pick instead of starting one." },
      },
      [],
    ),
    options: { codemode: false },
    execute: async (input) =>
      guarded("git_cherry_pick", async () => {
        const repository = await openExistingRepository(workspace, input?.dir)
        if (input?.abort) {
          await repository.git.abortMerge({ fs: repository.fs, dir: repository.dir })
          return text("Aborted the in-progress cherry-pick.", { dir: repository.dir })
        }
        const oid = typeof input?.oid === "string" ? input.oid : ""
        if (oid.length === 0) return text("git_cherry_pick: `oid` is required unless `abort` is set.")
        const identity = await resolveIdentity(repository)
        const result = await repository.git.cherryPick({
          fs: repository.fs,
          dir: repository.dir,
          oid,
          abortOnConflict: true,
          author: identity,
        })
        return text(`Cherry-picked ${oid.slice(0, 10)} → ${result?.oid ? result.oid.slice(0, 10) : "no new commit"}.`, {
          dir: repository.dir,
          oid: result?.oid ?? null,
        })
      }),
  }
}
