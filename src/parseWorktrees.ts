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
