import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

/**
 * End-to-end integration suite for the `ensure-pristine` op, invoked via the
 * real `run` dispatcher shim (not just `src/ensurePristine/main.ts`
 * in-process) as a subprocess against real temporary git repositories
 * (including a real bare-repo `origin`), created and torn down per test, and
 * asserts on stdout/exit code plus actual post-run git state -- exactly like
 * a user invoking it from their shell. This is the only place
 * `gatherPristineFacts`'s full I/O composition, the fix orchestration order,
 * and `confirm.confirm`'s real tty-reading path get exercised together for
 * this op; everything else is covered by fixture-based unit tests elsewhere
 * (`test/ensurePristine/classify.test.ts`, `test/git/gitOperations.test.ts`,
 * `test/git/gitClient.test.ts`). `run`'s own dispatch behavior (`ls`,
 * unrecognized/missing subcommand) is covered separately in
 * `test/cli/dispatcher.test.ts`. Mirrors `test/cleanBranches/main.test.ts`/
 * `test/cleanWorktree/main.test.ts`'s shape and helpers, plus the
 * origin/clone helpers `test/git/gitOperations.test.ts` uses for
 * `compareToRemote` coverage.
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

/** Creates a real bare repo at `<reposDir>/<name>`, suitable for use as a remote. */
function initBareRemote(reposDir: string, name: string): string {
  const remoteDir = path.join(reposDir, name);
  fs.mkdirSync(remoteDir, { recursive: true });
  git(remoteDir, ["init", "-q", "--bare"]);
  return remoteDir;
}

/**
 * Configures `repoDir`'s `origin` remote to point at `remoteDir`, pushes
 * `main`, and sets `origin/HEAD` -- everything `resolveDefaultBranch` needs
 * to resolve the remote-qualified merge target.
 */
function addOriginRemote(repoDir: string, remoteDir: string): void {
  git(repoDir, ["remote", "add", "origin", remoteDir]);
  git(repoDir, ["push", "-q", "-u", "origin", "main"]);
  git(repoDir, ["remote", "set-head", "origin", "main"]);
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

function currentWorktreePaths(repoDir: string): string[] {
  return git(repoDir, ["worktree", "list", "--porcelain"])
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length));
}

function headCommit(repoDir: string): string {
  return git(repoDir, ["rev-parse", "HEAD"]).trim();
}

type RunResult = { stdout: string; exitCode: number };

/**
 * Spawns the real `run` shim as a subprocess against the `ensure-pristine`
 * subcommand, run from an arbitrary cwd (never `my-scripts` itself, proving
 * the shim resolves its own install location independent of the caller's
 * cwd). stdin is a plain pipe -- no real tty attached, matching how the
 * command runs under automation.
 */
