import { afterEach, describe, expect, it } from "vitest";

import { hasOriginRemote } from "../../src/git/gitClient.js";
import { addOriginRemote, createTempDirTracker, initBareRemote, initRepo } from "./gitFixtures.js";

/**
 * Seam-level tests for gitClient.ts's own git-invocation functions -- the
 * operations not yet carried over to `git-ts` -- against real temporary git
 * repos, no mocked subprocess calls. `git-ts`'s own test suite covers every
 * ported operation (including `listBranches`/`deleteBranch`/`checkout`/
 * `pull`, ported by Spec #49's earlier children) now imported from there
 * instead.
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
