import { describe, expect, it } from "vitest";
import { classifyBranch, type BranchFacts } from "../../src/cleanBranches/classify.js";

const baseFacts: BranchFacts = {
  checkedOutAt: null,
  merged: false,
  defaultBranch: "main",
};

describe("classifyBranch", () => {
  it("buckets a checked-out branch as current, naming the worktree path", () => {
    const result = classifyBranch({ ...baseFacts, checkedOutAt: "/repos/repo1", merged: true });

    expect(result.bucket).toBe("current");
    expect(result.reasons).toEqual(["checked out at /repos/repo1"]);
  });

  it("buckets a checked-out branch as current regardless of merge status", () => {
    const result = classifyBranch({ ...baseFacts, checkedOutAt: "/repos/repo1", merged: false });

    expect(result.bucket).toBe("current");
    expect(result.reasons).toEqual(["checked out at /repos/repo1"]);
  });

  it("buckets a non-checked-out, merged branch as safe with no reason", () => {
    const result = classifyBranch({ ...baseFacts, checkedOutAt: null, merged: true });

    expect(result.bucket).toBe("safe");
    expect(result.reasons).toEqual([]);
  });

  it("buckets a non-checked-out, unmerged branch as confirm, naming the default branch", () => {
    const result = classifyBranch({ ...baseFacts, checkedOutAt: null, merged: false, defaultBranch: "main" });

    expect(result.bucket).toBe("confirm");
    expect(result.reasons).toEqual(["not merged into main"]);
  });

  it("names whichever default branch was resolved in the confirm reason", () => {
    const result = classifyBranch({ ...baseFacts, checkedOutAt: null, merged: false, defaultBranch: "origin/main" });

    expect(result.bucket).toBe("confirm");
    expect(result.reasons).toEqual(["not merged into origin/main"]);
  });
});
