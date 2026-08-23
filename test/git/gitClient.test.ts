import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { deleteBranch, listBranches } from "../../src/git/gitClient.js";
import { createTempDirTracker, git, initRepo } from "./gitFixtures.js";

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
