import * as git from "./git.js";
import type { Worktree } from "./parseWorktrees.js";

export type Bucket = "prune" | "locked" | "safe" | "confirm";

/**
 * Already-gathered facts about a single worktree, sufficient for
 * `classifyWorktree` to decide its bucket with no I/O of its own.
 */
export type WorktreeFacts = {
  locked: boolean;
  /** "" when locked is true but no reason was given, or when not locked. */
  lockReason: string;
  prunable: boolean;
  /** "" when prunable is true but no reason was given, or when not prunable. */
  prunableReason: string;
  dirty: boolean;
  merged: boolean;
  upstream: string | null;
  /** Commits ahead of `upstream`; null when there's no upstream to compare against. */
  aheadCount: number | null;
  /** origin/HEAD, local main, or local master; null when none resolved. */
  defaultBranch: string | null;
};

export type ClassifyResult = {
  bucket: Bucket;
  reasons: string[];
};

/**
 * Pure decision function: given a worktree's already-gathered facts, decides
 * which bucket it falls into. No I/O — safe to unit test with fixture
 * objects alone. Mirrors the bash `cleanWorktrees` reference implementation
 * exactly (bucket order and reason strings).
 */
export function classifyWorktree(facts: WorktreeFacts): ClassifyResult {
  if (facts.prunable) {
    return { bucket: "prune", reasons: facts.prunableReason ? [facts.prunableReason] : [] };
  }

  if (facts.locked) {
    return { bucket: "locked", reasons: facts.lockReason ? [facts.lockReason] : [] };
  }

  const defaultBranchLabel = facts.defaultBranch ?? "a known default branch";
  const reasons: string[] = [];

  if (facts.dirty) {
    reasons.push("uncommitted/untracked changes");
  }

  if (!facts.merged) {
    if (facts.upstream === null) {
      reasons.push(
        `not merged into ${defaultBranchLabel}, no upstream to confirm it's pushed`,
      );
    } else if (facts.aheadCount !== null && facts.aheadCount > 0) {
      reasons.push(
        `${facts.aheadCount} commit(s) ahead of ${facts.upstream}, not merged into ${defaultBranchLabel}`,
      );
    }
  }

  return reasons.length === 0
    ? { bucket: "safe", reasons: [] }
    : { bucket: "confirm", reasons };
}

/**
 * Thin fact-gathering layer: produces the facts `classifyWorktree` needs for
 * a real worktree by calling git directly, then delegates to the pure
 * decision function. Not unit-tested here — covered by the end-to-end
 * integration suite instead, since it requires real git repos.
 *
 * `defaultBranch` is computed once per repo (via `git.defaultBranchRef`) and
 * passed in, since it doesn't vary per worktree within the same repo.
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

  const dirty = git.isWorkingTreeDirty(worktree.path);
  const merged = git.isMergedIntoDefault(worktree.path, defaultBranch);
  const upstream = merged ? null : git.getUpstream(worktree.path);
  const aheadCount = upstream === null ? null : git.aheadCount(worktree.path, upstream);

  return {
    locked: false,
    lockReason: "",
    prunable: false,
    prunableReason: "",
    dirty,
    merged,
    upstream,
    aheadCount,
    defaultBranch,
  };
}
