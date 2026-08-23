import { describe, expect, it } from "vitest";
import { DETACHED_HEAD, parseWorktrees } from "../../src/git/gitClient.js";

describe("parseWorktrees", () => {
  it("returns one record per worktree in order, main worktree first", () => {
    const porcelain = [
      "worktree /repos/example",
      "HEAD abc123",
      "branch refs/heads/main",
      "",
      "worktree /repos/example-feature",
      "HEAD def456",
      "branch refs/heads/feature",
      "",
      "worktree /repos/example-bugfix",
      "HEAD 789abc",
      "branch refs/heads/bugfix",
      "",
    ].join("\n");

    const result = parseWorktrees(porcelain);

    expect(result.map((w) => w.path)).toEqual([
      "/repos/example",
      "/repos/example-feature",
      "/repos/example-bugfix",
    ]);
    expect(result.map((w) => w.branch)).toEqual(["main", "feature", "bugfix"]);
  });

  it("captures a locked worktree's flag and reason", () => {
    const porcelain = [
      "worktree /repos/example",
      "HEAD abc123",
      "branch refs/heads/main",
      "",
      "worktree /repos/example-locked",
      "HEAD def456",
      "branch refs/heads/locked-branch",
      "locked because still reviewing",
      "",
    ].join("\n");

    const result = parseWorktrees(porcelain);
    const locked = result[1];

    expect(locked.locked).toBe(true);
    expect(locked.lockReason).toBe("because still reviewing");
  });

  it("captures a locked worktree with no reason given", () => {
    const porcelain = [
      "worktree /repos/example",
      "HEAD abc123",
      "branch refs/heads/main",
      "",
      "worktree /repos/example-locked",
      "HEAD def456",
      "branch refs/heads/locked-branch",
      "locked",
      "",
    ].join("\n");

    const result = parseWorktrees(porcelain);
    const locked = result[1];

    expect(locked.locked).toBe(true);
    expect(locked.lockReason).toBe("");
  });

  it("captures a prunable worktree's flag and reason", () => {
    const porcelain = [
      "worktree /repos/example",
      "HEAD abc123",
      "branch refs/heads/main",
      "",
      "worktree /repos/example-gone",
      "HEAD def456",
      "branch refs/heads/gone-branch",
      "prunable gitdir file points to non-existent location",
      "",
    ].join("\n");

    const result = parseWorktrees(porcelain);
    const prunable = result[1];

    expect(prunable.prunable).toBe(true);
    expect(prunable.prunableReason).toBe(
      "gitdir file points to non-existent location",
    );
  });

  it("represents a detached HEAD worktree distinctly from an empty branch", () => {
    const porcelain = [
      "worktree /repos/example",
      "HEAD abc123",
      "branch refs/heads/main",
      "",
      "worktree /repos/example-detached",
      "HEAD def456",
      "detached",
      "",
    ].join("\n");

    const result = parseWorktrees(porcelain);
    const detached = result[1];

    expect(detached.branch).not.toBe("");
    expect(detached.branch).toBe(DETACHED_HEAD);
  });
});
