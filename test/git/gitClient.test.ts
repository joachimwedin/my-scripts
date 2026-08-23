import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { checkout, deleteBranch, hasOriginRemote, listBranches, pull } from "../../src/git/gitClient.js";
import { addOriginRemote, cloneRepo, createTempDirTracker, git, initBareRemote, initRepo } from "./gitFixtures.js";

/**
 * Seam-level tests for gitClient.ts's own git-invocation functions -- the
 * two operations not carried over to `git-ts` -- against real temporary git
 * repos, no mocked subprocess calls. `git-ts`'s own test suite covers every
 * ported operation now imported from there instead.
 */

const { makeTempDir, cleanup } = createTempDirTracker();
afterEach(cleanup);

describe("listBranches", () => {
  it("returns an empty array when the repo has no commits yet", () => {
    const reposDir = makeTempDir("repos-");
    const repo = path.join(reposDir, "repo1");
    fs.mkdirSync(repo, { recursive: true });
    git(repo, ["init", "-q", "-b", "main"]);

    const result = listBranches(repo);

    expect(result).toEqual([]);
  });

  it("returns one entry for a single branch", () => {
    const reposDir = makeTempDir("repos-");
    const repo = initRepo(reposDir, "repo1");

    const result = listBranches(repo);

    expect(result).toEqual(["main"]);
  });

  it("returns multiple entries for multiple branches", () => {
    const reposDir = makeTempDir("repos-");
    const repo = initRepo(reposDir, "repo1");
    git(repo, ["branch", "feature-a"]);
    git(repo, ["branch", "feature-b"]);

    const result = listBranches(repo);

    expect(result.sort()).toEqual(["feature-a", "feature-b", "main"]);
  });
});

describe("deleteBranch", () => {
  it("deletes a merged branch with the safe -d form by default", () => {
    const reposDir = makeTempDir("repos-");
    const repo = initRepo(reposDir, "repo1");
    git(repo, ["branch", "merged-branch"]);

    deleteBranch(repo, "merged-branch");

    expect(listBranches(repo)).not.toContain("merged-branch");
  });

  it("throws with the safe -d form when the branch isn't merged", () => {
    const reposDir = makeTempDir("repos-");
    const repo = initRepo(reposDir, "repo1");
    git(repo, ["checkout", "-q", "-b", "unmerged-branch"]);
    fs.writeFileSync(path.join(repo, "f.txt"), "changed\n");
    git(repo, ["add", "f.txt"]);
    git(repo, ["commit", "-q", "-m", "diverge"]);
    git(repo, ["checkout", "-q", "main"]);

    expect(() => deleteBranch(repo, "unmerged-branch")).toThrow();
    expect(listBranches(repo)).toContain("unmerged-branch");
  });

  it("succeeds against that same unmerged branch with { force: true }", () => {
    const reposDir = makeTempDir("repos-");
    const repo = initRepo(reposDir, "repo1");
    git(repo, ["checkout", "-q", "-b", "unmerged-branch"]);
    fs.writeFileSync(path.join(repo, "f.txt"), "changed\n");
    git(repo, ["add", "f.txt"]);
    git(repo, ["commit", "-q", "-m", "diverge"]);
    git(repo, ["checkout", "-q", "main"]);

    deleteBranch(repo, "unmerged-branch", { force: true });

    expect(listBranches(repo)).not.toContain("unmerged-branch");
  });
});

describe("hasOriginRemote", () => {
  it("returns false for a freshly initialized repo with no remote at all", () => {
    const reposDir = makeTempDir("repos-");
    const repo = initRepo(reposDir, "repo1");

    const result = hasOriginRemote(repo);

    expect(result).toBe(false);
  });

  it("returns true for a repo with a real bare origin configured", () => {
    const reposDir = makeTempDir("repos-");
    const repo = initRepo(reposDir, "repo1");
    const remote = initBareRemote(reposDir, "origin.git");
    addOriginRemote(repo, remote);

    const result = hasOriginRemote(repo);

    expect(result).toBe(true);
  });
});

describe("checkout", () => {
  it("moves HEAD/the working tree to the named branch", () => {
    const reposDir = makeTempDir("repos-");
    const repo = initRepo(reposDir, "repo1");
    git(repo, ["checkout", "-q", "-b", "second-branch"]);
    git(repo, ["checkout", "-q", "main"]);

    checkout(repo, "second-branch");

    const currentBranch = git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
    expect(currentBranch).toBe("second-branch");
  });
});

describe("pull", () => {
  it("brings a repo behind its remote up to the remote's latest commit", () => {
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

    pull(local);

    const latestMessage = git(local, ["log", "-1", "--format=%s"]).trim();
    expect(latestMessage).toBe("second");
  });

  it("merges a genuinely diverged history rather than failing", () => {
    const reposDir = makeTempDir("repos-");
    const remote = initBareRemote(reposDir, "origin.git");
    const upstream = initRepo(reposDir, "upstream");
    addOriginRemote(upstream, remote);
    git(upstream, ["push", "-q", "origin", "main"]);
    const local = cloneRepo(remote, reposDir, "local");

    // Independent commits on each side, off the shared "init" ancestor.
    fs.writeFileSync(path.join(upstream, "remote-file.txt"), "remote change\n");
    git(upstream, ["add", "remote-file.txt"]);
    git(upstream, ["commit", "-q", "-m", "remote change"]);
    git(upstream, ["push", "-q", "origin", "main"]);

    fs.writeFileSync(path.join(local, "local-file.txt"), "local change\n");
    git(local, ["add", "local-file.txt"]);
    git(local, ["commit", "-q", "-m", "local change"]);

    pull(local);

    expect(fs.existsSync(path.join(local, "remote-file.txt"))).toBe(true);
    expect(fs.existsSync(path.join(local, "local-file.txt"))).toBe(true);
  });
});
