import * as os from "node:os";
import * as path from "node:path";

import { parseArgs } from "../cli/args.js";
import * as gitClient from "../git/gitClient.js";
import * as gitOperations from "../git/gitOperations.js";

/**
 * Entry point for the `clean-stashes` op, registered with the `run`
 * dispatcher (see `src/cli/dispatcher.ts`). A straight 1:1 port of the bash
 * `clearStashes` script's logic -- list, then clear-or-don't, per repo. No
 * bucket/classification layer: unlike `clean-worktrees`, stash-clearing is
 * binary.
 */

/** Subcommand name this op registers under `run` -- `run clean-stashes`. */
export const name = "clean-stashes";

/** Lists (and, under `force`, clears) one repo's stashes. Returns the count cleared. */
function processRepo(repoDir: string, repoName: string, force: boolean): number {
  const stashes = gitClient.listStash(repoDir);
  if (stashes.length === 0) {
    return 0;
  }

  console.log(`== ${repoName} (${stashes.length} stash(es)) ==`);
  console.log(stashes.join("\n"));

  let cleared = 0;
  if (force) {
    gitClient.clearStash(repoDir);
    console.log("-> cleared");
    cleared = stashes.length;
  }

  console.log();
  return cleared;
}

/**
 * Runs the op against `argv` (the args following `clean-stashes` on the
 * command line -- the dispatcher forwards them unchanged, unparsed).
 */
export function main(argv: string[]): void {
  const { force } = parseArgs(argv);
  // Matches bash's ${REPOS_DIR:-...}: an unset *or* empty REPOS_DIR both fall
  // back to the default, so `??` alone (which only catches unset) isn't enough.
  const reposDir = process.env.REPOS_DIR || path.join(os.homedir(), "repos");

  if (!force) {
    console.log("Dry run — no stashes will be modified. Pass --force to actually clear them.");
    console.log();
  }

  let totalCleared = 0;
  for (const repoName of gitOperations.listRepoNames(reposDir)) {
    totalCleared += processRepo(path.join(reposDir, repoName), repoName, force);
  }

  console.log(
    force
      ? `Done. Cleared ${totalCleared} stash(es) total.`
      : "Dry run complete. Re-run with --force to clear the stashes listed above.",
  );
}
