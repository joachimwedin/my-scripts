import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { listWorktrees } from "git-ts/src/gitClient.js";
import { compareToRemote, gatherBranchFacts, gatherSyncFacts, gatherWorktreeFacts, listRepoNames, resolveDefaultBranch } from "../../src/git/gitOperations.js";
import { addOriginRemote, cloneRepo, addWorktree, createTempDirTracker, git, initBareRemote, initRepo } from "./gitFixtures.js";

/** Builds the `branch name -> worktree path` map `gatherBranchFacts` expects, from a real worktree list. */
function checkedOutMap(repoDir: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const worktree of listWorktrees(repoDir)) {
    map.set(worktree.branch, worktree.path);
  }
  return map;
}

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

describe("gatherBranchFacts", () => {
  it("short-circuits a checked-out branch without computing merged status", () => {
    const reposDir = makeTempDir("repos-");
    const repo = initRepo(reposDir, "repo1");
    const featurePath = path.join(reposDir, "repo1-feature");
    addWorktree(repo, "feature-branch", featurePath);
    // Genuinely unmerged, so a false "merged: true" below can only come from
    // the short-circuit -- not from a real (and wrong) merge-base answer.
    fs.writeFileSync(path.join(featurePath, "g.txt"), "one\n");
    git(featurePath, ["add", "g.txt"]);
    git(featurePath, ["commit", "-q", "-m", "diverge"]);

    const facts = gatherBranchFacts(repo, "feature-branch", "main", checkedOutMap(repo));

    expect(facts.checkedOutAt).toBe(featurePath);
    expect(facts.merged).toBe(false);
  });

  it("reports a merged, non-checked-out branch as merged", () => {
    const reposDir = makeTempDir("repos-");
    const repo = initRepo(reposDir, "repo1");
    git(repo, ["branch", "merged-branch"]);

    const facts = gatherBranchFacts(repo, "merged-branch", "main", checkedOutMap(repo));

    expect(facts.checkedOutAt).toBeNull();
    expect(facts.merged).toBe(true);
  });

  it("reports an unmerged, non-checked-out branch as not merged", () => {
    const reposDir = makeTempDir("repos-");
    const repo = initRepo(reposDir, "repo1");
    git(repo, ["checkout", "-q", "-b", "unmerged-branch"]);
    fs.writeFileSync(path.join(repo, "f.txt"), "changed\n");
    git(repo, ["add", "f.txt"]);
    git(repo, ["commit", "-q", "-m", "diverge"]);
    git(repo, ["checkout", "-q", "main"]);

    const facts = gatherBranchFacts(repo, "unmerged-branch", "main", checkedOutMap(repo));

    expect(facts.checkedOutAt).toBeNull();
    expect(facts.merged).toBe(false);
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

    expect(result).toEqual({ localName: "main", mergeTarget: "origin/main" });
  });

  it("falls back to local main when no origin/HEAD is set", () => {
    const reposDir = makeTempDir("repos-");
    const repo = initRepo(reposDir, "repo1");

    const result = resolveDefaultBranch(repo);

    expect(result).toEqual({ localName: "main", mergeTarget: "main" });
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

    expect(result).toEqual({ localName: "master", mergeTarget: "master" });
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

describe("gatherSyncFacts", () => {
  it("short-circuits an unresolvable default branch to defaultBranch: null without checking dirty/remote status", () => {
    const reposDir = makeTempDir("repos-");
    const repoDir = path.join(reposDir, "repo1");
    fs.mkdirSync(repoDir, { recursive: true });
    git(repoDir, ["init", "-q", "-b", "trunk"]);
    git(repoDir, ["config", "user.email", "test@example.com"]);
    git(repoDir, ["config", "user.name", "Test"]);
    fs.writeFileSync(path.join(repoDir, "f.txt"), "hi\n");
    git(repoDir, ["add", "f.txt"]);
    git(repoDir, ["commit", "-q", "-m", "init"]);
    // Genuinely dirty and remote-having, so false-y facts below can only come
    // from the short-circuit -- not from a real (and wrong) answer.
    fs.writeFileSync(path.join(repoDir, "f.txt"), "changed\n");
    const remote = initBareRemote(reposDir, "origin.git");
    addOriginRemote(repoDir, remote);

    const facts = gatherSyncFacts(repoDir);

    expect(facts.defaultBranch).toBeNull();
    expect(facts.dirty).toBe(false);
    expect(facts.hasOriginRemote).toBe(false);
  });

  it("reports a dirty working tree for a repo with a resolvable default branch", () => {
    const reposDir = makeTempDir("repos-");
    const repo = initRepo(reposDir, "repo1");
    fs.writeFileSync(path.join(repo, "f.txt"), "changed\n");

    const facts = gatherSyncFacts(repo);

    expect(facts.defaultBranch).toBe("main");
    expect(facts.dirty).toBe(true);
  });

  it("reports hasOriginRemote true for a repo with a real origin remote configured", () => {
    const reposDir = makeTempDir("repos-");
    const repo = initRepo(reposDir, "repo1");
    const remote = initBareRemote(reposDir, "origin.git");
    addOriginRemote(repo, remote);

    const facts = gatherSyncFacts(repo);

    expect(facts.defaultBranch).toBe("main");
    expect(facts.dirty).toBe(false);
    expect(facts.hasOriginRemote).toBe(true);
  });

  it("reports hasOriginRemote false for a repo with no remote at all", () => {
    const reposDir = makeTempDir("repos-");
    const repo = initRepo(reposDir, "repo1");

    const facts = gatherSyncFacts(repo);

    expect(facts.defaultBranch).toBe("main");
    expect(facts.dirty).toBe(false);
    expect(facts.hasOriginRemote).toBe(false);
  });
});

describe("compareToRemote", () => {
  it("reports up-to-date when the local branch and remote ref are at the same commit", () => {
    const reposDir = makeTempDir("repos-");
    const remote = initBareRemote(reposDir, "origin.git");
    const upstream = initRepo(reposDir, "upstream");
    addOriginRemote(upstream, remote);
    git(upstream, ["push", "-q", "origin", "main"]);
    const local = cloneRepo(remote, reposDir, "local");

    const result = compareToRemote(local, "main", "origin/main");

    expect(result).toBe("up-to-date");
  });

  it("reports fast-forwardable when the local branch is behind the remote ref", () => {
    const reposDir = makeTempDir("repos-");
    const remote = initBareRemote(reposDir, "origin.git");
    const upstream = initRepo(reposDir, "upstream");
    addOriginRemote(upstream, remote);
    git(upstream, ["push", "-q", "origin", "main"]);
    const local = cloneRepo(remote, reposDir, "local");

    fs.writeFileSync(path.join(upstream, "f.txt"), "second\n");
    git(upstream, ["add", "f.txt"]);
    git(upstream, ["commit", "-q", "-m", "second"]);
    git(upstream, ["push", "-q", "origin", "main"]);
    git(local, ["fetch", "-q", "origin"]);

    const result = compareToRemote(local, "main", "origin/main");

    expect(result).toBe("fast-forwardable");
  });

  it("reports ahead when the local branch has commits the remote ref doesn't", () => {
    const reposDir = makeTempDir("repos-");
    const remote = initBareRemote(reposDir, "origin.git");
    const upstream = initRepo(reposDir, "upstream");
    addOriginRemote(upstream, remote);
    git(upstream, ["push", "-q", "origin", "main"]);
    const local = cloneRepo(remote, reposDir, "local");

    fs.writeFileSync(path.join(local, "g.txt"), "local only\n");
    git(local, ["add", "g.txt"]);
    git(local, ["commit", "-q", "-m", "ahead"]);

    const result = compareToRemote(local, "main", "origin/main");

    expect(result).toBe("ahead");
  });

  it("reports diverged when the local branch and remote ref each have commits the other lacks", () => {
    const reposDir = makeTempDir("repos-");
    const remote = initBareRemote(reposDir, "origin.git");
    const upstream = initRepo(reposDir, "upstream");
    addOriginRemote(upstream, remote);
    git(upstream, ["push", "-q", "origin", "main"]);
    const local = cloneRepo(remote, reposDir, "local");

    fs.writeFileSync(path.join(upstream, "remote-file.txt"), "remote change\n");
    git(upstream, ["add", "remote-file.txt"]);
    git(upstream, ["commit", "-q", "-m", "remote change"]);
    git(upstream, ["push", "-q", "origin", "main"]);

    fs.writeFileSync(path.join(local, "local-file.txt"), "local change\n");
    git(local, ["add", "local-file.txt"]);
    git(local, ["commit", "-q", "-m", "local change"]);
    git(local, ["fetch", "-q", "origin"]);

    const result = compareToRemote(local, "main", "origin/main");

    expect(result).toBe("diverged");
  });
});

describe("listRepoNames", () => {
  it("returns sorted repo names for directories containing a .git subdirectory", () => {
    const reposDir = makeTempDir("repos-");
    initRepo(reposDir, "zebra");
    initRepo(reposDir, "alpha");

    const result = listRepoNames(reposDir);

    expect(result).toEqual(["alpha", "zebra"]);
  });

  it("excludes directories without a .git subdirectory", () => {
    const reposDir = makeTempDir("repos-");
    initRepo(reposDir, "repo1");
    fs.mkdirSync(path.join(reposDir, "not-a-repo"));

    const result = listRepoNames(reposDir);

    expect(result).toEqual(["repo1"]);
  });

  it("excludes non-directory entries", () => {
    const reposDir = makeTempDir("repos-");
    initRepo(reposDir, "repo1");
    fs.writeFileSync(path.join(reposDir, "not-a-dir.txt"), "hi\n");

    const result = listRepoNames(reposDir);

    expect(result).toEqual(["repo1"]);
  });

  it("returns an empty array when reposDir doesn't exist", () => {
    const result = listRepoNames("/nonexistent/path/does/not/exist");

    expect(result).toEqual([]);
  });
});
