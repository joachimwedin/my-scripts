import * as os from "node:os";
import * as path from "node:path";

import { parseArgs } from "../cli/args.js";
import { confirm } from "../cli/confirm.js";
import { deleteBranch, listBranches } from "../git/gitClient.js";
import { DETACHED_HEAD, listWorktrees } from "git-ts/src/gitClient.js";
import * as gitOperations from "../git/gitOperations.js";
import { classifyBranch } from "./classify.js";

/**
 * Entry point for the `clean-branches` op, registered with the `run`
 * dispatcher (see `src/cli/dispatcher.ts`). Orchestrates gitClient.ts/
 * gitOperations.ts/classify.ts/confirm.ts to produce the exact dry-run/
 * `--force` output shape, bucket labels, and closing summary -- mirroring
 * `cleanWorktree/main.ts`'s structure, minus the prune/locked buckets that
 * don't apply to branches.
 */

/** Subcommand name this op registers under `run` -- `run clean-branches`. */
export const name = "clean-branches";

type Totals = { deleted: number };

/** Reason printed when a repo's default branch can't be resolved at all. */
const UNRESOLVED_DEFAULT_BRANCH_REASON =
  "couldn't resolve a default branch (checked origin/HEAD, local main, local master)";

async function processRepo(repoDir: string, repoName: string, force: boolean, totals: Totals): Promise<void> {
  const resolvedDefaultBranch = gitOperations.resolveDefaultBranch(repoDir);
  if (resolvedDefaultBranch === null) {
    console.log(`== ${repoName} ==`);
    console.log(`  skipped -- ${UNRESOLVED_DEFAULT_BRANCH_REASON}`);
    console.log();
    return;
  }
  const { localName: defaultBranchLocalName, mergeTarget: defaultBranch } = resolvedDefaultBranch;

  // Built once per repo, not recomputed per branch -- mirrors defaultBranch above.
  const checkedOutBranches = new Map<string, string>();
  for (const wt of listWorktrees(repoDir)) {
    if (wt.branch !== DETACHED_HEAD) {
      checkedOutBranches.set(wt.branch, wt.path);
    }
  }

  const branches = listBranches(repoDir).filter((branch) => branch !== defaultBranchLocalName);

  let headerShown = false;
  const showHeader = () => {
    if (!headerShown) {
      console.log(`== ${repoName} ==`);
      headerShown = true;
    }
  };

  const deleteAndReport = (branch: string, opts?: { force?: boolean }) => {
    try {
      deleteBranch(repoDir, branch, opts);
      console.log("  -> deleted");
      totals.deleted += 1;
    } catch (err) {
      console.log(`  -> failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  for (const branch of branches) {
    const facts = gitOperations.gatherBranchFacts(repoDir, branch, defaultBranch, checkedOutBranches);
    const result = classifyBranch(facts);

    if (result.bucket === "current") {
      showHeader();
      console.log(`  [current] ${branch} -- ${result.reasons.join("; ")}`);
      continue;
    }

    if (result.bucket === "safe") {
      showHeader();
      console.log(`  [safe]    ${branch} -- would delete`);
      if (force) {
        deleteAndReport(branch);
      }
      continue;
    }

    // bucket === "confirm"
    showHeader();
    console.log(`  [confirm] ${branch} -- ${result.reasons.join("; ")}`);
    if (force) {
      const accepted = await confirm("  Delete anyway? [y/N] ");
      if (accepted) {
        deleteAndReport(branch, { force: true });
      } else {
        console.log("  -> skipped");
      }
    }
  }

  if (headerShown) {
    console.log();
  }
}

/**
 * Runs the op against `argv` (the args following `clean-branches` on the
 * command line -- the dispatcher forwards them unchanged, unparsed).
 */
export async function main(argv: string[]): Promise<void> {
  const { force } = parseArgs(argv);
  // Matches bash's ${REPOS_DIR:-...}: an unset *or* empty REPOS_DIR both fall
  // back to the default, so `??` alone (which only catches unset) isn't enough.
  const reposDir = process.env.REPOS_DIR || path.join(os.homedir(), "repos");

  if (!force) {
    console.log("Dry run -- no branches will be deleted. Pass --force to actually clean up.");
    console.log();
  }

  const totals: Totals = { deleted: 0 };

  for (const repoName of gitOperations.listRepoNames(reposDir)) {
    await processRepo(path.join(reposDir, repoName), repoName, force, totals);
  }

  console.log(
    force
      ? `Done. Deleted ${totals.deleted} branch(es).`
      : "Dry run complete. Re-run with --force to delete/confirm the branches listed above.",
  );
}
