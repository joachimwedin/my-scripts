import * as fs from "node:fs";
import * as path from "node:path";

import type { WorktreeFacts } from "../cleanWorktree/classify.js";
import { aheadCount, getUpstream, isWorkingTreeDirty, mergeBase, showRef, symbolicRef } from "./gitClient.js";
import type { Worktree } from "./gitClient.js";

/**
 * Ready-to-use, decision-ready facts for callers -- most composed from
 * multiple `gitClient` calls, but not exclusively; `listRepoNames` below
 * answers its question via `fs` directly. No decision logic of its own lives
 * here -- that's `classify.ts`'s job; this module only answers questions
 * that take more than one raw fact (or a different mechanism than a single
 * git subprocess call) to answer.
 */

/**
 * A ref to compare a worktree's branch against for "merged" status:
 * `origin/HEAD`'s target if set, else local `main`, else local `master`.
 * Returns null if none of those resolve -- callers then treat merged status
 * as unconfirmed rather than guessing.
 */
export function resolveDefaultBranch(repoPath: string): string | null {
  const originHead = symbolicRef(repoPath, "refs/remotes/origin/HEAD");
  if (originHead !== null) {
    return originHead;
  }

  for (const candidate of ["main", "master"]) {
    if (showRef(repoPath, `refs/heads/${candidate}`)) {
      return candidate;
    }
  }

  return null;
}

/**
 * Composes the raw facts above into the shape `classifyWorktree` needs for a
 * real worktree. `defaultBranch` is computed once per repo (via
 * `resolveDefaultBranch`) and passed in, since it doesn't vary per worktree
 * within the same repo.
 */
export function gatherWorktreeFacts(worktree: Worktree, defaultBranch: string | null): WorktreeFacts {
  if (worktree.prunable) {
    // The worktree's directory is already gone -- no git commands can be
    // run against it, and none of the other facts matter for this bucket.
    return {
      locked: worktree.locked,
      lockReason: worktree.lockReason,
      prunable: true,
      prunableReason: worktree.prunableReason,
      dirty: false,
      merged: false,
      upstream: null,
      aheadCount: null,
      defaultBranch,
    };
  }

  if (worktree.locked) {
    // Locked worktrees are never touched or prompted about -- no need to
    // gather the rest of the facts.
    return {
      locked: true,
      lockReason: worktree.lockReason,
      prunable: false,
      prunableReason: "",
      dirty: false,
      merged: false,
      upstream: null,
      aheadCount: null,
      defaultBranch,
    };
  }

  const dirty = isWorkingTreeDirty(worktree.path);
  const merged = defaultBranch === null ? false : mergeBase(worktree.path, "HEAD", defaultBranch);
  const upstream = merged ? null : getUpstream(worktree.path);
  const aheadCountResult = upstream === null ? null : aheadCount(worktree.path, upstream);

  return {
    locked: false,
    lockReason: "",
    prunable: false,
    prunableReason: "",
    dirty,
    merged,
    upstream,
    aheadCount: aheadCountResult,
    defaultBranch,
  };
}

/** Directory names directly under `reposDir` that are themselves git repos (have a `.git` directory). */
export function listRepoNames(reposDir: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(reposDir, { withFileTypes: true });
  } catch {
    return [];
  }

  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => {
      try {
        return fs.statSync(path.join(reposDir, name, ".git")).isDirectory();
      } catch {
        return false;
      }
    })
    .sort((a, b) => a.localeCompare(b));
}
