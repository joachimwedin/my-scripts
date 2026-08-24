import * as fs from "node:fs";
import * as path from "node:path";

import type { BranchFacts } from "../cleanBranches/classify.js";
import type { WorktreeFacts } from "../cleanWorktree/classify.js";
import type { PristineFacts } from "../ensurePristine/classify.js";
import type { SyncFacts } from "../syncRepos/classify.js";
import {
  aheadCount,
  DETACHED_HEAD,
  getOriginRemoteUrl,
  getUpstream,
  isWorkingTreeDirty,
  listBranches,
  listWorktrees,
  mergeBase,
  showRef,
  symbolicRef,
} from "git-ts/src/gitClient.js";
import type { Worktree } from "git-ts/src/gitClient.js";

/**
 * Ready-to-use, decision-ready facts for callers -- most composed from
 * multiple `gitClient` calls, but not exclusively; `listRepoNames` below
 * answers its question via `fs` directly. No decision logic of its own lives
 * here -- that's `classify.ts`'s job; this module only answers questions
 * that take more than one raw fact (or a different mechanism than a single
 * git subprocess call) to answer.
 */

/**
 * The repo's resolved default branch, split into the two things callers need
 * that only coincide when there's no remote-tracking ref to prefer:
 * `localName` is always a plain local branch name -- directly comparable
 * against `listBranches`' output, so callers can exclude the
 * default branch from candidates by identity. `mergeTarget` is whichever ref
 * is authoritative for "merged" ancestry checks and reason-text display: the
 * remote-tracking ref (e.g. `"origin/main"`) when `origin/HEAD` resolves,
 * otherwise identical to `localName`. Resolution order: `origin/HEAD` first,
 * then local `main`, then local `master`. Returns null if none of those
 * resolve -- callers then treat merged status as unconfirmed rather than
 * guessing (both fields are only ever meaningful together -- never partially
 * resolved).
 */
