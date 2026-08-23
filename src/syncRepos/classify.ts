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

/**
 * One variant per `Outcome`, each its own single-literal member -- required
 * for `result.outcome === "..."` to narrow the union at all (TypeScript only
 * narrows a discriminated union across members with a single literal
 * discriminant each, not a union of literals per member). "no-remote"/"sync"
 * are only ever reached once `defaultBranch` has actually resolved, so those
 * two carry it along: callers acting on those outcomes get a real `string`
 * checkout target straight from the narrowed type, with no cast back onto
 * the original (still-nullable) facts needed to recover it.
 */
export type ClassifyResult =
  | { outcome: "no-default-branch"; reasons: string[] }
  | { outcome: "dirty"; reasons: string[] }
  | { outcome: "no-remote"; reasons: string[]; defaultBranch: string }
  | { outcome: "sync"; reasons: string[]; defaultBranch: string };

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
    return { outcome: "no-remote", reasons: [], defaultBranch: facts.defaultBranch };
  }

  return { outcome: "sync", reasons: [], defaultBranch: facts.defaultBranch };
}
