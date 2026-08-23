import { describe, expect, it } from "vitest";
import { classifyWorktree, type WorktreeFacts } from "../../src/cleanWorktree/classify.js";

// Baseline "everything fine" facts; each test overrides only what it needs
// to isolate a single bucketing decision, matching the bash reference
// implementation's `unsafe_reasons` logic.
const baseFacts: WorktreeFacts = {
  locked: false,
  lockReason: "",
  prunable: false,
  prunableReason: "",
  dirty: false,
  merged: false,
  upstream: null,
  aheadCount: null,
  defaultBranch: "main",
};

describe("classifyWorktree", () => {
  it("buckets a clean, merged worktree as safe", () => {
    const result = classifyWorktree({ ...baseFacts, merged: true });

    expect(result.bucket).toBe("safe");
    expect(result.reasons).toEqual([]);
  });

  it("buckets a clean, unmerged-but-fully-pushed worktree as safe", () => {
    const result = classifyWorktree({
      ...baseFacts,
      merged: false,
      upstream: "origin/feature",
      aheadCount: 0,
    });

    expect(result.bucket).toBe("safe");
    expect(result.reasons).toEqual([]);
  });

  it("buckets a dirty worktree as confirm with an uncommitted/untracked reason", () => {
    const result = classifyWorktree({ ...baseFacts, merged: true, dirty: true });

    expect(result.bucket).toBe("confirm");
    expect(result.reasons).toContain("uncommitted/untracked changes");
  });

  it("buckets an unmerged, unpushed worktree as confirm with an ahead-count reason", () => {
    const result = classifyWorktree({
      ...baseFacts,
      merged: false,
      upstream: "origin/feature",
      aheadCount: 3,
    });

    expect(result.bucket).toBe("confirm");
    expect(result.reasons).toEqual([
      "3 commit(s) ahead of origin/feature, not merged into main",
    ]);
  });

  it("buckets a worktree with no upstream and not merged as confirm with a distinct reason", () => {
    const result = classifyWorktree({
      ...baseFacts,
      merged: false,
      upstream: null,
      aheadCount: null,
    });

    expect(result.bucket).toBe("confirm");
    expect(result.reasons).toEqual([
      "not merged into main, no upstream to confirm it's pushed",
    ]);
  });

  it("falls back to 'a known default branch' when default-branch detection resolved nothing", () => {
    const result = classifyWorktree({
      ...baseFacts,
      merged: false,
      upstream: null,
      aheadCount: null,
      defaultBranch: null,
    });

    expect(result.bucket).toBe("confirm");
    expect(result.reasons).toEqual([
      "not merged into a known default branch, no upstream to confirm it's pushed",
    ]);
  });

  it("combines multiple reasons, dirty first, when more than one applies", () => {
    const result = classifyWorktree({
      ...baseFacts,
      dirty: true,
      merged: false,
      upstream: "origin/feature",
      aheadCount: 2,
    });

    expect(result.bucket).toBe("confirm");
    expect(result.reasons).toEqual([
      "uncommitted/untracked changes",
      "2 commit(s) ahead of origin/feature, not merged into main",
    ]);
  });

  it("buckets a locked worktree as locked regardless of dirty/merge facts", () => {
    const result = classifyWorktree({
      ...baseFacts,
      locked: true,
      lockReason: "still reviewing",
      dirty: true,
      merged: false,
    });

    expect(result.bucket).toBe("locked");
  });

  it("buckets a prunable worktree as prune regardless of dirty/merge facts", () => {
    const result = classifyWorktree({
      ...baseFacts,
      prunable: true,
      prunableReason: "gitdir file points to non-existent location",
      dirty: true,
      merged: false,
    });

    expect(result.bucket).toBe("prune");
  });

  it("prioritizes prune over locked when a worktree is somehow both", () => {
    const result = classifyWorktree({
      ...baseFacts,
      locked: true,
      prunable: true,
    });

    expect(result.bucket).toBe("prune");
  });
});
