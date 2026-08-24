import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

/**
 * End-to-end integration suite for the `clean-stashes` op, invoked via the
 * real `run` dispatcher shim (not just `src/cleanStashes/main.ts`
 * in-process) as a subprocess against real temporary git repositories,
 * created and torn down per test, and asserts on stdout/exit code -- exactly
 * like a user invoking it from their shell. This is the only place
 * git-ts's real `listStash`/`clearStash` git invocation gets exercised
 * end-to-end; git-ts's own test suite covers those two functions directly
 * at the seam level. `run`'s own dispatch behavior (`ls`,
 * unrecognized/missing subcommand) is covered separately in
 * `test/cli/dispatcher.test.ts`.
 */

const CLI_PATH = path.resolve(__dirname, "..", "..", "run");

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

/** Stashes a change to `f.txt` in `repoDir` under `message`, creating one real stash entry. */
function addStash(repoDir: string, message: string): void {
  fs.writeFileSync(path.join(repoDir, "f.txt"), `changed-${message}\n`);
  git(repoDir, ["stash", "push", "-m", message]);
}

type RunResult = { stdout: string; exitCode: number };

/**
 * Spawns the real `run` shim as a subprocess against the `clean-stashes`
 * subcommand, run from an arbitrary cwd (never `my-scripts` itself, proving
 * the shim resolves its own install location independent of the caller's
 * cwd).
 */
function runCli(args: string[], reposDir: string): Promise<RunResult> {
  const cwd = makeTempDir("cwd-");
  return new Promise((resolve, reject) => {
    const child = spawn(CLI_PATH, ["clean-stashes", ...args], {
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

describe("run clean-stashes", () => {
  it("dry run lists each repo's stash header/listing and clears nothing", async () => {
    const reposDir = makeTempDir("repos-");
    const repo = initRepo(reposDir, "repo1");
    addStash(repo, "wip1");
    addStash(repo, "wip2");

    const { stdout, exitCode } = await runCli([], reposDir);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("Dry run — no stashes will be modified. Pass --force to actually clear them.");
    expect(stdout).toContain("== repo1 (2 stash(es)) ==");
    expect(stdout).toContain("wip1");
    expect(stdout).toContain("wip2");
    expect(stdout).toContain("Dry run complete. Re-run with --force to clear the stashes listed above.");
    expect(stdout).not.toContain("-> cleared");
    expect(git(repo, ["stash", "list"])).not.toBe("");
  });

  it("--force clears every listed repo's stashes and prints confirmation plus a closing total", async () => {
    const reposDir = makeTempDir("repos-");
    const repo = initRepo(reposDir, "repo1");
    addStash(repo, "wip1");
    addStash(repo, "wip2");

    const { stdout, exitCode } = await runCli(["--force"], reposDir);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("== repo1 (2 stash(es)) ==");
    expect(stdout).toContain("-> cleared");
    expect(stdout).toContain("Done. Cleared 2 stash(es) total.");
    expect(git(repo, ["stash", "list"])).toBe("");
  });

  it("a repo with no stashes produces no header and no output for that repo", async () => {
    const reposDir = makeTempDir("repos-");
    initRepo(reposDir, "repo1");

    const { stdout, exitCode } = await runCli([], reposDir);

    expect(exitCode).toBe(0);
    expect(stdout).not.toContain("== repo1");
  });

  it("processes multiple repos under one $REPOS_DIR in a single run", async () => {
    const reposDir = makeTempDir("repos-");
    const repoA = initRepo(reposDir, "repoA");
    const repoB = initRepo(reposDir, "repoB");
    addStash(repoA, "a-wip");
    addStash(repoB, "b-wip");

    const { stdout, exitCode } = await runCli(["--force"], reposDir);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("== repoA (1 stash(es)) ==");
    expect(stdout).toContain("== repoB (1 stash(es)) ==");
    expect(stdout).toContain("Done. Cleared 2 stash(es) total.");
    expect(git(repoA, ["stash", "list"])).toBe("");
    expect(git(repoB, ["stash", "list"])).toBe("");
  });

  it("any argument other than --force is a usage error", async () => {
    const reposDir = makeTempDir("repos-");

    const { stdout, exitCode } = await runCli(["--bogus"], reposDir);

    expect(exitCode).toBe(1);
    expect(stdout).toContain("Unknown argument: --bogus");
  });

  it("runs correctly from an arbitrary directory, not just from inside my-scripts", async () => {
    const reposDir = makeTempDir("repos-");
    const repo = initRepo(reposDir, "repo1");
    addStash(repo, "wip1");
    const arbitraryCwd = makeTempDir("elsewhere-");

    const result = await new Promise<RunResult>((resolve, reject) => {
      const child = spawn(CLI_PATH, ["clean-stashes"], {
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
    expect(result.stdout).toContain("Dry run — no stashes will be modified.");
  });
});
