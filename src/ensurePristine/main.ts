import * as os from "node:os";
import * as path from "node:path";

import { parseArgs } from "../cli/args.js";
import { confirm } from "../cli/confirm.js";
import { classifyBranch } from "../cleanBranches/classify.js";
import { fastForward } from "../git/gitClient.js";
import * as gitOperations from "../git/gitOperations.js";
import {
  checkout,
  DETACHED_HEAD,
  deleteBranch,
  listBranches,
  listWorktrees,
  pruneWorktrees,
  removeWorktree,
} from "git-ts/src/gitClient.js";
import {
  classifyPristine,
  type ClassifyResult,
  type ExtraBranchDetail,
  type ExtraWorktreeDetail,
  type PristineFacts,
} from "./classify.js";

/**
 * Entry point for the `ensure-pristine` op, registered with the `run`
 * dispatcher (see `src/cli/dispatcher.ts`). Unlike the `clean-*` ops (each
 * fixing one narrow thing), this one composes `gatherPristineFacts` +
 * `classifyPristine` with the existing branch/worktree fixing primitives
 * `clean-branches`/`clean-worktree` already use, in git-constraint order
 * (worktrees before branches, since a worktree removal can free a branch up
 * for deletion), then re-gathers and re-classifies so the printed verdict
 * always reflects the post-fix state.
 */

/** Subcommand name this op registers under `run` -- `run ensure-pristine`. */
export const name = "ensure-pristine";

type Totals = { pristine: number; notPristine: number; failed: number };

/**
 * Diagnostic line for how the default branch compares to `origin`, matching
 * the other ops' `[bucket] <item> -- <reason>` style. Null when there's
 * nothing to report: no `origin` remote, or already up-to-date.
 */
function originSyncLine(facts: PristineFacts): string | null {
  if (!facts.hasOriginRemote || facts.originComparison === null || facts.originComparison === "up-to-date") {
    return null;
  }

  const label =
    facts.originComparison === "fast-forwardable"
      ? "behind origin"
      : facts.originComparison === "ahead"
        ? "ahead of origin"
        : "diverged from origin";

  return `  [sync]    ${facts.defaultBranch} -- ${label}`;
}

function printWorktreeBucket(wt: ExtraWorktreeDetail): void {
  const reasons = wt.reasons.join("; ");

  if (wt.bucket === "prune") {
    console.log(`  [prune]   ${wt.path} -- ${reasons}`);
    return;
  }

  if (wt.bucket === "locked") {
    console.log(
      reasons !== "" ? `  [locked]  ${wt.path} -- ${reasons} -- never touched` : `  [locked]  ${wt.path} -- never touched`,
    );
    return;
  }

  if (wt.bucket === "safe") {
    console.log(`  [safe]    ${wt.path} -- would remove`);
    return;
  }

  // bucket === "confirm"
  console.log(`  [confirm] ${wt.path} -- ${reasons}`);
}

function printBranchBucket(b: ExtraBranchDetail): void {
  if (b.bucket === "current") {
    console.log(`  [current] ${b.name} -- ${b.reasons.join("; ")}`);
    return;
  }

  if (b.bucket === "safe") {
    console.log(`  [safe]    ${b.name} -- would delete`);
    return;
  }

  // bucket === "confirm"
  console.log(`  [confirm] ${b.name} -- ${b.reasons.join("; ")}`);
}

/**
 * Prints the pre-fix picture for one repo: the `[bucket] <item> -- <reason>`
 * lines for its out-of-sync default branch, extra branches, and extra
 * worktrees. Prints nothing when the default branch couldn't be resolved or
 * is dirty -- those short-circuit `classifyPristine` entirely, and the
 * closing verdict line alone already says why.
 */
function printPicture(facts: PristineFacts, result: ClassifyResult): void {
  if (facts.defaultBranch === null || facts.dirty) {
    return;
  }

  const syncLine = originSyncLine(facts);
  if (syncLine !== null) {
    console.log(syncLine);
  }

  if (result.verdict === "NOT PRISTINE") {
    for (const wt of result.extraWorktrees) {
      printWorktreeBucket(wt);
    }
    for (const b of result.extraBranches) {
      printBranchBucket(b);
    }
  }
}

/**
 * Applies whatever fixes are safe under `--force`, in git-constraint order:
 * fast-forward the default branch first, then worktrees, then branches
 * (recomputing checked-out status after worktrees are resolved, since a
 * worktree removed in that step may have freed a branch up for deletion). A
 * dirty or unresolved default branch leaves the whole repo untouched --
 * mirroring `classifyPristine`'s own short-circuit, since `result` carries
 * no branch/worktree detail to act on in that case anyway.
 */
