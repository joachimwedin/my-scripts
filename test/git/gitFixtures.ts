import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Shared real-git-repo fixture helpers for gitClient.test.ts's and
 * gitOperations.test.ts's seam-level tests -- no CLI subprocess, no mocking,
 * no pty. Each test file owns its own `createTempDirTracker()` instance, so
 * cleanup state never leaks between files.
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

/** Stashes a change to `f.txt` in `repoDir` under `message`, creating one real stash entry. */
export function addStash(repoDir: string, message: string): void {
  fs.writeFileSync(path.join(repoDir, "f.txt"), `changed-${message}\n`);
  git(repoDir, ["stash", "push", "-m", message]);
}
