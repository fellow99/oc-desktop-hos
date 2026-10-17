/**
 * 21 个工具的装配表（一动词一工具）。
 * 顺序即期望工具表顺序，`scripts/collect-app.mjs` 的期望表与这里必须一致。
 */
import { createGitInit } from "./init.js"
import { createGitClone } from "./clone.js"
import { createGitStatus } from "./status.js"
import { createGitDiff } from "./diff.js"
import { createGitAdd } from "./add.js"
import { createGitCommit } from "./commit.js"
import { createGitBranch } from "./branch.js"
import { createGitCheckout } from "./checkout.js"
import { createGitReset, createGitMerge, createGitCherryPick } from "./reset-merge.js"
import { createGitRevert } from "./revert.js"
import { createGitStash } from "./stash.js"
import { createGitTag } from "./tag.js"
import { createGitRemote } from "./remote.js"
import { createGitFetch, createGitPull } from "./fetch-pull.js"
import { createGitPush, createGitConfig } from "./push-config.js"
import { createGitLog, createGitShow } from "./log-show.js"

/** 工具名清单（构建期门禁与插件自检共用同一份真值） */
export const TOOL_NAMES = [
  "git_init",
  "git_clone",
  "git_status",
  "git_diff",
  "git_log",
  "git_show",
  "git_add",
  "git_commit",
  "git_branch",
  "git_checkout",
  "git_reset",
  "git_merge",
  "git_cherry_pick",
  "git_revert",
  "git_stash",
  "git_tag",
  "git_remote",
  "git_fetch",
  "git_pull",
  "git_push",
  "git_config",
]

export function buildTools(workspace) {
  return [
    createGitInit(workspace),
    createGitClone(workspace),
    createGitStatus(workspace),
    createGitDiff(workspace),
    createGitLog(workspace),
    createGitShow(workspace),
    createGitAdd(workspace),
    createGitCommit(workspace),
    createGitBranch(workspace),
    createGitCheckout(workspace),
    createGitReset(workspace),
    createGitMerge(workspace),
    createGitCherryPick(workspace),
    createGitRevert(workspace),
    createGitStash(workspace),
    createGitTag(workspace),
    createGitRemote(workspace),
    createGitFetch(workspace),
    createGitPull(workspace),
    createGitPush(workspace),
    createGitConfig(workspace),
  ]
}
