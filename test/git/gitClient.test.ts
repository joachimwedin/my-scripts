import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { checkout, hasOriginRemote, pull } from "../../src/git/gitClient.js";
import { addOriginRemote, cloneRepo, createTempDirTracker, git, initBareRemote, initRepo } from "./gitFixtures.js";

/**
 * Seam-level tests for gitClient.ts's own git-invocation functions -- the
 * operations not yet carried over to `git-ts` -- against real temporary git
 * repos, no mocked subprocess calls. `git-ts`'s own test suite covers every
 * ported operation (including `listBranches`/`deleteBranch`, ported by Spec
 * #49's first child) now imported from there instead.
 */

const { makeTempDir, cleanup } = createTempDirTracker();
afterEach(cleanup);

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
