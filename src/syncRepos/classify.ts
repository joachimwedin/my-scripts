export type Outcome = "no-default-branch" | "dirty" | "no-remote" | "sync";

/**
 * Already-gathered facts about a single repo, sufficient for `classifySync`
 * to decide its outcome with no I/O of its own.
 */
export type SyncFacts = {
  /** The repo's resolved default branch (the checkout target), or null if it couldn't be resolved at all. */
  defaultBranch: string | null;
  /** True when the repo's working tree has uncommitted changes. */
  dirty: boolean;
  /** True when the repo has an `origin` remote configured. */
  hasOriginRemote: boolean;
};

export type ClassifyResult = {
  outcome: Outcome;
  reasons: string[];
};

/**
 * Pure decision function: given a repo's already-gathered facts, decides
 * which sync outcome it falls into. No I/O -- safe to unit test with fixture
 * objects alone. Unresolved default branch is checked first and short-
 * circuits the rest of the decision, mirroring the existing locked/prunable
 * and checked-out short-circuit precedent already used for worktrees/branches.
 */
export function classifySync(facts: SyncFacts): ClassifyResult {
  if (facts.defaultBranch === null) {
    return { outcome: "no-default-branch", reasons: ["default branch could not be resolved"] };
  }

  if (facts.dirty) {
    return { outcome: "dirty", reasons: ["working tree has uncommitted changes"] };
  }

  if (!facts.hasOriginRemote) {
    return { outcome: "no-remote", reasons: [] };
  }

  return { outcome: "sync", reasons: [] };
}
