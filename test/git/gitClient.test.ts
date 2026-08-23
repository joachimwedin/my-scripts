import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  clearStash,
  getUpstream,
  listStash,
  listWorktrees,
  pruneWorktrees,
  removeWorktree,
  showRef,
  symbolicRef,
} from "../../src/git/gitClient.js";
import { addStash, addWorktree, createTempDirTracker, git, initBareRemote, initRepo } from "./gitFixtures.js";

/**
 * Seam-level tests for gitClient.ts's own git-invocation functions, against
 * real temporary git repos -- no CLI subprocess, no pty. Direct coverage for
 * logic that was previously only reachable transitively through
 * cli.test.ts's end-to-end suite.
 */

const { makeTempDir, cleanup } = createTempDirTracker();
afterEach(cleanup);

describe("listWorktrees", () => {
  it("returns the main worktree plus every linked worktree, main first", () => {
    const reposDir = makeTempDir("repos-");
    const repo = initRepo(reposDir, "repo1");
    addWorktree(repo, "feature-branch", path.join(reposDir, "repo1-feature"));

    const result = listWorktrees(repo);

    expect(result.map((w) => w.path)).toEqual([repo, path.join(reposDir, "repo1-feature")]);
    expect(result[1].branch).toBe("feature-branch");
  });

  it("reports a locked worktree's locked flag and reason", () => {
    const reposDir = makeTempDir("repos-");
    const repo = initRepo(reposDir, "repo1");
    const lockedPath = path.join(reposDir, "repo1-locked");
    addWorktree(repo, "locked-branch", lockedPath);
    git(repo, ["worktree", "lock", lockedPath, "--reason", "in use"]);

    const result = listWorktrees(repo);
    const locked = result.find((w) => w.path === lockedPath)!;

    expect(locked.locked).toBe(true);
    expect(locked.lockReason).toBe("in use");
  });

  it("reports a worktree whose directory has been deleted as prunable", () => {
    const reposDir = makeTempDir("repos-");
    const repo = initRepo(reposDir, "repo1");
    const gonePath = path.join(reposDir, "repo1-gone");
    addWorktree(repo, "gone-branch", gonePath);
    fs.rmSync(gonePath, { recursive: true, force: true });

    const result = listWorktrees(repo);
    const gone = result.find((w) => w.path === gonePath)!;

    expect(gone.prunable).toBe(true);
    expect(gone.prunableReason).not.toBe("");
  });
});

describe("pruneWorktrees", () => {
  it("clears stale worktree admin data for a worktree whose directory is gone", () => {
    const reposDir = makeTempDir("repos-");
    const repo = initRepo(reposDir, "repo1");
    const gonePath = path.join(reposDir, "repo1-gone");
    addWorktree(repo, "gone-branch", gonePath);
    fs.rmSync(gonePath, { recursive: true, force: true });

    pruneWorktrees(repo);

    const porcelain = git(repo, ["worktree", "list", "--porcelain"]);
    expect(porcelain).not.toContain("repo1-gone");
  });
});

describe("removeWorktree", () => {
  it("removes a clean worktree", () => {
    const reposDir = makeTempDir("repos-");
    const repo = initRepo(reposDir, "repo1");
    const cleanPath = path.join(reposDir, "repo1-clean");
    addWorktree(repo, "clean-branch", cleanPath);

    removeWorktree(repo, cleanPath);

    expect(fs.existsSync(cleanPath)).toBe(false);
    const porcelain = git(repo, ["worktree", "list", "--porcelain"]);
    expect(porcelain).not.toContain("repo1-clean");
  });

  it("removes a dirty worktree with { force: true } that would otherwise refuse", () => {
    const reposDir = makeTempDir("repos-");
    const repo = initRepo(reposDir, "repo1");
    const dirtyPath = path.join(reposDir, "repo1-dirty");
    addWorktree(repo, "dirty-branch", dirtyPath);
    fs.writeFileSync(path.join(dirtyPath, "f.txt"), "changed\n");

    expect(() => removeWorktree(repo, dirtyPath)).toThrow();
    expect(fs.existsSync(dirtyPath)).toBe(true);

    removeWorktree(repo, dirtyPath, { force: true });

    expect(fs.existsSync(dirtyPath)).toBe(false);
  });

  it("never deletes the underlying branch, clean or forced", () => {
    const reposDir = makeTempDir("repos-");
    const repo = initRepo(reposDir, "repo1");
    const cleanPath = path.join(reposDir, "repo1-clean");
    addWorktree(repo, "clean-branch", cleanPath);
    removeWorktree(repo, cleanPath);
    expect(git(repo, ["branch", "--list", "clean-branch"])).toContain("clean-branch");

    const dirtyPath = path.join(reposDir, "repo1-dirty");
    addWorktree(repo, "dirty-branch", dirtyPath);
    fs.writeFileSync(path.join(dirtyPath, "f.txt"), "changed\n");
    removeWorktree(repo, dirtyPath, { force: true });
    expect(git(repo, ["branch", "--list", "dirty-branch"])).toContain("dirty-branch");
  });
});

