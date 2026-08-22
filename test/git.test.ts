import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { gatherWorktreeFacts, listWorktrees, pruneWorktrees, removeWorktree } from "../src/git.js";

/**
 * Seam-level tests for git.ts's own git-invocation functions, against real
 * temporary git repos -- no CLI subprocess, no pty. Direct coverage for
 * logic that was previously only reachable transitively through
 * cli.test.ts's end-to-end suite.
 */

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

/** Creates a real git repo at `<reposDir>/<name>` with one commit on `main`. */
function initRepo(reposDir: string, name: string): string {
  const repoDir = path.join(reposDir, name);
  fs.mkdirSync(repoDir, { recursive: true });
  git(repoDir, ["init", "-q", "-b", "main"]);
  git(repoDir, ["config", "user.email", "test@example.com"]);
  git(repoDir, ["config", "user.name", "Test"]);
  fs.writeFileSync(path.join(repoDir, "f.txt"), "hi\n");
  git(repoDir, ["add", "f.txt"]);
  git(repoDir, ["commit", "-q", "-m", "init"]);
  return repoDir;
}

/** Adds a real linked worktree on a new branch off `repoDir`'s current HEAD. */
function addWorktree(repoDir: string, branch: string, worktreePath: string): void {
  git(repoDir, ["branch", branch]);
  git(repoDir, ["worktree", "add", "-q", worktreePath, branch]);
}

/** Creates a real bare repo at `<reposDir>/<name>`, suitable for use as a remote. */
function initBareRemote(reposDir: string, name: string): string {
  const remoteDir = path.join(reposDir, name);
  fs.mkdirSync(remoteDir, { recursive: true });
  git(remoteDir, ["init", "-q", "--bare"]);
  return remoteDir;
}

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

describe("gatherWorktreeFacts", () => {
  it("short-circuits a locked worktree to its locked/lockReason facts without computing dirty/merged/upstream", () => {
    const reposDir = makeTempDir("repos-");
    const repo = initRepo(reposDir, "repo1");
    const lockedPath = path.join(reposDir, "repo1-locked");
    addWorktree(repo, "locked-branch", lockedPath);
    git(repo, ["worktree", "lock", lockedPath, "--reason", "in use"]);
    // Genuinely dirty, so a false `dirty: false` below can only come from the
    // short-circuit -- not from a real (and wrong) answer.
    fs.writeFileSync(path.join(lockedPath, "f.txt"), "changed\n");
    const worktree = listWorktrees(repo).find((w) => w.path === lockedPath)!;

    const facts = gatherWorktreeFacts(worktree, "main");

    expect(facts.locked).toBe(true);
    expect(facts.lockReason).toBe("in use");
    expect(facts.dirty).toBe(false);
    expect(facts.merged).toBe(false);
    expect(facts.upstream).toBeNull();
    expect(facts.aheadCount).toBeNull();
  });

  it("short-circuits a prunable worktree without running git commands against its missing directory", () => {
    const reposDir = makeTempDir("repos-");
    const repo = initRepo(reposDir, "repo1");
    const gonePath = path.join(reposDir, "repo1-gone");
    addWorktree(repo, "gone-branch", gonePath);
    fs.rmSync(gonePath, { recursive: true, force: true });
    const worktree = listWorktrees(repo).find((w) => w.path === gonePath)!;

    const facts = gatherWorktreeFacts(worktree, "main");

    expect(facts.prunable).toBe(true);
    expect(facts.prunableReason).not.toBe("");
    expect(facts.dirty).toBe(false);
    expect(facts.merged).toBe(false);
    expect(facts.upstream).toBeNull();
    expect(facts.aheadCount).toBeNull();
  });

  it("forces upstream/aheadCount to null for a clean, merged worktree even when an upstream is configured", () => {
    const reposDir = makeTempDir("repos-");
    const repo = initRepo(reposDir, "repo1");
    const remote = initBareRemote(reposDir, "origin.git");
    git(repo, ["remote", "add", "origin", remote]);
    git(repo, ["push", "-q", "-u", "origin", "main"]);

    const mergedPath = path.join(reposDir, "repo1-merged");
    addWorktree(repo, "merged-branch", mergedPath);
    git(mergedPath, ["push", "-q", "-u", "origin", "merged-branch"]);

    const worktree = listWorktrees(repo).find((w) => w.path === mergedPath)!;
    const facts = gatherWorktreeFacts(worktree, "main");

    expect(facts.dirty).toBe(false);
    expect(facts.merged).toBe(true);
    expect(facts.upstream).toBeNull();
    expect(facts.aheadCount).toBeNull();
  });

  it("reports dirty/merged/upstream/aheadCount together for a dirty, unmerged worktree with commits ahead of its upstream", () => {
    const reposDir = makeTempDir("repos-");
    const repo = initRepo(reposDir, "repo1");
    const remote = initBareRemote(reposDir, "origin.git");
    git(repo, ["remote", "add", "origin", remote]);
    git(repo, ["push", "-q", "-u", "origin", "main"]);

    const featurePath = path.join(reposDir, "repo1-feature");
    addWorktree(repo, "feature-branch", featurePath);
    git(featurePath, ["push", "-q", "-u", "origin", "feature-branch"]);
    fs.writeFileSync(path.join(featurePath, "g.txt"), "one\n");
    git(featurePath, ["add", "g.txt"]);
    git(featurePath, ["commit", "-q", "-m", "ahead 1"]);
    fs.writeFileSync(path.join(featurePath, "h.txt"), "two\n");
    git(featurePath, ["add", "h.txt"]);
    git(featurePath, ["commit", "-q", "-m", "ahead 2"]);
    fs.writeFileSync(path.join(featurePath, "f.txt"), "changed\n");

    const worktree = listWorktrees(repo).find((w) => w.path === featurePath)!;
    const facts = gatherWorktreeFacts(worktree, "main");

    expect(facts.dirty).toBe(true);
    expect(facts.merged).toBe(false);
    expect(facts.upstream).toBe("origin/feature-branch");
    expect(facts.aheadCount).toBe(2);
  });

  it("reports upstream and aheadCount as null for an unmerged worktree with no upstream configured", () => {
    const reposDir = makeTempDir("repos-");
    const repo = initRepo(reposDir, "repo1");
    const featurePath = path.join(reposDir, "repo1-no-upstream");
    addWorktree(repo, "no-upstream-branch", featurePath);
    fs.writeFileSync(path.join(featurePath, "g.txt"), "one\n");
    git(featurePath, ["add", "g.txt"]);
    git(featurePath, ["commit", "-q", "-m", "extra"]);

    const worktree = listWorktrees(repo).find((w) => w.path === featurePath)!;
    const facts = gatherWorktreeFacts(worktree, "main");

    expect(facts.merged).toBe(false);
    expect(facts.upstream).toBeNull();
    expect(facts.aheadCount).toBeNull();
  });
});
