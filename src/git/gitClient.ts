import { execFileSync } from "node:child_process";

/**
 * The local git-invocation seam for operations not yet carried over to
 * `git-ts` (the shared, independently-versioned git client `my-scripts`
 * otherwise depends on -- see `gitOperations.ts` and the `main.ts` entry
 * points for its imports). Every exported function here makes exactly one
 * subprocess call and returns a structured/typed value, matching `git-ts`'s
 * own seam convention.
 *
 * `listBranches` and `deleteBranch` have already been ported to `git-ts`
 * (Spec #49); `hasOriginRemote`, `checkout`, and `pull` remain here until
 * their own child tickets port them too.
 */

function runGit(cwd: string, args: string[]): string {
  // execFileSync's default stdio (when unset) inherits the child's stderr
  // straight to this process's own — captured stdout alone isn't enough to
  // keep git's own chatter off the terminal. Piping all three streams
  // explicitly is what actually captures output instead of streaming it live.
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/**
 * Runs `runGit`, treating any failure as an expected, non-exceptional
 * outcome: returns the trimmed stdout on success, or `null` on any thrown
 * error instead of propagating it. The landing point for "probe" functions
 * below whose failure is a normal result to report, not a bug to surface.
 */
function tryRunGit(cwd: string, args: string[]): string | null {
  try {
    return runGit(cwd, args).trim();
  } catch {
    return null;
  }
}

/**
 * Reports whether `repoDir` has an `origin` remote configured, via `git
 * remote get-url origin`. `false` for a repo with no `origin` remote at
 * all (the command exits non-zero), `true` otherwise.
 */
export function hasOriginRemote(repoDir: string): boolean {
  return tryRunGit(repoDir, ["remote", "get-url", "origin"]) !== null;
}

/** Checks out `branch` in `repoDir` via `git checkout <branch>`. */
export function checkout(repoDir: string, branch: string): void {
  runGit(repoDir, ["checkout", branch]);
}

/**
 * Pulls the current branch in `repoDir` from its configured upstream via a
 * plain merge `git pull` (no `--ff-only`), so a genuinely diverged
 * local/remote history is merged rather than rejected. `--no-rebase` pins
 * the merge strategy explicitly rather than falling through to whatever
 * `pull.rebase`/`pull.ff` the ambient git config (or its absence) would
 * otherwise pick -- git itself refuses to guess and errors out on a
 * diverged history unless a strategy is specified one way or another.
 */
export function pull(repoDir: string): void {
  runGit(repoDir, ["pull", "--no-rebase"]);
}
