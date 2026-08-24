import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { addOriginRemote, cloneRepo, createTempDirTracker, git, initBareRemote, initRepo } from "../git/gitFixtures.js";

/**
 * End-to-end integration suite for the `sync-repos` op, invoked via the real
 * `run` dispatcher shim (not just `src/syncRepos/main.ts` in-process) as a
 * subprocess against real temporary git repositories -- including a real
 * bare-repo `origin` for the scenarios that need an actual pull -- and
 * asserts on stdout/exit code, exactly like a user invoking it from their
 * shell. git-ts's own test suite covers `checkout`/`pull` directly at the
 * seam level, and `test/git/gitOperations.test.ts` covers `hasOriginRemote`
 * (derived from git-ts's `getOriginRemoteUrl`); `test/syncRepos/
 * classify.test.ts` covers the pure classification logic. `run`'s own
 * dispatch behavior (`ls`, unrecognized/missing subcommand) is covered
 * separately in `test/cli/dispatcher.test.ts`.
 */

const CLI_PATH = path.resolve(__dirname, "..", "..", "run");

const { makeTempDir, cleanup } = createTempDirTracker();
afterEach(cleanup);

type RunResult = { stdout: string; exitCode: number };

/**
 * Spawns the real `run` shim as a subprocess against the `sync-repos`
 * subcommand, run from an arbitrary cwd (never `my-scripts` itself, proving
 * the shim resolves its own install location independent of the caller's
 * cwd).
 */
function runCli(args: string[], reposDir: string): Promise<RunResult> {
  const cwd = makeTempDir("cwd-");
  return new Promise((resolve, reject) => {
    const child = spawn(CLI_PATH, ["sync-repos", ...args], {
      cwd,
      env: { ...process.env, REPOS_DIR: reposDir },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stdout += d.toString()));
    child.on("error", reject);
    child.on("close", (exitCode) => resolve({ stdout, exitCode: exitCode ?? -1 }));
  });
}

