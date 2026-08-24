import * as os from "node:os";
import * as path from "node:path";

import { usageError } from "../cli/args.js";
import * as gitOperations from "../git/gitOperations.js";
import { checkout, pull } from "git-ts/src/gitClient.js";
import { classifySync } from "./classify.js";

/**
 * Entry point for the `sync-repos` op, registered with the `run` dispatcher
 * (see `src/cli/dispatcher.ts`). Unlike the `clean-*` ops, this one has no
 * flags at all -- no dry-run/`--force` split, since there's nothing
 * destructive to gate: a `sync` repo's checkout+pull and a `no-remote`
 * repo's checkout-only are both safe to always perform, and `dirty`/
 * `no-default-branch` repos are always skipped. Any argument at all is
 * therefore a usage error.
 */

/** Subcommand name this op registers under `run` -- `run sync-repos`. */
export const name = "sync-repos";

type Totals = { synced: number; skippedDirty: number; skippedNoRemote: number; skippedUnresolved: number; failed: number };

function emptyTotals(): Totals {
  return { synced: 0, skippedDirty: 0, skippedNoRemote: 0, skippedUnresolved: 0, failed: 0 };
}

/** Processes one repo: gathers facts, classifies, acts, and prints its outcome line(s). */
function processRepo(repoDir: string, repoName: string, totals: Totals): void {
  const facts = gitOperations.gatherSyncFacts(repoDir);
  const result = classifySync(facts);

  console.log(`== ${repoName} ==`);

  if (result.outcome === "no-default-branch") {
    console.log(`  skipped -- ${result.reasons.join("; ")}`);
    totals.skippedUnresolved += 1;
    console.log();
    return;
  }

  if (result.outcome === "dirty") {
    console.log(`  skipped -- ${result.reasons.join("; ")}`);
    totals.skippedDirty += 1;
    console.log();
    return;
  }

  // `result.defaultBranch` only exists on the "no-remote"/"sync" branches of
  // `ClassifyResult` -- reaching here already proves it's a real `string`,
  // with no cast needed to recover it.
  const { defaultBranch } = result;

  if (result.outcome === "no-remote") {
    try {
      checkout(repoDir, defaultBranch);
      console.log(`  checked out ${defaultBranch} -- no origin remote configured, nothing to pull`);
      totals.skippedNoRemote += 1;
    } catch (err) {
      console.log(`  failed -- ${err instanceof Error ? err.message : String(err)}`);
      totals.failed += 1;
    }
    console.log();
    return;
  }

  // result.outcome === "sync"
  try {
    checkout(repoDir, defaultBranch);
    pull(repoDir);
    console.log(`  synced -- checked out ${defaultBranch} and pulled from origin`);
    totals.synced += 1;
  } catch (err) {
    console.log(`  failed -- ${err instanceof Error ? err.message : String(err)}`);
    totals.failed += 1;
  }
  console.log();
}

/**
 * Runs the op against `argv` (the args following `sync-repos` on the command
 * line -- the dispatcher forwards them unchanged, unparsed). Exits non-zero
 * if any repo failed outright; skips and no-remote checkouts don't count
 * against the exit code.
 */
export function main(argv: string[]): void {
  if (argv.length > 0) {
    usageError(`Unknown argument: ${argv[0]}`);
  }

  // Matches bash's ${REPOS_DIR:-...}: an unset *or* empty REPOS_DIR both fall
  // back to the default, so `??` alone (which only catches unset) isn't enough.
  const reposDir = process.env.REPOS_DIR || path.join(os.homedir(), "repos");

  const totals = emptyTotals();
  for (const repoName of gitOperations.listRepoNames(reposDir)) {
    processRepo(path.join(reposDir, repoName), repoName, totals);
  }

  console.log(
    `Done. ${totals.synced} synced, ${totals.skippedDirty} skipped-dirty, ${totals.skippedNoRemote} skipped-no-remote, ${totals.skippedUnresolved} skipped-unresolved, ${totals.failed} failed.`,
  );

  if (totals.failed > 0) {
    process.exit(1);
  }
}