async function applyFixes(repoDir: string, facts: PristineFacts, result: ClassifyResult): Promise<void> {
  if (result.verdict === "PRISTINE" || facts.defaultBranch === null || facts.dirty) {
    return;
  }

  // PristineFacts only carries the default branch's local name, not the
  // resolved remote-tracking ref `fastForward`/`gatherBranchFacts` need --
  // re-resolved here exactly as clean-branches/clean-worktree already do.
  const resolved = gitOperations.resolveDefaultBranch(repoDir);
  if (resolved === null) {
    return;
  }

  // Step 1: fast-forward the default branch when it's safely behind.
  if (facts.hasOriginRemote && facts.originComparison === "fast-forwardable") {
    try {
      checkout(repoDir, resolved.localName);
      fastForward(repoDir, resolved.mergeTarget);
      console.log("  -> fast-forwarded");
    } catch (err) {
      console.log(`  -> failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Step 2: resolve worktrees before branches.
  const prunable = result.extraWorktrees.filter((wt) => wt.bucket === "prune");
  if (prunable.length > 0) {
    try {
      pruneWorktrees(repoDir);
    } catch (err) {
      console.log(`  -> failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  for (const wt of result.extraWorktrees) {
    if (wt.bucket === "prune" || wt.bucket === "locked") {
      continue;
    }

    if (wt.bucket === "safe") {
      try {
        removeWorktree(repoDir, wt.path);
        console.log("  -> removed");
      } catch (err) {
        console.log(`  -> failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      continue;
    }

    // bucket === "confirm"
    printWorktreeBucket(wt);
    const accepted = await confirm("Remove anyway?", wt.path);
    if (accepted) {
      try {
        removeWorktree(repoDir, wt.path, { force: true });
        console.log("  -> removed");
      } catch (err) {
        console.log(`  -> failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    } else {
      console.log("  -> skipped");
    }
  }

  // Step 3: resolve branches, recomputing checked-out status first -- a
  // worktree removed in step 2 may have freed one of these up for deletion.
  const checkedOutBranches = new Map<string, string>();
  for (const wt of listWorktrees(repoDir)) {
    if (wt.branch !== DETACHED_HEAD) {
      checkedOutBranches.set(wt.branch, wt.path);
    }
  }

  const branches = listBranches(repoDir).filter((branch) => branch !== resolved.localName);
  for (const branch of branches) {
    const branchFacts = gitOperations.gatherBranchFacts(repoDir, branch, resolved.mergeTarget, checkedOutBranches);
    const classified = classifyBranch(branchFacts);

    if (classified.bucket === "current") {
      continue;
    }

    if (classified.bucket === "safe") {
      try {
        deleteBranch(repoDir, branch);
        console.log("  -> deleted");
      } catch (err) {
        console.log(`  -> failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      continue;
    }

    // bucket === "confirm"
    printBranchBucket({ name: branch, bucket: classified.bucket, reasons: classified.reasons });
    const accepted = await confirm("Delete anyway?", branch);
    if (accepted) {
      try {
        deleteBranch(repoDir, branch, { force: true });
        console.log("  -> deleted");
      } catch (err) {
        console.log(`  -> failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    } else {
      console.log("  -> skipped");
    }
  }
}

/**
 * Processes one repo: gathers facts, classifies, prints the pre-fix picture,
 * applies fixes under `--force`, then re-gathers and re-classifies so the
 * printed verdict reflects the post-fix state. Any unexpected error anywhere
 * in that pipeline is caught here, reported as a failure for this repo only,
 * and never aborts the run.
 */
async function processRepo(repoDir: string, repoName: string, force: boolean, totals: Totals): Promise<void> {
  console.log(`== ${repoName} ==`);

  try {
    const facts = gitOperations.gatherPristineFacts(repoDir);
    const result = classifyPristine(facts);
    printPicture(facts, result);

    if (force) {
      await applyFixes(repoDir, facts, result);
    }

    const finalResult =
      force && result.verdict === "NOT PRISTINE" ? classifyPristine(gitOperations.gatherPristineFacts(repoDir)) : result;

    if (finalResult.verdict === "PRISTINE") {
      console.log("  PRISTINE");
      totals.pristine += 1;
    } else {
      console.log(`  NOT PRISTINE -- ${finalResult.reasons.join(", ")}`);
      totals.notPristine += 1;
    }
  } catch (err) {
    console.log(`  FAILED -- ${err instanceof Error ? err.message : String(err)}`);
    totals.failed += 1;
  }

  console.log();
}

/**
 * Runs the op against `argv` (the args following `ensure-pristine` on the
 * command line -- the dispatcher forwards them unchanged, unparsed). Exits
 * non-zero only when a repo failed outright; a repo merely being NOT
 * PRISTINE never affects the exit code.
 */
export async function main(argv: string[]): Promise<void> {
  const { force } = parseArgs(argv);
  // Matches bash's ${REPOS_DIR:-...}: an unset *or* empty REPOS_DIR both fall
  // back to the default, so `??` alone (which only catches unset) isn't enough.
  const reposDir = process.env.REPOS_DIR || path.join(os.homedir(), "repos");

  if (!force) {
    console.log("Dry run -- nothing will be changed. Pass --force to fix what can be fixed safely.");
    console.log();
  }

  const totals: Totals = { pristine: 0, notPristine: 0, failed: 0 };

  for (const repoName of gitOperations.listRepoNames(reposDir)) {
    await processRepo(path.join(reposDir, repoName), repoName, force, totals);
  }

  console.log(`Done. ${totals.pristine} pristine, ${totals.notPristine} not-pristine, ${totals.failed} failed.`);

  if (totals.failed > 0) {
    process.exit(1);
  }
}
