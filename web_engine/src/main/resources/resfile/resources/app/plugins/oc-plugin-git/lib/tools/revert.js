import nodeFs from "node:fs"
import path from "node:path"
import { openExistingRepository, guarded, resolveCommitish, resolveIdentity, readTreeMap, diffTreeMaps } from "../repo.js"
import { objectSchema, text } from "./shared.js"

/**
 * 自建 `revert`（上游库没有、`cherryPick` 也没有 reversal 参数）。
 *
 * fail-closed 语义：先把工作区每个受影响路径的内容哈希与**目标提交**比对；只要有一处不同
 * （用户已改动 / 文件缺失），就整体拒绝并列出冲突路径 —— 绝不静默覆盖用户的工作区。
 */
export function createGitRevert(workspace) {
  return {
    name: "git_revert",
    description:
      "Create a commit that undoes one commit on the current branch. Refuses (fail-closed) when the affected paths " +
      "have local modifications, so it never overwrites the user's work.",
    input: objectSchema(
      {
        oid: { type: "string", description: "Commit to revert (hash or ref)." },
      },
      ["oid"],
    ),
    options: { codemode: false },
    execute: async (input) =>
      guarded("git_revert", async () => {
        const repository = await openExistingRepository(workspace, input?.dir)
        const target = typeof input?.oid === "string" ? input.oid : ""
        if (target.length === 0) return text("git_revert: `oid` is required.")

        // 分支名 / 完整 oid / 短 oid 都接受（原生 git 的行为）
        const oid = await resolveCommitish(repository, target)
        const commit = await repository.git.readCommit({ fs: repository.fs, dir: repository.dir, oid })
        const parents = commit.commit?.parent ?? []
        if (parents.length !== 1) {
          return text(
            `git_revert: refusing to revert ${oid.slice(0, 10)} — it has ${parents.length} parents ` +
              `(only single-parent commits can be reverted).`,
          )
        }

        const parentOid = parents[0]
        const parentTree = await readTreeMap(repository, parentOid)
        const targetTree = await readTreeMap(repository, oid)
        const changed = diffTreeMaps(parentTree, targetTree)
        if (changed.length === 0) return text(`git_revert: ${oid.slice(0, 10)} changes no paths.`)

        // fail-closed：工作区与**索引**都必须与目标提交一致（暂存的改动同样不能被静默覆盖）
        const matrix = await repository.git.statusMatrix({ fs: repository.fs, dir: repository.dir })
        const staged = new Map()
        for (const [file, head, workdir, stage] of matrix) staged.set(file, { head, workdir, stage })
        const conflicts = []
        for (const entry of changed) {
          const file = entry.slice(2)
          const expected = targetTree.get(file)
          const absolute = path.resolve(repository.dir, file)
          let actual
          try {
            actual = nodeFs.readFileSync(absolute)
          } catch {
            actual = undefined
          }
          if (expected === undefined) {
            if (actual !== undefined) conflicts.push(file)
            continue
          }
          if (actual === undefined) {
            conflicts.push(file)
            continue
          }
          const hash = await repository.git.hashBlob({ object: actual })
          if (hash.oid !== expected) {
            conflicts.push(file)
            continue
          }
          // 索引里与该路径不同（有暂存改动）也算冲突：物化父提交会覆盖掉它
          const row = staged.get(file)
          if (row && row.head === 1 && row.stage !== 1) conflicts.push(`${file} (staged)`)
        }
        if (conflicts.length > 0) {
          return text(
            `git_revert: refusing to revert ${oid.slice(0, 10)} — these paths have local modifications ` +
              `(${conflicts.length}): ${conflicts.join(", ")}. Commit or discard them first.`,
          )
        }

        // 把父提交的内容物化到工作区
        const restored = []
        for (const entry of changed) {
          const file = entry.slice(2)
          const absolute = path.resolve(repository.dir, file)
          const parentBlobOid = parentTree.get(file)
          if (parentBlobOid === undefined) {
            try {
              await repository.fs.promises.unlink(absolute)
            } catch (error) {
              if (error?.code !== "ENOENT") throw error
            }
            restored.push(`D ${file}`)
            continue
          }
          const blob = await repository.git.readBlob({ fs: repository.fs, dir: repository.dir, oid: parentBlobOid })
          nodeFs.mkdirSync(path.dirname(absolute), { recursive: true })
          await repository.fs.promises.writeFile(absolute, Buffer.from(blob.blob))
          restored.push(`M ${file}`)
        }

        for (const entry of changed) {
          await repository.git.add({ fs: repository.fs, dir: repository.dir, filepath: entry.slice(2) })
        }

        const identity = await resolveIdentity(repository)
        const subject = (commit.commit?.message ?? "").split("\n")[0]
        const newOid = await repository.git.commit({
          fs: repository.fs,
          dir: repository.dir,
          message: `Revert "${subject}"\n\nThis reverts commit ${oid}.`,
          author: identity,
        })
        return text(`Reverted ${oid.slice(0, 10)} → new commit ${newOid.slice(0, 10)} (${restored.join(", ")}).`, {
          dir: repository.dir,
          reverted: oid,
          oid: newOid,
          paths: restored,
        })
      }),
  }
}
