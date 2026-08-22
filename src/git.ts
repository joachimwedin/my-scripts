import { execFileSync } from "node:child_process";

import { parseWorktrees } from "./parseWorktrees.js";
import type { Worktree } from "./parseWorktrees.js";

/**
 * Thin wrappers around `git` invocations used to gather the facts
 * `classify.ts` needs to bucket a worktree. No decision logic lives here —
 * every function either returns a raw fact or null/false when git can't
 * answer the question (e.g. no origin/HEAD set, no upstream configured).
 */

function runGit(cwd: string, args: string[]): string {
  // execFileSync's default stdio (when unset) inherits the child's stderr
  // straight to this process's own — captured stdout alone isn't enough to
  // keep git's own chatter (e.g. `worktree prune -v`'s per-line report) off
  // the terminal. Piping all three streams explicitly is what actually
  // captures output instead of streaming it live.
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/**
 * Every worktree in the repo at `repoDir`, main worktree first, exactly as
 * `git worktree list --porcelain` itself orders them.
 */
export function listWorktrees(repoDir: string): Worktree[] {
  const porcelain = runGit(repoDir, ["worktree", "list", "--porcelain"]);
  return parseWorktrees(porcelain);
}

/**
 * Clears stale worktree admin data for worktrees whose directories are gone.
 * Captures git's own `-v` output rather than streaming it live; the caller
 * already prints its own `[prune]` bucket lines before this runs, so git's
 * text would just be redundant chatter.
 */
export function pruneWorktrees(repoDir: string): void {
  runGit(repoDir, ["worktree", "prune", "-v"]);
}

/** True when the worktree at `worktreePath` has uncommitted/untracked changes. */
export function isWorkingTreeDirty(worktreePath: string): boolean {
  return runGit(worktreePath, ["status", "--porcelain"]).trim() !== "";
}

/**
 * A ref to compare a worktree's branch against for "merged" status:
 * `origin/HEAD`'s target if set, else local `main`, else local `master`.
 * Returns null if none of those resolve — callers then treat merged status
 * as unconfirmed rather than guessing.
 */
export function defaultBranchRef(repoPath: string): string | null {
  try {
    const ref = execFileSync(
      "git",
      ["symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"],
      { cwd: repoPath, encoding: "utf8" },
    ).trim();
    if (ref !== "") {
      return ref;
    }
  } catch {
    // No origin/HEAD set — fall through to the next candidate.
  }

  for (const candidate of ["main", "master"]) {
    try {
      execFileSync("git", ["show-ref", "-q", "--verify", `refs/heads/${candidate}`], {
        cwd: repoPath,
      });
      return candidate;
    } catch {
      // Branch doesn't exist locally — try the next candidate.
    }
  }

  return null;
}

/**
 * True when `worktreePath`'s HEAD is an ancestor of `defaultRef` (i.e. its
 * branch is merged into the repo's default branch). False when `defaultRef`
 * is null (no known default branch to compare against).
 */
export function isMergedIntoDefault(worktreePath: string, defaultRef: string | null): boolean {
  if (defaultRef === null) {
    return false;
  }
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", "HEAD", defaultRef], {
      cwd: worktreePath,
    });
    return true;
  } catch {
    return false;
  }
}

/** The worktree's configured upstream (e.g. "origin/feature"), or null if none. */
export function getUpstream(worktreePath: string): string | null {
  try {
    const upstream = execFileSync(
      "git",
      ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
      { cwd: worktreePath, encoding: "utf8" },
    ).trim();
    return upstream === "" ? null : upstream;
  } catch {
    return null;
  }
}

/** How many commits `worktreePath`'s HEAD is ahead of `upstream`. */
export function aheadCount(worktreePath: string, upstream: string): number {
  const out = runGit(worktreePath, ["rev-list", "--count", `${upstream}..HEAD`]).trim();
  return Number.parseInt(out, 10);
}