describe("symbolicRef", () => {
  it("resolves a real symbolic ref", () => {
    const reposDir = makeTempDir("repos-");
    const repo = initRepo(reposDir, "repo1");
    const remote = initBareRemote(reposDir, "origin.git");
    git(repo, ["remote", "add", "origin", remote]);
    git(repo, ["push", "-q", "-u", "origin", "main"]);
    git(repo, ["remote", "set-head", "origin", "main"]);

    const result = symbolicRef(repo, "refs/remotes/origin/HEAD");

    expect(result).toBe("origin/main");
  });

  it("returns null when the ref doesn't exist", () => {
    const reposDir = makeTempDir("repos-");
    const repo = initRepo(reposDir, "repo1");

    const result = symbolicRef(repo, "refs/remotes/origin/HEAD");

    expect(result).toBeNull();
  });
});

describe("listStash", () => {
  it("returns an empty array when there are no stashes", () => {
    const reposDir = makeTempDir("repos-");
    const repo = initRepo(reposDir, "repo1");

    const result = listStash(repo);

    expect(result).toEqual([]);
  });

  it("returns one entry for a single stash", () => {
    const reposDir = makeTempDir("repos-");
    const repo = initRepo(reposDir, "repo1");
    addStash(repo, "wip1");

    const result = listStash(repo);

    expect(result).toHaveLength(1);
    expect(result[0]).toContain("wip1");
  });

  it("returns multiple entries, newest first", () => {
    const reposDir = makeTempDir("repos-");
    const repo = initRepo(reposDir, "repo1");
    addStash(repo, "wip1");
    addStash(repo, "wip2");

    const result = listStash(repo);

    expect(result).toHaveLength(2);
    expect(result[0]).toContain("wip2");
    expect(result[1]).toContain("wip1");
  });
});

describe("clearStash", () => {
  it("clears every stash entry", () => {
    const reposDir = makeTempDir("repos-");
    const repo = initRepo(reposDir, "repo1");
    addStash(repo, "wip1");
    addStash(repo, "wip2");

    clearStash(repo);

    expect(listStash(repo)).toEqual([]);
  });

  it("does not error when there are zero stashes", () => {
    const reposDir = makeTempDir("repos-");
    const repo = initRepo(reposDir, "repo1");

    expect(() => clearStash(repo)).not.toThrow();
  });
});

describe("getUpstream", () => {
  it("does not leak git's stderr when no upstream is configured", () => {
    const reposDir = makeTempDir("repos-");
    const repo = initRepo(reposDir, "repo1");

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    let result: string | null;
    try {
      result = getUpstream(repo);
    } finally {
      stderrSpy.mockRestore();
    }

    expect(stderrSpy).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });
});

describe("showRef", () => {
  it("returns true when a ref exists", () => {
    const reposDir = makeTempDir("repos-");
    const repo = initRepo(reposDir, "repo1");

    const result = showRef(repo, "refs/heads/main");

    expect(result).toBe(true);
  });

  it("returns false when a ref doesn't exist", () => {
    const reposDir = makeTempDir("repos-");
    const repo = initRepo(reposDir, "repo1");

    const result = showRef(repo, "refs/heads/nonexistent");

    expect(result).toBe(false);
  });
});
