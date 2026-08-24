import { execFileSync } from "node:child_process";

/**
 * The local git-invocation seam for operations not yet carried over to
 * `git-ts` (the shared, independently-versioned git client `my-scripts`
 * otherwise depends on -- see `gitOperations.ts` and the `main.ts` entry
 * points for its imports). Every exported function here makes exactly one
 * subprocess call and returns a structured/typed value, matching `git-ts`'s
 * own seam convention.
 *
 * `listBranches`, `deleteBranch`, `checkout`, and `pull` have already been
 * ported to `git-ts` (Spec #49); `hasOriginRemote` remains here until its
 * own child ticket ports it too.
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
