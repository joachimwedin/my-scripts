import { execFileSync } from "node:child_process";

/**
 * The sole seam for real git invocation. Every exported function here makes
 * exactly one subprocess call, returns a structured/typed value (never a raw
 * string a caller has to parse itself), and is named after the git operation
 * it wraps. Functions that compose more than one of these calls into a
 * decision-ready fact live in `gitOperations.ts` instead.
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
 * Runs `runGit`, treating any failure as an expected, non-exceptional
 * outcome: returns the trimmed stdout on success, or `null` on any thrown
 * error instead of propagating it. The shared landing point for every
 * "probe" below whose failure is a normal result to report, not a bug to
 * surface — composes on top of `runGit`'s existing stdio-capture behavior
 * rather than inventing a second one, so none of these probes can leak a
 * git subprocess's stderr to the terminal.
 */
function tryRunGit(cwd: string, args: string[]): string | null {
  try {
    return runGit(cwd, args).trim();
  } catch {
    return null;
  }
}

export const DETACHED_HEAD = "(detached)";

export type Worktree = {
  path: string;
  /** Branch name, or DETACHED_HEAD when the worktree has no branch. */
  branch: string;
  locked: boolean;
  /** "" when locked is true but no reason was given, or when not locked. */
  lockReason: string;
  prunable: boolean;
  /** "" when prunable is true but no reason was given, or when not prunable. */
  prunableReason: string;
};

/**
 * Parses the text output of `git worktree list --porcelain` into structured
 * worktree records. Pure function: no git commands are invoked here. The
 * first record returned is always the repo's main worktree, matching the
 * order `git worktree list --porcelain` itself emits.
 */
export function parseWorktrees(porcelainText: string): Worktree[] {
  const records: Worktree[] = [];
  let current: Worktree | null = null;

  const flush = () => {
    if (current !== null) {
      records.push(current);
      current = null;
    }
  };

  for (const line of porcelainText.split("\n")) {
    if (line === "") {
      flush();
      continue;
    }

    if (line.startsWith("worktree ")) {
      flush();
      current = {
        path: line.slice("worktree ".length),
        branch: DETACHED_HEAD,
        locked: false,
        lockReason: "",
        prunable: false,
        prunableReason: "",
      };
      continue;
    }

    if (current === null) {
      continue;
    }

    if (line.startsWith("branch ")) {
      current.branch = line.slice("branch refs/heads/".length);
    } else if (line === "locked") {
      current.locked = true;
      current.lockReason = "";
    } else if (line.startsWith("locked ")) {
      current.locked = true;
      current.lockReason = line.slice("locked ".length);
    } else if (line === "prunable") {
      current.prunable = true;
      current.prunableReason = "";
    } else if (line.startsWith("prunable ")) {
      current.prunable = true;
      current.prunableReason = line.slice("prunable ".length);
    }
  }

  flush();
  return records;
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

/**
 * Removes the worktree at `worktreePath` from the repo at `repoDir`. Captures
 * git's own output rather than streaming it live; the caller already prints
 * its own `[safe]`/`[confirm]` bucket lines and its own `-> removed` line, so
 * git's text would just be redundant chatter. Never deletes the underlying
 * branch -- only `opts.force` is passed through to git, which (per
 * `git worktree remove`'s own semantics) only ever affects the worktree
 * itself, not its branch.
 */
export function removeWorktree(repoDir: string, worktreePath: string, opts?: { force?: boolean }): void {
  const args = ["worktree", "remove"];
  if (opts?.force) {
    args.push("--force");
  }
  args.push(worktreePath);
  runGit(repoDir, args);
}

/** True when the worktree at `worktreePath` has uncommitted/untracked changes. */
export function isWorkingTreeDirty(worktreePath: string): boolean {
  return runGit(worktreePath, ["status", "--porcelain"]).trim() !== "";
}

/** The short name `ref` resolves to via a symbolic ref, or null if it doesn't resolve. */
export function symbolicRef(repoPath: string, ref: string): string | null {
  const resolved = tryRunGit(repoPath, ["symbolic-ref", "-q", "--short", ref]);
  return resolved === "" ? null : resolved;
}

/** True when `ref` resolves to a valid object. */
export function showRef(repoPath: string, ref: string): boolean {
  return tryRunGit(repoPath, ["show-ref", "-q", "--verify", ref]) !== null;
}

/**
 * True when `subject` is an ancestor of `target` in `repoPath`. Pass `"HEAD"`
 * as `subject` to check a worktree's own checked-out branch; pass a plain
 * branch name to check a branch with no worktree of its own.
 */
export function mergeBase(repoPath: string, subject: string, target: string): boolean {
  return tryRunGit(repoPath, ["merge-base", "--is-ancestor", subject, target]) !== null;
}

/** The worktree's configured upstream (e.g. "origin/feature"), or null if none. */
export function getUpstream(worktreePath: string): string | null {
  return tryRunGit(worktreePath, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
}

/**
 * Every stash entry in `repoPath`, newest first, matching `git stash list`'s
 * own order. Empty array when the repo has no stashes.
 */
export function listStash(repoPath: string): string[] {
  const out = runGit(repoPath, ["stash", "list"]);
  return out === "" ? [] : out.trimEnd().split("\n");
}

/** Clears every stash entry in `repoPath`. Does not error when there are zero stashes. */
export function clearStash(repoPath: string): void {
  runGit(repoPath, ["stash", "clear"]);
}

/** How many commits `worktreePath`'s HEAD is ahead of `upstream`. */
export function aheadCount(worktreePath: string, upstream: string): number {
  const out = runGit(worktreePath, ["rev-list", "--count", `${upstream}..HEAD`]).trim();
  return Number.parseInt(out, 10);
}
