import { execFileSync } from "node:child_process";

/**
 * my-scripts' own local git-invocation seam, for single git-CLI-operation
 * wrappers not yet carried over to the shared `git-ts` package. Mirrors
 * git-ts's own `gitClient.ts` seam convention: every exported function here
 * makes exactly one subprocess call, returns a structured/typed value (never
 * a raw string a caller has to parse itself), and is named after the git
 * operation it wraps.
 */

function runGit(cwd: string, args: string[]): string {
  // execFileSync's default stdio (when unset) inherits the child's stderr
  // straight to this process's own -- capturing all three streams explicitly
  // keeps git's own chatter off the terminal and lets a thrown error carry
  // git's message instead.
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/**
 * Wraps `git merge --ff-only <remoteRef>` (`git-merge(1)`): fast-forwards
 * `repoDir`'s current branch so it points at `remoteRef`. `--ff-only`
 * refuses the merge -- and this throws -- unless it can be resolved as a
 * pure fast-forward, i.e. the current branch's history is already fully
 * contained in `remoteRef`'s; per that flag's own documented behavior, a
 * refusal leaves the working tree and `HEAD` completely untouched.
 */
export function fastForward(repoDir: string, remoteRef: string): void {
  runGit(repoDir, ["merge", "--ff-only", remoteRef]);
}
