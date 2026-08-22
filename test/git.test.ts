import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { listWorktrees } from "../src/git.js";

/**
 * Seam-level tests for git.ts's own git-invocation functions, against real
 * temporary git repos -- no CLI subprocess, no pty. Direct coverage for
 * logic that was previously only reachable transitively through
 * cli.test.ts's end-to-end suite.
 */

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

describe("listWorktrees", () => {
  it("returns the main worktree plus every linked worktree, main first", () => {
    const reposDir = makeTempDir("repos-");
    const repo = initRepo(reposDir, "repo1");
    addWorktree(repo, "feature-branch", path.join(reposDir, "repo1-feature"));

    const result = listWorktrees(repo);

    expect(result.map((w) => w.path)).toEqual([repo, path.join(reposDir, "repo1-feature")]);
    expect(result[1].branch).toBe("feature-branch");
  });

  it("reports a locked worktree's locked flag and reason", () => {
    const reposDir = makeTempDir("repos-");
    const repo = initRepo(reposDir, "repo1");
    const lockedPath = path.join(reposDir, "repo1-locked");
    addWorktree(repo, "locked-branch", lockedPath);
    git(repo, ["worktree", "lock", lockedPath, "--reason", "in use"]);

    const result = listWorktrees(repo);
    const locked = result.find((w) => w.path === lockedPath)!;

    expect(locked.locked).toBe(true);
    expect(locked.lockReason).toBe("in use");
  });

  it("reports a worktree whose directory has been deleted as prunable", () => {
    const reposDir = makeTempDir("repos-");
    const repo = initRepo(reposDir, "repo1");
    const gonePath = path.join(reposDir, "repo1-gone");
    addWorktree(repo, "gone-branch", gonePath);
    fs.rmSync(gonePath, { recursive: true, force: true });

    const result = listWorktrees(repo);
    const gone = result.find((w) => w.path === gonePath)!;

    expect(gone.prunable).toBe(true);
    expect(gone.prunableReason).not.toBe("");
  });
});
