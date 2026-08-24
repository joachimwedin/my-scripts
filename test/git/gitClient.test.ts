import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { fastForward } from "../../src/git/gitClient.js";
import { addOriginRemote, cloneRepo, createTempDirTracker, git, initBareRemote, initRepo } from "./gitFixtures.js";

/**
 * Seam-level tests for my-scripts' own local gitClient.ts -- against real
 * temporary git repos, no CLI subprocess, no mocking. Mirrors git-ts's own
 * gitClient.test.ts convention for the primitives that live there.
 */

const { makeTempDir, cleanup } = createTempDirTracker();
afterEach(cleanup);

describe("fastForward", () => {
  it("fast-forwards the current branch to the remote ref when the local branch is behind", () => {
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

    fastForward(local, "origin/main");

    const localHead = git(local, ["rev-parse", "HEAD"]).trim();
    const remoteHead = git(upstream, ["rev-parse", "HEAD"]).trim();
    expect(localHead).toBe(remoteHead);
    expect(git(local, ["log", "-1", "--format=%s"]).trim()).toBe("second");
  });

  it("throws when the merge isn't a fast-forward, leaving the working tree and HEAD unchanged", () => {
    const reposDir = makeTempDir("repos-");
    const remote = initBareRemote(reposDir, "origin.git");
    const upstream = initRepo(reposDir, "upstream");
    addOriginRemote(upstream, remote);
    git(upstream, ["push", "-q", "origin", "main"]);
    const local = cloneRepo(remote, reposDir, "local");

    // Independent commits on each side, off the shared "init" ancestor --
    // a genuine divergence, not just a fast-forwardable gap.
    fs.writeFileSync(path.join(upstream, "remote-file.txt"), "remote change\n");
    git(upstream, ["add", "remote-file.txt"]);
    git(upstream, ["commit", "-q", "-m", "remote change"]);
    git(upstream, ["push", "-q", "origin", "main"]);

    fs.writeFileSync(path.join(local, "local-file.txt"), "local change\n");
    git(local, ["add", "local-file.txt"]);
    git(local, ["commit", "-q", "-m", "local change"]);
    git(local, ["fetch", "-q", "origin"]);

    const headBefore = git(local, ["rev-parse", "HEAD"]).trim();
    const statusBefore = git(local, ["status", "--porcelain"]).trim();

    expect(() => fastForward(local, "origin/main")).toThrow();

    expect(git(local, ["rev-parse", "HEAD"]).trim()).toBe(headBefore);
    expect(git(local, ["status", "--porcelain"]).trim()).toBe(statusBefore);
  });
});
