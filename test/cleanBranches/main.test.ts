import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

/**
 * End-to-end integration suite for the `clean-branches` op, invoked via the
 * real `run` dispatcher shim (not just `src/cleanBranches/main.ts`
 * in-process) as a subprocess against real temporary git repositories,
 * created and torn down per test, and asserts on stdout/exit code -- exactly
 * like a user invoking it from their shell. This is the only place
 * `gitClient.ts`'s real git-invocation behavior, `gatherBranchFacts`'s I/O
 * composition, and `confirm.confirm`'s real tty-reading path get exercised
 * together for branches; everything else is covered by fixture-based unit
 * tests elsewhere (`test/cleanBranches/classify.test.ts`,
 * `test/git/gitClient.test.ts`, `test/git/gitOperations.test.ts`). `run`'s
 * own dispatch behavior (`ls`, unrecognized/missing subcommand) is covered
 * separately in `test/cli/dispatcher.test.ts`. Mirrors
 * `test/cleanWorktree/main.test.ts`'s shape and helpers.
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

/** Creates a local branch (no worktree) at `repoDir`'s current HEAD -- merged into main by construction. */
function addMergedBranch(repoDir: string, branch: string): void {
  git(repoDir, ["branch", branch]);
}

/** Creates a local branch (no worktree) with a commit not reachable from `main` -- unmerged. */
function addUnmergedBranch(repoDir: string, branch: string): void {
  git(repoDir, ["checkout", "-q", "-b", branch]);
  fs.writeFileSync(path.join(repoDir, `${branch}.txt`), "new\n");
  git(repoDir, ["add", `${branch}.txt`]);
  git(repoDir, ["commit", "-q", "-m", branch]);
  git(repoDir, ["checkout", "-q", "main"]);
}

/** Adds a real linked worktree on a new branch off `repoDir`'s current HEAD. */
function addWorktree(repoDir: string, branch: string, worktreePath: string): void {
  git(repoDir, ["branch", branch]);
  git(repoDir, ["worktree", "add", "-q", worktreePath, branch]);
}

function localBranches(repoDir: string): string[] {
  return git(repoDir, ["for-each-ref", "--format=%(refname:short)", "refs/heads/"])
    .trim()
    .split("\n")
    .filter((b) => b !== "");
}

type RunResult = { stdout: string; exitCode: number };

/**
 * Spawns the real `run` shim as a subprocess against the `clean-branches`
 * subcommand, run from an arbitrary cwd (never `my-scripts` itself, proving
 * the shim resolves its own install location independent of the caller's
 * cwd). stdin is a plain pipe -- no real tty attached, matching how the
 * command runs under automation.
 */
