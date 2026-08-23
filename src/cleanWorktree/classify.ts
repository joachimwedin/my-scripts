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
 * objects alone. Bucket order and reason strings are fixed and asserted by
 * this module's own tests.
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
