import { openExistingRepository, guarded, resolveIdentity } from "../repo.js"
import { objectSchema, text } from "./shared.js"

export function createGitTag(workspace) {
  return {
    name: "git_tag",
    description:
      "List, create (lightweight or annotated) or delete local tags. Pushing tags is done with git_push.",
    input: {
      type: "object",
      properties: {
        dir: { type: "string", description: "Repository directory, relative to the workspace root." },
        action: { type: "string", enum: ["list", "create", "delete"], description: 'Operation to perform (default: "list").' },
        name: { type: "string", description: "Tag name (required for create/delete)." },
        ref: { type: "string", description: "Commit/branch the tag points at (default: HEAD)." },
        message: { type: "string", description: "When set, creates an annotated tag with this message." },
      },
      additionalProperties: false,
    },
    options: { codemode: false },
    execute: async (input) =>
      guarded("git_tag", async () => {
        const repository = await openExistingRepository(workspace, input?.dir)
        const action = input?.action ?? "list"
        if (action === "list") {
          const tags = await repository.git.listTags({ fs: repository.fs, dir: repository.dir })
          return text(tags.length > 0 ? tags.join("\n") : "No tags.", { dir: repository.dir, count: tags.length })
        }
        const name = typeof input?.name === "string" ? input.name : ""
        if (name.length === 0) return text(`git_tag: \`name\` is required for action "${action}".`)
        if (action === "delete") {
          await repository.git.deleteTag({ fs: repository.fs, dir: repository.dir, ref: name })
          return text(`Deleted tag ${name}.`, { dir: repository.dir, name })
        }
        const ref = typeof input?.ref === "string" && input.ref.length > 0 ? input.ref : "HEAD"
        const oid = await repository.git.resolveRef({ fs: repository.fs, dir: repository.dir, ref })
        if (typeof input?.message === "string" && input.message.length > 0) {
          const tagger = await resolveIdentity(repository)
          await repository.git.annotatedTag({
            fs: repository.fs,
            dir: repository.dir,
            ref: name,
            object: oid,
            message: input.message,
            tagger,
          })
          return text(`Created annotated tag ${name} → ${oid.slice(0, 10)}.`, { dir: repository.dir, name, oid })
        }
        await repository.git.tag({ fs: repository.fs, dir: repository.dir, ref: name, object: oid })
        return text(`Created tag ${name} → ${oid.slice(0, 10)}.`, { dir: repository.dir, name, oid })
      }),
  }
}
