import { describe, expect, it } from "vitest";

import type { BranchFacts } from "../../src/cleanBranches/classify.js";
import type { WorktreeFacts } from "../../src/cleanWorktree/classify.js";
import { classifyPristine, type PristineFacts } from "../../src/ensurePristine/classify.js";

// Baseline "everything fine" facts; each test overrides only what it needs
// to isolate a single decision, matching cleanWorktree/classify.test.ts's style.
const baseFacts: PristineFacts = {
  defaultBranch: "main",
  dirty: false,
  hasOriginRemote: false,
  originComparison: null,
  extraBranches: [],
  extraWorktrees: [],
};

const safeBranchFacts: BranchFacts = { checkedOutAt: null, merged: true, defaultBranch: "main" };
const confirmBranchFacts: BranchFacts = { checkedOutAt: null, merged: false, defaultBranch: "main" };

const safeWorktreeFacts: WorktreeFacts = {
  locked: false,
  lockReason: "",
  prunable: false,
  prunableReason: "",
  dirty: false,
  merged: true,
  upstream: null,
  aheadCount: null,
  defaultBranch: "main",
};
const confirmWorktreeFacts: WorktreeFacts = { ...safeWorktreeFacts, merged: false };
const lockedWorktreeFacts: WorktreeFacts = {
  ...safeWorktreeFacts,
  locked: true,
  lockReason: "still reviewing",
};

describe("classifyPristine", () => {
  it("reports PRISTINE for a resolved, clean default branch with no extras and no origin remote", () => {
    const result = classifyPristine(baseFacts);

    expect(result.verdict).toBe("PRISTINE");
  });

  it("reports NOT PRISTINE when the default branch can't be resolved, short-circuiting everything else", () => {
    // Genuinely dirty with extras and a diverged origin, so a short result
    // below can only come from the short-circuit -- not from a real (and
    // coincidentally empty) answer.
    const result = classifyPristine({
      ...baseFacts,
      defaultBranch: null,
      dirty: true,
      extraBranches: [{ name: "stray", facts: confirmBranchFacts }],
      extraWorktrees: [{ path: "/repos/repo1-wt", facts: confirmWorktreeFacts }],
      hasOriginRemote: true,
      originComparison: "diverged",
    });

    expect(result.verdict).toBe("NOT PRISTINE");
    if (result.verdict === "NOT PRISTINE") {
      expect(result.reasons).toEqual(["couldn't resolve a default branch"]);
      expect(result.extraBranches).toEqual([]);
      expect(result.extraWorktrees).toEqual([]);
    }
  });

  it("reports NOT PRISTINE when the default branch's working tree is dirty, short-circuiting the branch/worktree/origin checks", () => {
    const result = classifyPristine({
      ...baseFacts,
      dirty: true,
      extraBranches: [{ name: "stray", facts: confirmBranchFacts }],
      extraWorktrees: [{ path: "/repos/repo1-wt", facts: confirmWorktreeFacts }],
      hasOriginRemote: true,
      originComparison: "diverged",
    });

    expect(result.verdict).toBe("NOT PRISTINE");
    if (result.verdict === "NOT PRISTINE") {
      expect(result.reasons).toEqual(["uncommitted changes on main"]);
      expect(result.extraBranches).toEqual([]);
      expect(result.extraWorktrees).toEqual([]);
    }
  });

  it("reports NOT PRISTINE listing each extra branch by name with its classifyBranch bucket", () => {
    const result = classifyPristine({
      ...baseFacts,
      extraBranches: [
        { name: "safe-branch", facts: safeBranchFacts },
        { name: "confirm-branch", facts: confirmBranchFacts },
      ],
    });

    expect(result.verdict).toBe("NOT PRISTINE");
    if (result.verdict === "NOT PRISTINE") {
      expect(result.extraBranches).toEqual([
        { name: "safe-branch", bucket: "safe", reasons: [] },
        { name: "confirm-branch", bucket: "confirm", reasons: ["not merged into main"] },
      ]);
      expect(result.reasons).toEqual(["2 extra branch(es)"]);
    }
  });

  it("reports NOT PRISTINE listing each extra worktree by path with its classifyWorktree bucket", () => {
    const result = classifyPristine({
      ...baseFacts,
      extraWorktrees: [
        { path: "/repos/repo1-safe", facts: safeWorktreeFacts },
        { path: "/repos/repo1-locked", facts: lockedWorktreeFacts },
      ],
    });

    expect(result.verdict).toBe("NOT PRISTINE");
    if (result.verdict === "NOT PRISTINE") {
      expect(result.extraWorktrees).toEqual([
        { path: "/repos/repo1-safe", bucket: "safe", reasons: [] },
        { path: "/repos/repo1-locked", bucket: "locked", reasons: ["still reviewing"] },
      ]);
      expect(result.reasons).toEqual(["2 extra worktree(s)"]);
    }
  });

  it("reports NOT PRISTINE with a reason for a fast-forwardable (behind) origin comparison", () => {
    const result = classifyPristine({ ...baseFacts, hasOriginRemote: true, originComparison: "fast-forwardable" });

    expect(result.verdict).toBe("NOT PRISTINE");
    if (result.verdict === "NOT PRISTINE") {
      expect(result.reasons).toEqual(["main is behind origin"]);
    }
  });

  it("reports NOT PRISTINE with a reason for an ahead origin comparison", () => {
    const result = classifyPristine({ ...baseFacts, hasOriginRemote: true, originComparison: "ahead" });

    expect(result.verdict).toBe("NOT PRISTINE");
    if (result.verdict === "NOT PRISTINE") {
      expect(result.reasons).toEqual(["main is ahead of origin"]);
    }
  });

  it("reports NOT PRISTINE with a reason for a diverged origin comparison", () => {
    const result = classifyPristine({ ...baseFacts, hasOriginRemote: true, originComparison: "diverged" });

    expect(result.verdict).toBe("NOT PRISTINE");
    if (result.verdict === "NOT PRISTINE") {
      expect(result.reasons).toEqual(["main has diverged from origin"]);
    }
  });

  it("treats an up-to-date origin comparison as satisfying the origin criterion", () => {
    const result = classifyPristine({ ...baseFacts, hasOriginRemote: true, originComparison: "up-to-date" });

    expect(result.verdict).toBe("PRISTINE");
  });

  it("skips the origin-sync criterion entirely when there's no origin remote, even if a stray comparison value is present", () => {
    const result = classifyPristine({ ...baseFacts, hasOriginRemote: false, originComparison: "diverged" });

    expect(result.verdict).toBe("PRISTINE");
  });

  it("combines extra-branch, extra-worktree, and origin-sync reasons when more than one applies", () => {
    const result = classifyPristine({
      ...baseFacts,
      extraBranches: [{ name: "stray", facts: confirmBranchFacts }],
      extraWorktrees: [{ path: "/repos/repo1-wt", facts: confirmWorktreeFacts }],
      hasOriginRemote: true,
      originComparison: "ahead",
    });

    expect(result.verdict).toBe("NOT PRISTINE");
    if (result.verdict === "NOT PRISTINE") {
      expect(result.reasons).toEqual(["1 extra branch(es)", "1 extra worktree(s)", "main is ahead of origin"]);
    }
  });
});