export function resolveDefaultBranch(repoPath: string): { localName: string; mergeTarget: string } | null {
  const originHead = symbolicRef(repoPath, "refs/remotes/origin/HEAD");
  if (originHead !== null) {
    // The remote this codebase ever inspects is always hardcoded as `origin`,
    // so the local name is recovered by stripping that literal prefix off the
    // resolved short ref -- no new git call needed.
    return { localName: originHead.replace(/^origin\//, ""), mergeTarget: originHead };
  }

  for (const candidate of ["main", "master"]) {
    if (showRef(repoPath, `refs/heads/${candidate}`)) {
      return { localName: candidate, mergeTarget: candidate };
    }
  }

  return null;
}

/**
 * Composes the raw facts above into the shape `classifyWorktree` needs for a
 * real worktree. `defaultBranch` is computed once per repo (via
 * `resolveDefaultBranch`) and passed in, since it doesn't vary per worktree
 * within the same repo.
 */
export function gatherWorktreeFacts(worktree: Worktree, defaultBranch: string | null): WorktreeFacts {
  if (worktree.prunable) {
    // The worktree's directory is already gone -- no git commands can be
    // run against it, and none of the other facts matter for this bucket.
    return {
      locked: worktree.locked,
      lockReason: worktree.lockReason,
      prunable: true,
      prunableReason: worktree.prunableReason,
      dirty: false,
      merged: false,
      upstream: null,
      aheadCount: null,
      defaultBranch,
    };
  }

  if (worktree.locked) {
    // Locked worktrees are never touched or prompted about -- no need to
    // gather the rest of the facts.
    return {
      locked: true,
      lockReason: worktree.lockReason,
      prunable: false,
      prunableReason: "",
      dirty: false,
      merged: false,
      upstream: null,
      aheadCount: null,
      defaultBranch,
    };
  }

  const dirty = isWorkingTreeDirty(worktree.path);
  const merged = defaultBranch === null ? false : mergeBase(worktree.path, "HEAD", defaultBranch);
  const upstream = merged ? null : getUpstream(worktree.path);
  const aheadCountResult = upstream === null ? null : aheadCount(worktree.path, upstream);

  return {
    locked: false,
    lockReason: "",
    prunable: false,
    prunableReason: "",
    dirty,
    merged,
    upstream,
    aheadCount: aheadCountResult,
    defaultBranch,
  };
}

/**
 * Composes the raw facts above into the shape `classifyBranch` needs for a
 * real branch. `checkedOutBranches` is a `branch name -> worktree path` map
 * built once per repo (from `listWorktrees`), not recomputed per branch --
 * mirrors `gatherWorktreeFacts`'s `defaultBranch`-computed-once convention.
 * Checked-out status short-circuits: once a branch is known to be checked
 * out, `mergeBase` isn't called at all, matching the existing locked/
 * prunable short-circuit precedent for worktrees.
 */
export function gatherBranchFacts(
  repoDir: string,
  branch: string,
  defaultBranch: string,
  checkedOutBranches: Map<string, string>,
): BranchFacts {
  const checkedOutAt = checkedOutBranches.get(branch) ?? null;
  if (checkedOutAt !== null) {
    return { checkedOutAt, merged: false, defaultBranch };
  }

  return { checkedOutAt: null, merged: mergeBase(repoDir, branch, defaultBranch), defaultBranch };
}

/**
 * Composes the raw facts above into the shape `classifySync` needs for a
 * real repo. Unresolved default branch short-circuits: once
 * `resolveDefaultBranch` fails to resolve anything, neither dirty status nor
 * remote presence is computed, mirroring the existing locked/prunable and
 * checked-out short-circuit precedent already used for worktrees/branches.
 */
export function gatherSyncFacts(repoDir: string): SyncFacts {
  const resolved = resolveDefaultBranch(repoDir);
  if (resolved === null) {
    return { defaultBranch: null, dirty: false, hasOriginRemote: false };
  }

  return {
    defaultBranch: resolved.localName,
    dirty: isWorkingTreeDirty(repoDir),
    hasOriginRemote: getOriginRemoteUrl(repoDir) !== null,
  };
}

/**
 * How a local branch compares to a remote ref -- the outcome shape
 * `compareToRemote` returns and `PristineFacts.originComparison`
 * (`ensurePristine/classify.ts`) reuses directly, so the two never drift.
 */
export type OriginComparison = "up-to-date" | "fast-forwardable" | "ahead" | "diverged";

/**
 * Classifies the relationship between `localBranch` and `remoteRef` (e.g.
 * `"origin/main"`) in `repoDir`, from two `mergeBase` ancestry checks -- one
 * each direction: whether `localBranch` is an ancestor of `remoteRef`, and
 * whether `remoteRef` is an ancestor of `localBranch`. Combines the two
 * booleans into a single outcome:
 * - both true (same commit) -- `"up-to-date"`.
 * - only `localBranch` is an ancestor -- the local branch is behind and
 *   nothing local is missing from the remote -- `"fast-forwardable"`.
 * - only `remoteRef` is an ancestor -- the local branch has commits the
 *   remote lacks and nothing remote is missing locally -- `"ahead"`.
 * - neither is an ancestor of the other -- `"diverged"`.
 */
export function compareToRemote(repoDir: string, localBranch: string, remoteRef: string): OriginComparison {
  const localIsAncestorOfRemote = mergeBase(repoDir, localBranch, remoteRef);
  const remoteIsAncestorOfLocal = mergeBase(repoDir, remoteRef, localBranch);

  if (localIsAncestorOfRemote && remoteIsAncestorOfLocal) {
    return "up-to-date";
  }
  if (localIsAncestorOfRemote) {
    return "fast-forwardable";
  }
  if (remoteIsAncestorOfLocal) {
    return "ahead";
  }
  return "diverged";
}

/**
 * Composes every fact above into the single combined picture
 * `classifyPristine` needs for a real repo: whether the default branch
 * resolved and is clean, whether an `origin` remote exists and how the
 * default branch compares to it (only when both are true), and every extra
 * local branch/worktree beyond the default branch/main worktree, each with
 * its own already-gathered `BranchFacts`/`WorktreeFacts` (reusing
 * `gatherBranchFacts`/`gatherWorktreeFacts` exactly as `clean-branches`/
 * `clean-worktree` do). Unresolved default branch short-circuits everything
 * else, mirroring `gatherSyncFacts`'s existing precedent -- no branches,
 * worktrees, or origin comparison are gathered in that case either.
 */
export function gatherPristineFacts(repoDir: string): PristineFacts {
  const resolved = resolveDefaultBranch(repoDir);
  if (resolved === null) {
    return {
      defaultBranch: null,
      dirty: false,
      hasOriginRemote: false,
      originComparison: null,
      extraBranches: [],
      extraWorktrees: [],
    };
  }

  const dirty = isWorkingTreeDirty(repoDir);
  const hasOriginRemote = getOriginRemoteUrl(repoDir) !== null;
  const originComparison = hasOriginRemote
    ? compareToRemote(repoDir, resolved.localName, resolved.mergeTarget)
    : null;

  const worktrees = listWorktrees(repoDir);
  // Index 0 is always the repo's main worktree, matching clean-worktree's own convention.
  const extraWorktreeEntries = worktrees.slice(1);

  // Built once per repo, not recomputed per branch -- mirrors gatherBranchFacts's own convention.
  const checkedOutBranches = new Map<string, string>();
  for (const worktree of worktrees) {
    if (worktree.branch !== DETACHED_HEAD) {
      checkedOutBranches.set(worktree.branch, worktree.path);
    }
  }

  const extraBranches = listBranches(repoDir)
    .filter((branch) => branch !== resolved.localName)
    .map((name) => ({
      name,
      facts: gatherBranchFacts(repoDir, name, resolved.mergeTarget, checkedOutBranches),
    }));

  const extraWorktrees = extraWorktreeEntries.map((worktree) => ({
    path: worktree.path,
    facts: gatherWorktreeFacts(worktree, resolved.mergeTarget),
  }));

  return {
    defaultBranch: resolved.localName,
    dirty,
    hasOriginRemote,
    originComparison,
    extraBranches,
    extraWorktrees,
  };
}

/** Directory names directly under `reposDir` that are themselves git repos (have a `.git` directory). */
export function listRepoNames(reposDir: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(reposDir, { withFileTypes: true });
  } catch {
    return [];
  }

  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => {
      try {
        return fs.statSync(path.join(reposDir, name, ".git")).isDirectory();
      } catch {
        return false;
      }
    })
    .sort((a, b) => a.localeCompare(b));
}