function currentBranch(repoDir: string): string {
  return git(repoDir, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
}

/** Sets up a bare remote plus an "upstream" writer clone, both outside `reposDir` so they're never themselves swept up by `sync-repos`. */
function makeRemote(remotesDir: string, name: string): { remoteDir: string; upstream: string } {
  const remoteDir = initBareRemote(remotesDir, `${name}.git`);
  const upstream = initRepo(remotesDir, `${name}-upstream`);
  addOriginRemote(upstream, remoteDir);
  git(upstream, ["push", "-q", "origin", "main"]);
  return { remoteDir, upstream };
}

describe("run sync-repos", () => {
  it("a clean repo behind its remote gets checked out onto its default branch and pulled", async () => {
    const remotesDir = makeTempDir("remotes-");
    const { remoteDir, upstream } = makeRemote(remotesDir, "origin");
    const reposDir = makeTempDir("repos-");
    const local = cloneRepo(remoteDir, reposDir, "repo1");

    fs.writeFileSync(path.join(upstream, "f.txt"), "second\n");
    git(upstream, ["add", "f.txt"]);
    git(upstream, ["commit", "-q", "-m", "second"]);
    git(upstream, ["push", "-q", "origin", "main"]);

    const { stdout, exitCode } = await runCli([], reposDir);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("== repo1 ==");
    expect(stdout).toContain("synced -- checked out main and pulled from origin");
    expect(stdout).toContain("Done. 1 synced, 0 skipped-dirty, 0 skipped-no-remote, 0 skipped-unresolved, 0 failed.");
    expect(git(local, ["log", "-1", "--format=%s"]).trim()).toBe("second");
  });

  it("a repo with uncommitted changes is skipped and left completely untouched", async () => {
    const reposDir = makeTempDir("repos-");
    const repo = initRepo(reposDir, "repo1");
    git(repo, ["checkout", "-q", "-b", "other"]);
    fs.writeFileSync(path.join(repo, "f.txt"), "uncommitted change\n");

    const { stdout, exitCode } = await runCli([], reposDir);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("== repo1 ==");
    expect(stdout).toContain("skipped -- working tree has uncommitted changes");
    expect(currentBranch(repo)).toBe("other");
    expect(fs.readFileSync(path.join(repo, "f.txt"), "utf8")).toBe("uncommitted change\n");
  });

  it("a repo with no origin remote gets its default branch checked out but is not pulled", async () => {
    const reposDir = makeTempDir("repos-");
    const repo = initRepo(reposDir, "repo1");
    git(repo, ["checkout", "-q", "-b", "other"]);

    const { stdout, exitCode } = await runCli([], reposDir);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("checked out main -- no origin remote configured, nothing to pull");
    expect(stdout).toContain("Done. 0 synced, 0 skipped-dirty, 1 skipped-no-remote, 0 skipped-unresolved, 0 failed.");
    expect(currentBranch(repo)).toBe("main");
  });

  it("a repo whose default branch can't be resolved at all is skipped and the run continues", async () => {
    const reposDir = makeTempDir("repos-");
    const unresolvable = path.join(reposDir, "repo1");
    fs.mkdirSync(unresolvable, { recursive: true });
    git(unresolvable, ["init", "-q"]);
    initRepo(reposDir, "repo2");

    const { stdout, exitCode } = await runCli([], reposDir);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("== repo1 ==");
    expect(stdout).toContain("skipped -- default branch could not be resolved");
    expect(stdout).toContain("== repo2 ==");
    expect(stdout).toContain("Done. 0 synced, 0 skipped-dirty, 1 skipped-no-remote, 1 skipped-unresolved, 0 failed.");
  });

  it("a repo checked out on a non-default branch with a clean working tree is switched to its default branch and pulled", async () => {
    const remotesDir = makeTempDir("remotes-");
    const { remoteDir, upstream } = makeRemote(remotesDir, "origin");
    const reposDir = makeTempDir("repos-");
    const local = cloneRepo(remoteDir, reposDir, "repo1");
    git(local, ["checkout", "-q", "-b", "other"]);

    fs.writeFileSync(path.join(upstream, "f.txt"), "second\n");
    git(upstream, ["add", "f.txt"]);
    git(upstream, ["commit", "-q", "-m", "second"]);
    git(upstream, ["push", "-q", "origin", "main"]);

    const { stdout, exitCode } = await runCli([], reposDir);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("synced -- checked out main and pulled from origin");
    expect(currentBranch(local)).toBe("main");
    expect(git(local, ["log", "-1", "--format=%s"]).trim()).toBe("second");
  });

  it("a repo whose pull fails is reported as a failure without stopping the run", async () => {
    const remotesDir = makeTempDir("remotes-");
    const { remoteDir, upstream } = makeRemote(remotesDir, "conflict");
    const reposDir = makeTempDir("repos-");
    const local = cloneRepo(remoteDir, reposDir, "repoFail");
    initRepo(reposDir, "repoOk");

    // Independent, conflicting edits to the same line of the same file on
    // both sides -- a genuine merge conflict `git pull` can't resolve on its
    // own, deterministically failing the pull.
    fs.writeFileSync(path.join(upstream, "f.txt"), "remote change\n");
    git(upstream, ["add", "f.txt"]);
    git(upstream, ["commit", "-q", "-m", "remote change"]);
    git(upstream, ["push", "-q", "origin", "main"]);

    fs.writeFileSync(path.join(local, "f.txt"), "local change\n");
    git(local, ["add", "f.txt"]);
    git(local, ["commit", "-q", "-m", "local change"]);

    const { stdout, exitCode } = await runCli([], reposDir);

    expect(exitCode).toBe(1);
    expect(stdout).toContain("== repoFail ==");
    expect(stdout).toContain("failed --");
    expect(stdout).toContain("== repoOk ==");
    expect(stdout).toContain("checked out main -- no origin remote configured, nothing to pull");
    expect(stdout).toContain("Done. 0 synced, 0 skipped-dirty, 1 skipped-no-remote, 0 skipped-unresolved, 1 failed.");
  });

  it("processes multiple repos under one $REPOS_DIR in a single run", async () => {
    const reposDir = makeTempDir("repos-");
    const dirtyRepo = initRepo(reposDir, "repoDirty");
    fs.writeFileSync(path.join(dirtyRepo, "f.txt"), "changed\n");
    initRepo(reposDir, "repoNoRemote");

    const { stdout, exitCode } = await runCli([], reposDir);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("== repoDirty ==");
    expect(stdout).toContain("skipped -- working tree has uncommitted changes");
    expect(stdout).toContain("== repoNoRemote ==");
    expect(stdout).toContain("checked out main -- no origin remote configured, nothing to pull");
    expect(stdout).toContain("Done. 0 synced, 1 skipped-dirty, 1 skipped-no-remote, 0 skipped-unresolved, 0 failed.");
  });

  it("any argument at all is a usage error, since sync-repos has no flags", async () => {
    const reposDir = makeTempDir("repos-");

    const { stdout, exitCode } = await runCli(["--bogus"], reposDir);

    expect(exitCode).toBe(1);
    expect(stdout).toContain("Unknown argument: --bogus");
  });

  it("runs correctly from an arbitrary directory, not just from inside my-scripts", async () => {
    const reposDir = makeTempDir("repos-");
    initRepo(reposDir, "repo1");
    const arbitraryCwd = makeTempDir("elsewhere-");

    const result = await new Promise<RunResult>((resolve, reject) => {
      const child = spawn(CLI_PATH, ["sync-repos"], {
        cwd: arbitraryCwd,
        env: { ...process.env, REPOS_DIR: reposDir },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      child.stdout.on("data", (d) => (stdout += d.toString()));
      child.stderr.on("data", (d) => (stdout += d.toString()));
      child.on("error", reject);
      child.on("close", (exitCode) => resolve({ stdout, exitCode: exitCode ?? -1 }));
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("== repo1 ==");
  });
});
