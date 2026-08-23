import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { listWorktrees } from "../../src/git/gitClient.js";
import { gatherWorktreeFacts, resolveDefaultBranch } from "../../src/git/gitOperations.js";
import { addWorktree, createTempDirTracker, git, initBareRemote, initRepo } from "./gitFixtures.js";

/**
 * Seam-level tests for gitOperations.ts's composed facts, against real
 * temporary git repos -- no CLI subprocess, no pty. Direct coverage for
 * logic that was previously only reachable transitively through
 * cli.test.ts's end-to-end suite.
 */

const { makeTempDir, cleanup } = createTempDirTracker();
afterEach(cleanup);

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

describe("resolveDefaultBranch", () => {
  it("resolves via origin/HEAD when set", () => {
    const reposDir = makeTempDir("repos-");
    const repo = initRepo(reposDir, "repo1");
    const remote = initBareRemote(reposDir, "origin.git");
    git(repo, ["remote", "add", "origin", remote]);
    git(repo, ["push", "-q", "-u", "origin", "main"]);
    git(repo, ["remote", "set-head", "origin", "main"]);

    const result = resolveDefaultBranch(repo);

    expect(result).toBe("origin/main");
  });

  it("falls back to local main when no origin/HEAD is set", () => {
    const reposDir = makeTempDir("repos-");
    const repo = initRepo(reposDir, "repo1");

    const result = resolveDefaultBranch(repo);

    expect(result).toBe("main");
  });

  it("falls back to local master when neither origin/HEAD nor main exist", () => {
    const reposDir = makeTempDir("repos-");
    const repoDir = path.join(reposDir, "repo1");
    fs.mkdirSync(repoDir, { recursive: true });
    git(repoDir, ["init", "-q", "-b", "master"]);
    git(repoDir, ["config", "user.email", "test@example.com"]);
    git(repoDir, ["config", "user.name", "Test"]);
    fs.writeFileSync(path.join(repoDir, "f.txt"), "hi\n");
    git(repoDir, ["add", "f.txt"]);
    git(repoDir, ["commit", "-q", "-m", "init"]);

    const result = resolveDefaultBranch(repoDir);

    expect(result).toBe("master");
  });

  it("returns null when none of origin/HEAD, main, or master resolve", () => {
    const reposDir = makeTempDir("repos-");
    const repoDir = path.join(reposDir, "repo1");
    fs.mkdirSync(repoDir, { recursive: true });
    git(repoDir, ["init", "-q", "-b", "trunk"]);
    git(repoDir, ["config", "user.email", "test@example.com"]);
    git(repoDir, ["config", "user.name", "Test"]);
    fs.writeFileSync(path.join(repoDir, "f.txt"), "hi\n");
    git(repoDir, ["add", "f.txt"]);
    git(repoDir, ["commit", "-q", "-m", "init"]);

    const result = resolveDefaultBranch(repoDir);

    expect(result).toBeNull();
  });
});
