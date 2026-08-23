import { execFileSync } from "node:child_process";

/**
 * The local git-invocation seam for operations not yet carried over to
 * `git-ts` (the shared, independently-versioned git client `my-scripts`
 * otherwise depends on -- see `gitOperations.ts` and the `main.ts` entry
 * points for its imports). Every exported function here makes exactly one
 * subprocess call and returns a structured/typed value, matching `git-ts`'s
 * own seam convention.
 */

function runGit(cwd: string, args: string[]): string {
  // execFileSync's default stdio (when unset) inherits the child's stderr
  // straight to this process's own — captured stdout alone isn't enough to
  // keep git's own chatter off the terminal. Piping all three streams
  // explicitly is what actually captures output instead of streaming it live.
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/**
 * Every local branch name in `repoDir`, sourced from `refs/heads/`. Empty
 * array when the repo has no branches yet (e.g. a freshly initialized repo
 * with no commits).
 */
export function listBranches(repoDir: string): string[] {
  const out = runGit(repoDir, ["for-each-ref", "--format=%(refname:short)", "refs/heads/"]).trim();
  return out === "" ? [] : out.split("\n");
}

/**
 * Deletes the local branch `branch` in `repoDir`. Defaults to git's safe
 * `-d` form, which throws when the branch isn't merged into its current/
 * upstream branch -- a second, independent gate beyond this tool's own
 * classification; `opts.force` switches to the `-D` form, which deletes
 * regardless of merge status. Mirrors `removeWorktree`'s `{ force? }`-flag
 * pattern.
 */
export function deleteBranch(repoDir: string, branch: string, opts?: { force?: boolean }): void {
  runGit(repoDir, ["branch", opts?.force ? "-D" : "-d", branch]);
}