function runCli(args: string[], reposDir: string): Promise<RunResult> {
  const cwd = makeTempDir("cwd-");
  return new Promise((resolve, reject) => {
    const child = spawn(CLI_PATH, ["ensure-pristine", ...args], {
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
 * `ensure-pristine` subcommand, waits for `promptText` to appear, then writes
 * `answer` to it. This is what actually exercises `confirm.confirm`'s
 * tty-reading branch end-to-end; a plain piped stdin (see `runCli`) always
 * takes the non-tty "skip" branch, by design.
 */
function runCliWithTtyAnswer(args: string[], reposDir: string, promptText: string, answer: string): Promise<RunResult> {
  const cwd = makeTempDir("cwd-");
  const quotedArgs = ["ensure-pristine", ...args].map((a) => `'${a}'`).join(" ");
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
      if (!answered && stdout.includes(promptText)) {
        answered = true;
        child.stdin.write(`${answer}\n`);
      }
    });
    child.stderr.on("data", (d) => (stdout += d.toString()));
    child.on("error", reject);
    child.on("close", (exitCode) => resolve({ stdout, exitCode: exitCode ?? -1 }));
  });
}

describe("run ensure-pristine", () => {
  it("dry run processes every repo under $REPOS_DIR sequentially and changes nothing", async () => {
    const reposDir = makeTempDir("repos-");
    const repo1 = initRepo(reposDir, "repo1");
    const repo2 = initRepo(reposDir, "repo2");
    git(repo1, ["branch", "stray-branch"]);
    const beforeBranches = localBranches(repo1).sort();
    const beforeHead2 = headCommit(repo2);

    const { stdout, exitCode } = await runCli([], reposDir);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("Dry run -- nothing will be changed. Pass --force to fix what can be fixed safely.");
    expect(stdout).toContain("== repo1 ==");
    expect(stdout).toContain("== repo2 ==");
    expect(localBranches(repo1).sort()).toEqual(beforeBranches);
    expect(headCommit(repo2)).toBe(beforeHead2);
  });

  it("an already-pristine repo is reported PRISTINE and left untouched", async () => {
    const reposDir = makeTempDir("repos-");
    initRepo(reposDir, "repo1");

    const { stdout, exitCode } = await runCli([], reposDir);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("== repo1 ==");
    expect(stdout).toMatch(/== repo1 ==\s*\n\s*PRISTINE/);
    expect(stdout).toContain("Done. 1 pristine, 0 not-pristine, 0 failed.");
  });

  it("an extra safe-to-delete branch is NOT PRISTINE in dry run and gets deleted under --force, ending up PRISTINE", async () => {
    const reposDir = makeTempDir("repos-");
    const repo = initRepo(reposDir, "repo1");
    git(repo, ["branch", "safe-branch"]);

    const dryRun = await runCli([], reposDir);
    expect(dryRun.exitCode).toBe(0);
    expect(dryRun.stdout).toMatch(/\[safe\]\s+safe-branch -- would delete/);
    expect(dryRun.stdout).toContain("NOT PRISTINE");
    expect(localBranches(repo)).toContain("safe-branch");

    const forced = await runCli(["--force"], reposDir);
    expect(forced.exitCode).toBe(0);
    expect(forced.stdout).toContain("-> deleted");
    expect(forced.stdout).toMatch(/== repo1 ==[\s\S]*PRISTINE/);
    expect(forced.stdout).not.toContain("NOT PRISTINE");
    expect(localBranches(repo)).not.toContain("safe-branch");
  });

  it("an extra safe-to-remove worktree is NOT PRISTINE in dry run and gets removed under --force, ending up PRISTINE", async () => {
    const reposDir = makeTempDir("repos-");
    const repo = initRepo(reposDir, "repo1");
    const wtPath = path.join(reposDir, "repo1-wt");
    addWorktree(repo, "wt-branch", wtPath);

    const dryRun = await runCli([], reposDir);
    expect(dryRun.exitCode).toBe(0);
    expect(dryRun.stdout).toMatch(new RegExp(`\\[safe\\]\\s+${wtPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} -- would remove`));
    expect(dryRun.stdout).toContain("NOT PRISTINE");
    expect(currentWorktreePaths(repo)).toContain(wtPath);

    const forced = await runCli(["--force"], reposDir);
    expect(forced.exitCode).toBe(0);
    expect(forced.stdout).toContain("-> removed");
    expect(forced.stdout).toMatch(/== repo1 ==[\s\S]*PRISTINE/);
    expect(forced.stdout).not.toContain("NOT PRISTINE");
    expect(currentWorktreePaths(repo)).not.toContain(wtPath);
    // Once the worktree is gone, `wt-branch` is no longer checked out
    // anywhere and (being an unmodified branch off main) is merged, so it
    // becomes deletable too under ensure-pristine's own branch step -- this
    // is what makes the repo end up fully PRISTINE, asserted above.
    expect(localBranches(repo)).not.toContain("wt-branch");
  });

  it("a dirty stray worktree is reported NOT PRISTINE and is never modified, with or without --force", async () => {
    const reposDir = makeTempDir("repos-");
    const repo = initRepo(reposDir, "repo1");
    const dirtyPath = path.join(reposDir, "repo1-dirty");
    addWorktree(repo, "dirty-branch", dirtyPath);
    fs.appendFileSync(path.join(dirtyPath, "f.txt"), "dirty\n");

    const dryRun = await runCli([], reposDir);
    expect(dryRun.exitCode).toBe(0);
    expect(dryRun.stdout).toContain("NOT PRISTINE");
    expect(currentWorktreePaths(repo)).toContain(dirtyPath);

    const forced = await runCli(["--force"], reposDir);
    expect(forced.exitCode).toBe(0);
    expect(forced.stdout).toContain("NOT PRISTINE");
    expect(forced.stdout).toContain("-> skipped");
    expect(currentWorktreePaths(repo)).toContain(dirtyPath);
    expect(localBranches(repo)).toContain("dirty-branch");
  });

  it("a fast-forwardable default branch is NOT PRISTINE in dry run and gets fast-forwarded under --force, ending up PRISTINE", async () => {
    const reposDir = makeTempDir("repos-");
    const remote = initBareRemote(reposDir, "origin.git");
    const upstream = initRepo(reposDir, "upstream");
    addOriginRemote(upstream, remote);

    // Clone repo1 while it's still up-to-date, *then* advance and push a
    // second commit on the upstream side, and `fetch` (without merging) in
    // repo1 -- this is what leaves repo1's local `main` genuinely behind its
    // already-updated `origin/main` remote-tracking ref.
    git(reposDir, ["clone", "-q", "-b", "main", remote, "repo1"]);
    const repo = path.join(reposDir, "repo1");
    git(repo, ["config", "user.email", "test@example.com"]);
    git(repo, ["config", "user.name", "Test"]);
    git(repo, ["remote", "set-head", "origin", "main"]);

    fs.writeFileSync(path.join(upstream, "f.txt"), "second\n");
    git(upstream, ["add", "f.txt"]);
    git(upstream, ["commit", "-q", "-m", "second"]);
    git(upstream, ["push", "-q", "origin", "main"]);
    const remoteHead = git(upstream, ["rev-parse", "main"]).trim();
    git(repo, ["fetch", "-q", "origin"]);

    const dryRun = await runCli([], reposDir);
    expect(dryRun.exitCode).toBe(0);
    expect(dryRun.stdout).toMatch(/\[sync\]\s+main -- behind origin/);
    expect(dryRun.stdout).toContain("NOT PRISTINE");
    expect(headCommit(repo)).not.toBe(remoteHead);

    const forced = await runCli(["--force"], reposDir);
    expect(forced.exitCode).toBe(0);
    expect(forced.stdout).toContain("-> fast-forwarded");
    expect(forced.stdout).toMatch(/== repo1 ==[\s\S]*PRISTINE/);
    expect(forced.stdout).not.toContain("NOT PRISTINE");
    expect(headCommit(repo)).toBe(remoteHead);
  });

  it("a default branch ahead of origin is always NOT PRISTINE and is never pushed, with or without --force", async () => {
    const reposDir = makeTempDir("repos-");
    const remote = initBareRemote(reposDir, "origin.git");
    const repo = initRepo(reposDir, "repo1");
    addOriginRemote(repo, remote);
    fs.writeFileSync(path.join(repo, "g.txt"), "local only\n");
    git(repo, ["add", "g.txt"]);
    git(repo, ["commit", "-q", "-m", "ahead"]);
    const localHead = headCommit(repo);
    const remoteHeadBefore = git(remote, ["rev-parse", "main"]).trim();

    const dryRun = await runCli([], reposDir);
    expect(dryRun.exitCode).toBe(0);
    expect(dryRun.stdout).toMatch(/\[sync\]\s+main -- ahead of origin/);
    expect(dryRun.stdout).toContain("NOT PRISTINE");

    const forced = await runCli(["--force"], reposDir);
    expect(forced.exitCode).toBe(0);
    expect(forced.stdout).toContain("NOT PRISTINE");
    expect(headCommit(repo)).toBe(localHead);
    expect(git(remote, ["rev-parse", "main"]).trim()).toBe(remoteHeadBefore);
  });

  it("a diverged default branch is always NOT PRISTINE and is never merged or reset, with or without --force", async () => {
    const reposDir = makeTempDir("repos-");
    const remote = initBareRemote(reposDir, "origin.git");
    const upstream = initRepo(reposDir, "upstream");
    addOriginRemote(upstream, remote);

    git(reposDir, ["clone", "-q", "-b", "main", remote, "repo1"]);
    const repo = path.join(reposDir, "repo1");
    git(repo, ["config", "user.email", "test@example.com"]);
    git(repo, ["config", "user.name", "Test"]);
    git(repo, ["remote", "set-head", "origin", "main"]);

    fs.writeFileSync(path.join(upstream, "remote-file.txt"), "remote change\n");
    git(upstream, ["add", "remote-file.txt"]);
    git(upstream, ["commit", "-q", "-m", "remote change"]);
    git(upstream, ["push", "-q", "origin", "main"]);

    fs.writeFileSync(path.join(repo, "local-file.txt"), "local change\n");
    git(repo, ["add", "local-file.txt"]);
    git(repo, ["commit", "-q", "-m", "local change"]);
    git(repo, ["fetch", "-q", "origin"]);
    const localHead = headCommit(repo);

    const dryRun = await runCli([], reposDir);
    expect(dryRun.exitCode).toBe(0);
    expect(dryRun.stdout).toMatch(/\[sync\]\s+main -- diverged from origin/);
    expect(dryRun.stdout).toContain("NOT PRISTINE");

    const forced = await runCli(["--force"], reposDir);
    expect(forced.exitCode).toBe(0);
    expect(forced.stdout).toContain("NOT PRISTINE");
    expect(headCommit(repo)).toBe(localHead);
  });

  it("a locked worktree is always NOT PRISTINE and is never unlocked or removed, with or without --force", async () => {
    const reposDir = makeTempDir("repos-");
    const repo = initRepo(reposDir, "repo1");
    const lockedPath = path.join(reposDir, "repo1-locked");
    addWorktree(repo, "locked-branch", lockedPath);
    git(repo, ["worktree", "lock", lockedPath, "--reason", "in use"]);

    const dryRun = await runCli([], reposDir);
    expect(dryRun.exitCode).toBe(0);
    expect(dryRun.stdout).toMatch(/\[locked\]\s+.*repo1-locked -- in use -- never touched/);
    expect(dryRun.stdout).toContain("NOT PRISTINE");

    const forced = await runCli(["--force"], reposDir);
    expect(forced.exitCode).toBe(0);
    expect(forced.stdout).toContain("NOT PRISTINE");
    expect(forced.stdout).not.toContain("Remove anyway?");
    expect(currentWorktreePaths(repo)).toContain(lockedPath);
  });

  it("a repo with no origin remote is still evaluated and fixed for branches/worktrees, treating origin-sync as not applicable", async () => {
    const reposDir = makeTempDir("repos-");
    const repo = initRepo(reposDir, "repo1");
    git(repo, ["branch", "safe-branch"]);
    const wtPath = path.join(reposDir, "repo1-wt");
    addWorktree(repo, "wt-branch", wtPath);

    const dryRun = await runCli([], reposDir);
    expect(dryRun.exitCode).toBe(0);
    expect(dryRun.stdout).not.toMatch(/\[sync\]/);
    expect(dryRun.stdout).toMatch(/\[safe\]\s+safe-branch -- would delete/);

    const forced = await runCli(["--force"], reposDir);
    expect(forced.exitCode).toBe(0);
    expect(forced.stdout).not.toMatch(/\[sync\]/);
    expect(forced.stdout).toMatch(/== repo1 ==[\s\S]*PRISTINE/);
    expect(forced.stdout).not.toContain("NOT PRISTINE");
    expect(localBranches(repo)).not.toContain("safe-branch");
    expect(currentWorktreePaths(repo)).not.toContain(wtPath);
  });

  it("a branch only checked out in an extra worktree becomes deletable after that worktree is removed earlier in the same run", async () => {
    const reposDir = makeTempDir("repos-");
    const repo = initRepo(reposDir, "repo1");
    const wtPath = path.join(reposDir, "repo1-wt");
    addWorktree(repo, "wt-branch", wtPath);

    const dryRun = await runCli([], reposDir);
    expect(dryRun.exitCode).toBe(0);
    expect(dryRun.stdout).toMatch(/\[current\]\s+wt-branch -- checked out at/);

    const forced = await runCli(["--force"], reposDir);
    expect(forced.exitCode).toBe(0);
    expect(forced.stdout).toContain("-> removed");
    expect(forced.stdout).toContain("-> deleted");
    expect(forced.stdout).toMatch(/== repo1 ==[\s\S]*PRISTINE/);
    expect(currentWorktreePaths(repo)).not.toContain(wtPath);
    expect(localBranches(repo)).not.toContain("wt-branch");
  });

  it("a confirm-bucket branch goes through the same confirm() prompt clean-branches uses under --force", async () => {
    const reposDir = makeTempDir("repos-");
    const repo = initRepo(reposDir, "repo1");
    git(repo, ["checkout", "-q", "-b", "unmerged-branch"]);
    fs.writeFileSync(path.join(repo, "unmerged.txt"), "new\n");
    git(repo, ["add", "unmerged.txt"]);
    git(repo, ["commit", "-q", "-m", "unmerged"]);
    git(repo, ["checkout", "-q", "main"]);

    const accepted = await runCliWithTtyAnswer(["--force"], reposDir, "Delete anyway?", "y");
    expect(accepted.exitCode).toBe(0);
    expect(accepted.stdout).toContain("Delete anyway?");
    expect(accepted.stdout).toContain("-> deleted");
    expect(localBranches(repo)).not.toContain("unmerged-branch");
  }, 10000);

  it("a confirm-bucket worktree goes through the same confirm() prompt clean-worktree uses under --force", async () => {
    const reposDir = makeTempDir("repos-");
    const repo = initRepo(reposDir, "repo1");
    const dirtyPath = path.join(reposDir, "repo1-dirty");
    addWorktree(repo, "dirty-branch", dirtyPath);
    fs.appendFileSync(path.join(dirtyPath, "f.txt"), "dirty\n");

    const accepted = await runCliWithTtyAnswer(["--force"], reposDir, "Remove anyway?", "y");
    expect(accepted.exitCode).toBe(0);
    expect(accepted.stdout).toContain("Remove anyway?");
    expect(accepted.stdout).toContain("-> removed");
    expect(currentWorktreePaths(repo)).not.toContain(dirtyPath);
  }, 10000);

  it("the verdict printed after --force reflects the post-fix state, not the pre-fix snapshot", async () => {
    const reposDir = makeTempDir("repos-");
    const repo = initRepo(reposDir, "repo1");
    const dirtyPath = path.join(reposDir, "repo1-dirty");
    addWorktree(repo, "dirty-branch", dirtyPath);
    fs.appendFileSync(path.join(dirtyPath, "f.txt"), "dirty\n");

    const { stdout, exitCode } = await runCli(["--force"], reposDir);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("-> skipped");
    expect(stdout).toMatch(/== repo1 ==[\s\S]*NOT PRISTINE/);
  });

  it("a repo that fails outright while being processed is reported as a failure and doesn't stop the run", async () => {
    const reposDir = makeTempDir("repos-");
    const repo1 = initRepo(reposDir, "repo1");
    // Corrupts the index so `git status --porcelain` (isWorkingTreeDirty)
    // throws unexpectedly, while ref resolution (which doesn't touch the
    // index) still succeeds -- this is what makes it an "outright failure"
    // during processing rather than a normal not-pristine outcome.
    fs.writeFileSync(path.join(repo1, ".git", "index"), "garbage-corrupt-index-bytes-not-a-real-index-file");

    const repo2 = initRepo(reposDir, "repo2");
    git(repo2, ["branch", "safe-branch"]);

    const { stdout, exitCode } = await runCli(["--force"], reposDir);

    expect(exitCode).toBe(1);
    expect(stdout).toContain("== repo1 ==");
    expect(stdout).toContain("FAILED");
    expect(stdout).toContain("== repo2 ==");
    expect(stdout).toContain("-> deleted");
    expect(stdout).toContain("Done. 1 pristine, 0 not-pristine, 1 failed.");
  });

  it("a repo whose default branch can't be resolved at all is reported NOT PRISTINE (unresolved) rather than crashing the run", async () => {
    const reposDir = makeTempDir("repos-");
    const noDefaultRepo = path.join(reposDir, "repo-no-default");
    fs.mkdirSync(noDefaultRepo, { recursive: true });
    git(noDefaultRepo, ["init", "-q", "-b", "some-branch"]);
    git(noDefaultRepo, ["config", "user.email", "test@example.com"]);
    git(noDefaultRepo, ["config", "user.name", "Test"]);
    fs.writeFileSync(path.join(noDefaultRepo, "f.txt"), "hi\n");
    git(noDefaultRepo, ["add", "f.txt"]);
    git(noDefaultRepo, ["commit", "-q", "-m", "init"]);

    const repo2 = initRepo(reposDir, "repo2");

    const { stdout, exitCode } = await runCli(["--force"], reposDir);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("== repo-no-default ==");
    expect(stdout).toContain("NOT PRISTINE -- couldn't resolve a default branch");
    expect(stdout).toContain("== repo2 ==");
    expect(stdout).toContain("PRISTINE");
  });

  it("a closing summary reports counts of pristine / not-pristine / failed repos across a mixed run", async () => {
    const reposDir = makeTempDir("repos-");
    initRepo(reposDir, "pristine-repo");
    const notPristineRepo = initRepo(reposDir, "not-pristine-repo");
    git(notPristineRepo, ["checkout", "-q", "-b", "unmerged-branch"]);
    fs.writeFileSync(path.join(notPristineRepo, "unmerged.txt"), "new\n");
    git(notPristineRepo, ["add", "unmerged.txt"]);
    git(notPristineRepo, ["commit", "-q", "-m", "unmerged"]);
    git(notPristineRepo, ["checkout", "-q", "main"]);
    const failedRepo = initRepo(reposDir, "failed-repo");
    fs.writeFileSync(path.join(failedRepo, ".git", "index"), "garbage-corrupt-index-bytes-not-a-real-index-file");

    const { stdout, exitCode } = await runCli([], reposDir);

    expect(exitCode).toBe(1);
    expect(stdout).toContain("Done. 1 pristine, 1 not-pristine, 1 failed.");
  });

  it("the command exits non-zero only if a repo failed outright, not merely because a repo is not pristine", async () => {
    const reposDir = makeTempDir("repos-");
    const repo = initRepo(reposDir, "repo1");
    git(repo, ["checkout", "-q", "-b", "unmerged-branch"]);
    fs.writeFileSync(path.join(repo, "unmerged.txt"), "new\n");
    git(repo, ["add", "unmerged.txt"]);
    git(repo, ["commit", "-q", "-m", "unmerged"]);
    git(repo, ["checkout", "-q", "main"]);

    const { stdout, exitCode } = await runCli([], reposDir);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("NOT PRISTINE");
  });

  it("any argument other than --force is a usage error", async () => {
    const reposDir = makeTempDir("repos-");

    const { stdout, exitCode } = await runCli(["--bogus"], reposDir);

    expect(exitCode).toBe(1);
    expect(stdout).toContain("Unknown argument: --bogus");
  });

  it("run ensure-pristine runs correctly from an arbitrary directory, not just from inside my-scripts", async () => {
    const reposDir = makeTempDir("repos-");
    initRepo(reposDir, "repo1");
    const arbitraryCwd = makeTempDir("elsewhere-");

    const result = await new Promise<RunResult>((resolve, reject) => {
      const child = spawn(CLI_PATH, ["ensure-pristine"], {
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
    expect(result.stdout).toContain("Dry run -- nothing will be changed.");
  });
});
