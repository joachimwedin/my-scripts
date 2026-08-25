import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

/**
 * End-to-end integration suite for the `clean-worktrees` op, invoked via the
 * real `run` dispatcher shim (not just `src/cleanWorktree/main.ts`
 * in-process) as a subprocess against real temporary git repositories,
 * created and torn down per test, and asserts on stdout/exit code -- exactly
 * like a user invoking it from their shell. This is the only place
 * `gitClient.ts`'s real git-invocation behavior, `gatherWorktreeFacts`'s I/O
 * composition, and `confirm.confirm`'s real tty-reading path get exercised;
 * everything else is covered by fixture-based unit tests elsewhere in this
 * directory. `run`'s own dispatch behavior (`ls`, unrecognized/missing
 * subcommand) is covered separately in `test/cli/dispatcher.test.ts`.
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

/** Adds a real linked worktree on a new branch off `repoDir`'s current HEAD. */
function addWorktree(repoDir: string, branch: string, worktreePath: string): void {
  git(repoDir, ["branch", branch]);
  git(repoDir, ["worktree", "add", "-q", worktreePath, branch]);
}

function currentWorktreePaths(repoDir: string): string[] {
  return git(repoDir, ["worktree", "list", "--porcelain"])
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length));
}

function localBranches(repoDir: string): string[] {
  return git(repoDir, ["for-each-ref", "--format=%(refname:short)", "refs/heads/"])
    .trim()
    .split("\n")
    .filter((b) => b !== "");
}

type RunResult = { stdout: string; exitCode: number };

/**
 * Spawns the real `run` shim as a subprocess against the `clean-worktrees`
 * subcommand, run from an arbitrary cwd (never `my-scripts` itself, proving
 * the shim resolves its own install location independent of the caller's
 * cwd). stdin is a plain pipe -- no real tty attached, matching how the
 * command runs under automation.
 */
