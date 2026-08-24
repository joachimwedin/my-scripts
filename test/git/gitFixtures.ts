import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Shared real-git-repo fixture helpers for gitOperations.test.ts's seam-level
 * tests and syncRepos/main.test.ts's end-to-end tests -- no CLI subprocess
 * (beyond the CLI-under-test itself), no mocking, no pty. Each test file
 * owns its own `createTempDirTracker()` instance, so cleanup state never
 * leaks between files. Fixtures that existed only to support the operations
 * now ported to `git-ts` (e.g. a stash-creating helper) live in `git-ts`'s
 * own copy of this file instead.
 */

export function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

/** Tracks every temp dir `makeTempDir` creates, for a single `afterEach` cleanup call. */
export function createTempDirTracker(): { makeTempDir: (prefix: string) => string; cleanup: () => void } {
  const tempDirs: string[] = [];

  function makeTempDir(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  function cleanup(): void {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  return { makeTempDir, cleanup };
}

/** Creates a real git repo at `<reposDir>/<name>` with one commit on `main`. */
export function initRepo(reposDir: string, name: string): string {
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
export function addWorktree(repoDir: string, branch: string, worktreePath: string): void {
  git(repoDir, ["branch", branch]);
  git(repoDir, ["worktree", "add", "-q", worktreePath, branch]);
}

/** Creates a real bare repo at `<reposDir>/<name>`, suitable for use as a remote. */
export function initBareRemote(reposDir: string, name: string): string {
  const remoteDir = path.join(reposDir, name);
  fs.mkdirSync(remoteDir, { recursive: true });
  git(remoteDir, ["init", "-q", "--bare"]);
  return remoteDir;
}

/** Configures `repoDir`'s `origin` remote to point at `remoteDir`. */
export function addOriginRemote(repoDir: string, remoteDir: string): void {
  git(repoDir, ["remote", "add", "origin", remoteDir]);
}

/**
 * Clones `remoteDir` into a real working repo at `<reposDir>/<name>`,
 * checking out `branch` explicitly (`git clone -b <branch>`) rather than
 * relying on the bare remote's own HEAD -- which `initBareRemote` never
 * points at any real branch, so an unqualified clone can't check one out.
 * `user.name`/`user.email` are configured so the clone can make its own
 * commits (e.g. to exercise a diverged-history pull). Its `origin` remote
 * and upstream tracking branch are set up by `git clone` itself.
 */
export function cloneRepo(remoteDir: string, reposDir: string, name: string, branch = "main"): string {
  git(reposDir, ["clone", "-q", "-b", branch, remoteDir, name]);
  const repoDir = path.join(reposDir, name);
  git(repoDir, ["config", "user.email", "test@example.com"]);
  git(repoDir, ["config", "user.name", "Test"]);
  return repoDir;
}

