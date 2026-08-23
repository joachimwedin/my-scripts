import { describe, expect, it } from "vitest";
import { classifySync, type SyncFacts } from "../../src/syncRepos/classify.js";

const baseFacts: SyncFacts = {
  defaultBranch: "main",
  dirty: false,
  hasOriginRemote: true,
};

describe("classifySync", () => {
  it("buckets an unresolved default branch as no-default-branch, regardless of dirty/remote status", () => {
    const result = classifySync({ ...baseFacts, defaultBranch: null, dirty: true, hasOriginRemote: true });

    expect(result.outcome).toBe("no-default-branch");
    expect(result.reasons).toEqual(["default branch could not be resolved"]);
  });

  it("buckets an unresolved default branch as no-default-branch even with no remote either", () => {
    const result = classifySync({ ...baseFacts, defaultBranch: null, dirty: false, hasOriginRemote: false });

    expect(result.outcome).toBe("no-default-branch");
    expect(result.reasons).toEqual(["default branch could not be resolved"]);
  });

  it("buckets a resolved, dirty repo as dirty, regardless of remote presence", () => {
    const result = classifySync({ ...baseFacts, defaultBranch: "main", dirty: true, hasOriginRemote: true });

    expect(result.outcome).toBe("dirty");
    expect(result.reasons).toEqual(["working tree has uncommitted changes"]);
  });

  it("buckets a resolved, dirty repo as dirty even with no remote", () => {
    const result = classifySync({ ...baseFacts, defaultBranch: "main", dirty: true, hasOriginRemote: false });

    expect(result.outcome).toBe("dirty");
    expect(result.reasons).toEqual(["working tree has uncommitted changes"]);
  });

  it("buckets a resolved, clean repo with no origin remote as no-remote", () => {
    const result = classifySync({ ...baseFacts, defaultBranch: "main", dirty: false, hasOriginRemote: false });

    expect(result.outcome).toBe("no-remote");
    expect(result.reasons).toEqual([]);
  });

  it("buckets a resolved, clean repo with an origin remote as sync", () => {
    const result = classifySync({ ...baseFacts, defaultBranch: "main", dirty: false, hasOriginRemote: true });

    expect(result.outcome).toBe("sync");
    expect(result.reasons).toEqual([]);
  });
});