function runCli(args: string[], reposDir: string): Promise<RunResult> {
  const cwd = makeTempDir("cwd-");
  return new Promise((resolve, reject) => {
    const child = spawn(CLI_PATH, ["clean-worktrees", ...args], {
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

/**
 * Spawns the real `run` shim connected to a real pseudo-tty (via the
 * `script` utility -- no extra native/npm dependency needed) against the
 * `clean-worktrees` subcommand, waits for the confirm prompt text to appear,
 * then writes `answer` to it. This is what actually exercises
 * `prompt.confirm`'s tty-reading branch end-to-end; a plain piped stdin (see
 * `runCli`) always takes the non-tty "skip" branch, by design.
 */
function runCliWithTtyAnswer(args: string[], reposDir: string, answer: string): Promise<RunResult> {
  const cwd = makeTempDir("cwd-");
  const quotedArgs = ["clean-worktrees", ...args].map((a) => `'${a}'`).join(" ");
  const command = `REPOS_DIR='${reposDir}' '${CLI_PATH}' ${quotedArgs}`;

  return new Promise((resolve, reject) => {
    const child = spawn("script", ["-qc", command, "/dev/null"], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let answered = false;
    child.stdout.on("data", (d) => {
      stdout += d.toString();
      if (!answered && stdout.includes("Remove anyway?")) {
        answered = true;
        child.stdin.write(`${answer}\n`);
      }
    });
    child.stderr.on("data", (d) => (stdout += d.toString()));
    child.on("error", reject);
    child.on("close", (exitCode) => resolve({ stdout, exitCode: exitCode ?? -1 }));
  });
}

describe("run clean-worktrees", () => {
  it("dry run lists prune/locked/safe/confirm buckets per repo and changes nothing", async () => {
    const reposDir = makeTempDir("repos-");
    const repo = initRepo(reposDir, "repo1");
    addWorktree(repo, "safe-branch", path.join(reposDir, "repo1-safe"));
    addWorktree(repo, "dirty-branch", path.join(reposDir, "repo1-dirty"));
    fs.appendFileSync(path.join(reposDir, "repo1-dirty", "f.txt"), "dirty\n");
    addWorktree(repo, "locked-branch", path.join(reposDir, "repo1-locked"));
    git(repo, ["worktree", "lock", path.join(reposDir, "repo1-locked"), "--reason", "in use"]);

    const before = currentWorktreePaths(repo).sort();

    const { stdout, exitCode } = await runCli([], reposDir);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("Dry run -- no worktrees will be modified. Pass --force to actually clean up.");
    expect(stdout).toContain("== repo1 ==");
    expect(stdout).toMatch(/\[safe\]\s+.*repo1-safe \(safe-branch\) -- would remove/);
    expect(stdout).toMatch(/\[confirm\]\s+.*repo1-dirty \(dirty-branch\) -- uncommitted\/untracked changes/);
    expect(stdout).toMatch(/\[locked\]\s+.*repo1-locked \(locked-branch\) -- in use -- never touched/);
    expect(stdout).toContain("Dry run complete. Re-run with --force to prune/remove/confirm the worktrees listed above.");
    expect(stdout).not.toContain("-> removed");

    expect(currentWorktreePaths(repo).sort()).toEqual(before);
  });

  it("--force prunes stale worktree metadata", async () => {
    const reposDir = makeTempDir("repos-");
    const repo = initRepo(reposDir, "repo1");
    const gonePath = path.join(reposDir, "repo1-gone");
    addWorktree(repo, "gone-branch", gonePath);
    fs.rmSync(gonePath, { recursive: true, force: true });

    const { stdout, exitCode } = await runCli(["--force"], reposDir);

    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/\[prune\]\s+.*repo1-gone --/);
    expect(stdout).toContain("Done. Pruned 1 stale worktree(s)");
    expect(currentWorktreePaths(repo)).toEqual([repo]);
  });

  it("--force removes safe worktrees (clean, merged) automatically with no prompt", async () => {
    const reposDir = makeTempDir("repos-");
    const repo = initRepo(reposDir, "repo1");
    const safePath = path.join(reposDir, "repo1-safe");
    addWorktree(repo, "safe-branch", safePath);

    const { stdout, exitCode } = await runCli(["--force"], reposDir);

    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/\[safe\]\s+.*repo1-safe \(safe-branch\) -- would remove/);
    expect(stdout).toContain("-> removed");
    expect(stdout).toContain("Done. Pruned 0 stale worktree(s), removed 1 worktree(s).");
    expect(currentWorktreePaths(repo)).toEqual([repo]);
    expect(localBranches(repo)).toContain("safe-branch");
  });

  it("locked worktrees are never removed or prompted about, even under --force", async () => {
    const reposDir = makeTempDir("repos-");
    const repo = initRepo(reposDir, "repo1");
    const lockedPath = path.join(reposDir, "repo1-locked");
    addWorktree(repo, "locked-branch", lockedPath);
    // Make it also dirty -- would otherwise land in the confirm bucket.
    fs.appendFileSync(path.join(lockedPath, "f.txt"), "dirty\n");
    git(repo, ["worktree", "lock", lockedPath]);

    const { stdout, exitCode } = await runCli(["--force"], reposDir);

    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/\[locked\]\s+.*repo1-locked \(locked-branch\) -- never touched/);
    expect(stdout).not.toContain("Remove anyway?");
    expect(currentWorktreePaths(repo)).toContain(lockedPath);
  });

  it("the main worktree is never listed or removed under any flag", async () => {
    const reposDir = makeTempDir("repos-");
    const repo = initRepo(reposDir, "repo1");

    const { stdout, exitCode } = await runCli(["--force"], reposDir);

    expect(exitCode).toBe(0);
    // No linked worktrees at all -- no header, no bucket lines for repo1.
    expect(stdout).not.toContain("== repo1 ==");
    expect(currentWorktreePaths(repo)).toEqual([repo]);
  });

  it("--force never deletes a branch, only the worktree", async () => {
    const reposDir = makeTempDir("repos-");
    const repo = initRepo(reposDir, "repo1");
    addWorktree(repo, "safe-branch", path.join(reposDir, "repo1-safe"));

    await runCli(["--force"], reposDir);

    expect(localBranches(repo)).toContain("safe-branch");
  });

  it("any argument other than --force is a usage error", async () => {
    const reposDir = makeTempDir("repos-");

    const { stdout, exitCode } = await runCli(["--bogus"], reposDir);

    expect(exitCode).toBe(1);
    expect(stdout).toContain("Unknown argument: --bogus");
  });

  it("with no real tty attached, a confirm-bucket worktree defaults to skipped and the run completes (no hang)", async () => {
    const reposDir = makeTempDir("repos-");
    const repo = initRepo(reposDir, "repo1");
    const dirtyPath = path.join(reposDir, "repo1-dirty");
    addWorktree(repo, "dirty-branch", dirtyPath);
    fs.appendFileSync(path.join(dirtyPath, "f.txt"), "dirty\n");

    const { stdout, exitCode } = await runCli(["--force"], reposDir);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("-> skipped");
    expect(stdout).not.toContain("-> removed");
    expect(currentWorktreePaths(repo)).toContain(dirtyPath);
  });

  it("--force with a dirty worktree prompts, and answering yes over a real tty removes it", async () => {
    const reposDir = makeTempDir("repos-");
    const repo = initRepo(reposDir, "repo1");
    const dirtyPath = path.join(reposDir, "repo1-dirty");
    addWorktree(repo, "dirty-branch", dirtyPath);
    fs.appendFileSync(path.join(dirtyPath, "f.txt"), "dirty\n");

    const { stdout, exitCode } = await runCliWithTtyAnswer(["--force"], reposDir, "y");

    expect(exitCode).toBe(0);
    expect(stdout).toContain(`Remove anyway? ${dirtyPath} [y/N]`);
    expect(stdout).toContain("-> removed");
    expect(currentWorktreePaths(repo)).not.toContain(dirtyPath);
    expect(localBranches(repo)).toContain("dirty-branch");
  }, 10000);

  it("--force with a dirty worktree prompts, and answering no over a real tty leaves it untouched", async () => {
    const reposDir = makeTempDir("repos-");
    const repo = initRepo(reposDir, "repo1");
    const dirtyPath = path.join(reposDir, "repo1-dirty");
    addWorktree(repo, "dirty-branch", dirtyPath);
    fs.appendFileSync(path.join(dirtyPath, "f.txt"), "dirty\n");

    const { stdout, exitCode } = await runCliWithTtyAnswer(["--force"], reposDir, "n");

    expect(exitCode).toBe(0);
    expect(stdout).toContain(`Remove anyway? ${dirtyPath} [y/N]`);
    expect(stdout).toContain("-> skipped");
    expect(currentWorktreePaths(repo)).toContain(dirtyPath);
  }, 10000);

  it("a worktree with unmerged, unpushed commits lands in the confirm bucket with an explanatory reason", async () => {
    const reposDir = makeTempDir("repos-");
    const repo = initRepo(reposDir, "repo1");
    const unpushedPath = path.join(reposDir, "repo1-unpushed");
    addWorktree(repo, "unpushed-branch", unpushedPath);
    fs.writeFileSync(path.join(unpushedPath, "g.txt"), "new\n");
    git(unpushedPath, ["add", "g.txt"]);
    git(unpushedPath, ["commit", "-q", "-m", "unpushed work"]);

    const { stdout, exitCode } = await runCli([], reposDir);

    expect(exitCode).toBe(0);
    expect(stdout).toMatch(
      /\[confirm\]\s+.*repo1-unpushed \(unpushed-branch\) -- not merged into main, no upstream to confirm it's pushed/,
    );
  });

  it("cleans up across multiple repos under one $REPOS_DIR in a single run", async () => {
    const reposDir = makeTempDir("repos-");
    const repoA = initRepo(reposDir, "repoA");
    const repoB = initRepo(reposDir, "repoB");
    addWorktree(repoA, "safe-a", path.join(reposDir, "repoA-safe"));
    addWorktree(repoB, "safe-b", path.join(reposDir, "repoB-safe"));

    const { stdout, exitCode } = await runCli(["--force"], reposDir);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("== repoA ==");
    expect(stdout).toContain("== repoB ==");
    expect(stdout).toContain("Done. Pruned 0 stale worktree(s), removed 2 worktree(s).");
    expect(currentWorktreePaths(repoA)).toEqual([repoA]);
    expect(currentWorktreePaths(repoB)).toEqual([repoB]);
  });

  it("runs correctly from an arbitrary directory, not just from inside my-scripts", async () => {
    const reposDir = makeTempDir("repos-");
    initRepo(reposDir, "repo1");
    const arbitraryCwd = makeTempDir("elsewhere-");

    const result = await new Promise<RunResult>((resolve, reject) => {
      const child = spawn(CLI_PATH, ["clean-worktrees"], {
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
    expect(result.stdout).toContain("Dry run -- no worktrees will be modified.");
  });
});