function runCli(args: string[], reposDir: string): Promise<RunResult> {
  const cwd = makeTempDir("cwd-");
  return new Promise((resolve, reject) => {
    const child = spawn(CLI_PATH, ["clean-branches", ...args], {
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
 * `clean-branches` subcommand, waits for the confirm prompt text to appear,
 * then writes `answer` to it. This is what actually exercises
 * `confirm.confirm`'s tty-reading branch end-to-end; a plain piped stdin
 * (see `runCli`) always takes the non-tty "skip" branch, by design.
 */
function runCliWithTtyAnswer(args: string[], reposDir: string, answer: string): Promise<RunResult> {
  const cwd = makeTempDir("cwd-");
  const quotedArgs = ["clean-branches", ...args].map((a) => `'${a}'`).join(" ");
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
      if (!answered && stdout.includes("Delete anyway?")) {
        answered = true;
        child.stdin.write(`${answer}\n`);
      }
    });
    child.stderr.on("data", (d) => (stdout += d.toString()));
    child.on("error", reject);
    child.on("close", (exitCode) => resolve({ stdout, exitCode: exitCode ?? -1 }));
  });
}

describe("run clean-branches", () => {
  it("dry run lists current/safe/confirm buckets per repo and deletes nothing", async () => {
    const reposDir = makeTempDir("repos-");
    const repo = initRepo(reposDir, "repo1");
    addMergedBranch(repo, "safe-branch");
    addUnmergedBranch(repo, "unmerged-branch");
    addWorktree(repo, "current-branch", path.join(reposDir, "repo1-current"));

    const before = localBranches(repo).sort();

    const { stdout, exitCode } = await runCli([], reposDir);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("Dry run -- no branches will be deleted. Pass --force to actually clean up.");
    expect(stdout).toContain("== repo1 ==");
    expect(stdout).toMatch(/\[safe\]\s+safe-branch -- would delete/);
    expect(stdout).toMatch(/\[confirm\]\s+unmerged-branch -- not merged into main/);
    expect(stdout).toMatch(/\[current\]\s+current-branch -- checked out at .*repo1-current/);
    expect(stdout).not.toContain("main -- ");
    expect(stdout).toContain("Dry run complete. Re-run with --force to delete/confirm the branches listed above.");
    expect(stdout).not.toContain("-> deleted");

    expect(localBranches(repo).sort()).toEqual(before);
  });

  it("--force deletes safe branches automatically via git branch -d, with no prompt", async () => {
    const reposDir = makeTempDir("repos-");
    const repo = initRepo(reposDir, "repo1");
    addMergedBranch(repo, "safe-branch");

    const { stdout, exitCode } = await runCli(["--force"], reposDir);

    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/\[safe\]\s+safe-branch -- would delete/);
    expect(stdout).not.toContain("Delete anyway?");
    expect(stdout).toContain("-> deleted");
    expect(stdout).toContain("Done. Deleted 1 branch(es).");
    expect(localBranches(repo)).not.toContain("safe-branch");
  });

  it("--force with an unmerged branch prompts, and answering yes over a real tty deletes it via -D", async () => {
    const reposDir = makeTempDir("repos-");
    const repo = initRepo(reposDir, "repo1");
    addUnmergedBranch(repo, "unmerged-branch");

    const { stdout, exitCode } = await runCliWithTtyAnswer(["--force"], reposDir, "y");

    expect(exitCode).toBe(0);
    expect(stdout).toContain("Delete anyway?");
    expect(stdout).toContain("-> deleted");
    expect(localBranches(repo)).not.toContain("unmerged-branch");
  }, 10000);

  it("--force with an unmerged branch prompts, and answering no over a real tty leaves it untouched", async () => {
    const reposDir = makeTempDir("repos-");
    const repo = initRepo(reposDir, "repo1");
    addUnmergedBranch(repo, "unmerged-branch");

    const { stdout, exitCode } = await runCliWithTtyAnswer(["--force"], reposDir, "n");

    expect(exitCode).toBe(0);
    expect(stdout).toContain("Delete anyway?");
    expect(stdout).toContain("-> skipped");
    expect(localBranches(repo)).toContain("unmerged-branch");
  }, 10000);

  it("with no real tty attached, a confirm-bucket branch defaults to skipped and the run completes (no hang)", async () => {
    const reposDir = makeTempDir("repos-");
    const repo = initRepo(reposDir, "repo1");
    addUnmergedBranch(repo, "unmerged-branch");

    const { stdout, exitCode } = await runCli(["--force"], reposDir);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("-> skipped");
    expect(stdout).not.toContain("-> deleted");
    expect(localBranches(repo)).toContain("unmerged-branch");
  });

  it("a branch checked out in the main worktree is reported as current and never deleted, even under --force", async () => {
    const reposDir = makeTempDir("repos-");
    const repo = initRepo(reposDir, "repo1");
    // `main` itself is the default branch and is excluded from candidacy entirely
    // (asserted separately below), so exercise the main-worktree case with a
    // second branch checked out there instead.
    git(repo, ["checkout", "-q", "-b", "main-worktree-branch"]);

    const { stdout, exitCode } = await runCli(["--force"], reposDir);

    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/\[current\]\s+main-worktree-branch -- checked out at .*repo1/);
    expect(localBranches(repo)).toContain("main-worktree-branch");
  });

  it("a branch checked out in a linked worktree is reported as current and never deleted, even under --force", async () => {
    const reposDir = makeTempDir("repos-");
    const repo = initRepo(reposDir, "repo1");
    const worktreePath = path.join(reposDir, "repo1-current");
    addWorktree(repo, "current-branch", worktreePath);

    const { stdout, exitCode } = await runCli(["--force"], reposDir);

    expect(exitCode).toBe(0);
    expect(stdout).toMatch(new RegExp(`\\[current\\]\\s+current-branch -- checked out at ${worktreePath}`));
    expect(localBranches(repo)).toContain("current-branch");
  });

  it("the repo's own default branch never appears as a candidate in any bucket", async () => {
    const reposDir = makeTempDir("repos-");
    const repo = initRepo(reposDir, "repo1");
    addMergedBranch(repo, "safe-branch");

    const { stdout, exitCode } = await runCli(["--force"], reposDir);

    expect(exitCode).toBe(0);
    expect(stdout).not.toMatch(/\[(current|safe|confirm)\]\s+main\b/);
  });

  it("a repo whose default branch can't be resolved is skipped with a printed reason, and the rest of $REPOS_DIR still runs", async () => {
    const reposDir = makeTempDir("repos-");
    const noDefaultRepo = path.join(reposDir, "repo-no-default");
    fs.mkdirSync(noDefaultRepo, { recursive: true });
    git(noDefaultRepo, ["init", "-q", "-b", "some-branch"]);
    git(noDefaultRepo, ["config", "user.email", "test@example.com"]);
    git(noDefaultRepo, ["config", "user.name", "Test"]);
    fs.writeFileSync(path.join(noDefaultRepo, "f.txt"), "hi\n");
    git(noDefaultRepo, ["add", "f.txt"]);
    git(noDefaultRepo, ["commit", "-q", "-m", "init"]);
    // Neither origin/HEAD nor local main/master resolves in this repo.

    const repo2 = initRepo(reposDir, "repo2");
    addMergedBranch(repo2, "safe-branch");

    const { stdout, exitCode } = await runCli(["--force"], reposDir);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("== repo-no-default ==");
    expect(stdout).toContain("skipped -- couldn't resolve a default branch");
    expect(stdout).toContain("== repo2 ==");
    expect(stdout).toContain("-> deleted");
  });

  it("a repo with a real origin remote and origin/HEAD configured still protects its default branch, even when it isn't checked out in any worktree", async () => {
    const reposDir = makeTempDir("repos-");
    const repo = initRepo(reposDir, "repo1");
    const remoteDir = path.join(reposDir, "origin.git");
    fs.mkdirSync(remoteDir, { recursive: true });
    git(remoteDir, ["init", "-q", "--bare"]);
    git(repo, ["remote", "add", "origin", remoteDir]);
    git(repo, ["push", "-q", "-u", "origin", "main"]);
    git(repo, ["remote", "set-head", "origin", "main"]);
    addMergedBranch(repo, "safe-branch");
    // Move the main worktree off "main" so the default branch isn't checked
    // out anywhere -- this is the exact scenario the identity-mismatch bug
    // let slip through: resolveDefaultBranch used to return "origin/main"
    // (remote-qualified), which never matched the plain local branch name
    // "main", so the exclusion filter silently never fired.
    git(repo, ["checkout", "-q", "-b", "other-branch"]);

    const dryRun = await runCli([], reposDir);
    expect(dryRun.exitCode).toBe(0);
    expect(dryRun.stdout).not.toMatch(/\[(current|safe|confirm)\]\s+main\b/);

    const { stdout, exitCode } = await runCli(["--force"], reposDir);

    expect(exitCode).toBe(0);
    expect(stdout).not.toMatch(/\[(current|safe|confirm)\]\s+main\b/);
    expect(localBranches(repo)).toContain("main");
    // An ordinary merged branch in the same repo still classifies and
    // auto-deletes normally in the same run -- the fix targets only the
    // identity check, not classification generally.
    expect(stdout).toMatch(/\[safe\]\s+safe-branch -- would delete/);
    expect(stdout).toContain("-> deleted");
    expect(localBranches(repo)).not.toContain("safe-branch");
  });

  it("a single branch's delete failure is caught, reported inline, and doesn't abort the run", async () => {
    const reposDir = makeTempDir("repos-");
    const repo1 = initRepo(reposDir, "repo1");
    addMergedBranch(repo1, "blocked-branch");
    const refsHeadsDir = path.join(repo1, ".git", "refs", "heads");
    // Deleting a loose ref requires write permission on its containing
    // directory (unlink checks the directory, not the file) -- this
    // deterministically fails the delete without any git-level trickery.
    fs.chmodSync(refsHeadsDir, 0o555);

    const repo2 = initRepo(reposDir, "repo2");
    addMergedBranch(repo2, "safe-branch");

    let result: RunResult;
    try {
      result = await runCli(["--force"], reposDir);
    } finally {
      fs.chmodSync(refsHeadsDir, 0o755);
    }

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/\[safe\]\s+blocked-branch -- would delete/);
    expect(result.stdout).toContain("-> failed:");
    expect(result.stdout).toContain("== repo2 ==");
    expect(result.stdout).toMatch(/\[safe\]\s+safe-branch -- would delete/);
    expect(result.stdout).toContain("-> deleted");
    expect(localBranches(repo1)).toContain("blocked-branch");
    expect(localBranches(repo2)).not.toContain("safe-branch");
  });

  it("cleans up across multiple repos under one $REPOS_DIR in a single run", async () => {
    const reposDir = makeTempDir("repos-");
    const repoA = initRepo(reposDir, "repoA");
    const repoB = initRepo(reposDir, "repoB");
    addMergedBranch(repoA, "safe-a");
    addMergedBranch(repoB, "safe-b");

    const { stdout, exitCode } = await runCli(["--force"], reposDir);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("== repoA ==");
    expect(stdout).toContain("== repoB ==");
    expect(stdout).toContain("Done. Deleted 2 branch(es).");
    expect(localBranches(repoA)).not.toContain("safe-a");
    expect(localBranches(repoB)).not.toContain("safe-b");
  });

  it("any argument other than --force is a usage error", async () => {
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
      const child = spawn(CLI_PATH, ["clean-branches"], {
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
    expect(result.stdout).toContain("Dry run -- no branches will be deleted.");
  });
});
