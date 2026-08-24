import { classifyBranch, type BranchFacts, type Bucket as BranchBucket } from "../cleanBranches/classify.js";
import { classifyWorktree, type WorktreeFacts, type Bucket as WorktreeBucket } from "../cleanWorktree/classify.js";

/**
 * Already-gathered facts about a single repo, sufficient for
 * `classifyPristine` to decide PRISTINE/NOT PRISTINE with no I/O of its own.
 * `extraBranches`/`extraWorktrees` carry every local branch/worktree other
 * than the default branch/main worktree, each still holding its own raw
 * `BranchFacts`/`WorktreeFacts` -- bucketing happens inside
 * `classifyPristine` itself (via the existing, unchanged
 * `classifyBranch`/`classifyWorktree`), purely as diagnostic detail: any
 * extra branch or worktree at all makes the repo not-pristine, regardless of
 * which bucket it lands in.
 */
export type PristineFacts = {
  /** The repo's resolved default branch (local name), or null if it couldn't be resolved at all. */
  defaultBranch: string | null;
  /** True when the default branch's working tree has uncommitted changes. */
  dirty: boolean;
  /** True when the repo has an `origin` remote configured. */
  hasOriginRemote: boolean;
  /** How the default branch compares to `origin`; null when there's no `origin` remote (not applicable). */
  originComparison: "up-to-date" | "fast-forwardable" | "ahead" | "diverged" | null;
  /** Every local branch other than the default branch, by name, with its own facts. */
  extraBranches: { name: string; facts: BranchFacts }[];
  /** Every worktree other than the main one, by path, with its own facts. */
  extraWorktrees: { path: string; facts: WorktreeFacts }[];
};

/** Diagnostic detail for one extra branch: its `classifyBranch` bucket and reasons, alongside its name. */
export type ExtraBranchDetail = { name: string; bucket: BranchBucket; reasons: string[] };

/** Diagnostic detail for one extra worktree: its `classifyWorktree` bucket and reasons, alongside its path. */
export type ExtraWorktreeDetail = { path: string; bucket: WorktreeBucket; reasons: string[] };

/**
 * One variant per verdict -- required for `result.verdict === "..."` to
 * narrow the union at all. `"NOT PRISTINE"` carries the summary `reasons`
 * plus the bucketed extra-branch/extra-worktree diagnostic detail;
 * `"PRISTINE"` carries nothing further since there's nothing left to report.
 */
export type ClassifyResult =
  | { verdict: "PRISTINE" }
  | {
      verdict: "NOT PRISTINE";
      reasons: string[];
      extraBranches: ExtraBranchDetail[];
      extraWorktrees: ExtraWorktreeDetail[];
    };

/**
 * Pure decision function: given a repo's already-gathered facts, decides
 * PRISTINE vs NOT PRISTINE. No I/O -- safe to unit test with fixture objects
 * alone. Unresolved default branch and a dirty default branch each
 * short-circuit the rest of the decision entirely (mirroring the existing
 * short-circuit precedent in `classifySync`/`classifyWorktree`/
 * `classifyBranch`): neither extra branches/worktrees nor the origin
 * comparison are evaluated in those two cases. Beyond that point, extra
 * branches, extra worktrees, and an out-of-sync `origin` are independent,
 * additive reasons -- any combination of them can apply to the same repo at
 * once.
 */
export function classifyPristine(facts: PristineFacts): ClassifyResult {
  if (facts.defaultBranch === null) {
    return {
      verdict: "NOT PRISTINE",
      reasons: ["couldn't resolve a default branch"],
      extraBranches: [],
      extraWorktrees: [],
    };
  }

  if (facts.dirty) {
    return {
      verdict: "NOT PRISTINE",
      reasons: [`uncommitted changes on ${facts.defaultBranch}`],
      extraBranches: [],
      extraWorktrees: [],
    };
  }

  const extraBranches: ExtraBranchDetail[] = facts.extraBranches.map(({ name, facts: branchFacts }) => {
    const result = classifyBranch(branchFacts);
    return { name, bucket: result.bucket, reasons: result.reasons };
  });

  const extraWorktrees: ExtraWorktreeDetail[] = facts.extraWorktrees.map(({ path, facts: worktreeFacts }) => {
    const result = classifyWorktree(worktreeFacts);
    return { path, bucket: result.bucket, reasons: result.reasons };
  });

  const reasons: string[] = [];

  if (extraBranches.length > 0) {
    reasons.push(`${extraBranches.length} extra branch(es)`);
  }

  if (extraWorktrees.length > 0) {
    reasons.push(`${extraWorktrees.length} extra worktree(s)`);
  }

  if (facts.hasOriginRemote && facts.originComparison !== null && facts.originComparison !== "up-to-date") {
    const originReason =
      facts.originComparison === "fast-forwardable"
        ? `${facts.defaultBranch} is behind origin`
        : facts.originComparison === "ahead"
          ? `${facts.defaultBranch} is ahead of origin`
          : `${facts.defaultBranch} has diverged from origin`;
    reasons.push(originReason);
  }

  return reasons.length === 0
    ? { verdict: "PRISTINE" }
    : { verdict: "NOT PRISTINE", reasons, extraBranches, extraWorktrees };
}
