export type Bucket = "current" | "safe" | "confirm";

/**
 * Already-gathered facts about a single local branch, sufficient for
 * `classifyBranch` to decide its bucket with no I/O of its own.
 */
export type BranchFacts = {
  /** Worktree path the branch is checked out at, or null if it isn't checked out anywhere. */
  checkedOutAt: string | null;
  /** True when the branch is a proven ancestor of `defaultBranch`. */
  merged: boolean;
  /** The repo's resolved default branch -- always a real name by the time facts reach this function. */
  defaultBranch: string;
};

export type ClassifyResult = {
  bucket: Bucket;
  reasons: string[];
};

/**
 * Pure decision function: given a branch's already-gathered facts, decides
 * which bucket it falls into. No I/O -- safe to unit test with fixture
 * objects alone. Bucket order and reason strings are fixed and asserted by
 * this module's own tests.
 */
export function classifyBranch(facts: BranchFacts): ClassifyResult {
  if (facts.checkedOutAt !== null) {
    // Checked out short-circuits the decision entirely -- merged status isn't
    // even meaningful here, mirroring the locked/prunable short-circuit
    // precedent already used for worktrees.
    return { bucket: "current", reasons: [`checked out at ${facts.checkedOutAt}`] };
  }

  if (facts.merged) {
    return { bucket: "safe", reasons: [] };
  }

  return { bucket: "confirm", reasons: [`not merged into ${facts.defaultBranch}`] };
}
