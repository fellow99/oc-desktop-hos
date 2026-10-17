import assert from "node:assert/strict"
import test from "node:test"
import { formatCommit, formatStatus, groupStatus, formatDiff, truncateText } from "../lib/report.js"
import { isBinary, countLineChanges } from "../lib/diff.js"

test("groupStatus 覆盖 statusMatrix 的全部文档语义", () => {
  const groups = groupStatus([
    ["a.txt", 0, 2, 0],
    ["b.txt", 0, 2, 2],
    ["c.txt", 0, 2, 3],
    ["d.txt", 1, 1, 1],
    ["e.txt", 1, 2, 1],
    ["f.txt", 1, 2, 2],
    ["g.txt", 1, 2, 3],
    ["h.txt", 1, 0, 1],
    ["i.txt", 1, 0, 0],
  ])
  assert.deepEqual(groups.untracked, ["a.txt"])
  assert.deepEqual(groups.staged, ["A b.txt", "A c.txt", "M f.txt", "M g.txt", "D i.txt"])
  assert.deepEqual(groups.modified, ["c.txt", "e.txt", "g.txt"])
  assert.deepEqual(groups.deleted, ["h.txt"])
})

test("formatStatus 空改动与分组标题", () => {
  assert.match(formatStatus(groupStatus([]), {}), /No changes\./u)
  const text = formatStatus(groupStatus([["x", 0, 2, 0]]), { branch: "main", head: "abcdef1234" })
  assert.match(text, /On branch main/u)
  assert.match(text, /Untracked \(1\)/u)
})

test("formatStatus 标出进行中的操作", () => {
  const text = formatStatus(groupStatus([]), { branch: "main", inProgress: ["merge"] })
  assert.match(text, /Operation in progress: merge/u)
})

test("formatCommit 渲染元信息与变更清单", () => {
  const text = formatCommit(
    {
      oid: "abcdef1234567890",
      commit: {
        message: "subject\n\nbody",
        author: { name: "A", email: "a@example.com", timestamp: 1700000000 },
        parent: ["p1"],
      },
    },
    { changed: ["A README.md"] },
  )
  assert.match(text, /commit abcdef1234567890/u)
  assert.match(text, /Author:  A <a@example.com>/u)
  assert.match(text, /Changed paths \(1\)/u)
})

test("formatDiff 汇总条目数并在超限时标注", () => {
  assert.equal(formatDiff([]), "No changes.")
  const text = formatDiff([{ patch: "--- a\n+++ b\n" }])
  assert.match(text, /1 changed path/u)
  const truncated = formatDiff([{ patch: "x".repeat(32) }], { maxTotalBytes: 4 })
  assert.match(truncated, /output truncated/u)
})

test("isBinary 按 NUL 判定；countLineChanges 统计增删行", () => {
  assert.equal(isBinary(Buffer.from("text")), false)
  assert.equal(isBinary(Buffer.from([0x61, 0x00, 0x62])), true)
  const diff = {
    diffLines(before, after) {
      return [
        { value: "same\n", count: 1 },
        { value: "old\n", removed: true, count: 1 },
        { value: "new\n", added: true, count: 1 },
      ]
    },
  }
  assert.deepEqual(countLineChanges(diff, "a", "b"), { additions: 1, deletions: 1, binary: false })
})

test("truncateText 只在超限时标注", () => {
  assert.equal(truncateText("short", 100), "short")
  assert.match(truncateText("x".repeat(200), 10), /truncated/u)
})
