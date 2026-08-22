import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { classifyWorktree, gatherWorktreeFacts } from "./classify.js";
import * as git from "./git.js";
import { confirm } from "./prompt.js";

/**
 * Entry point for `cleanWorktreesTs`. Orchestrates git.ts/parseWorktrees.ts/
 * classify.ts/prompt.ts to reproduce the bash `cleanWorktrees` reference
 * implementation's exact dry-run/`--force` output shape, bucket labels, and
 * closing summary. See the shim script `cleanWorktreesTs` at the repo root
 * for how this module gets invoked from any directory.
 */

function usageError(message: string): never {
  console.error(message);
  process.exit(1);
}

function parseArgs(argv: string[]): { force: boolean } {
  let force = false;
  for (const arg of argv) {
    if (arg === "--force") {
      force = true;
    } else {
      usageError(`Unknown argument: ${arg}`);
    }
  }
  return { force };
}

/** Directory names directly under `reposDir` that are themselves git repos (have a `.git` directory). */
function listRepoNames(reposDir: string): string[] {
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

type Totals = { pruned: number; removed: number };

async function processRepo(repoDir: string, repoName: string, force: boolean, totals: Totals): Promise<void> {
  const worktrees = git.listWorktrees(repoDir);
  const linked = worktrees.slice(1); // index 0 is always the repo's main worktree
  const defaultBranch = git.defaultBranchRef(repoDir);

  let headerShown = false;
  const showHeader = () => {
    if (!headerShown) {
      console.log(`== ${repoName} ==`);
      headerShown = true;
    }
  };

  const classified = linked.map((wt) => ({
    wt,
    result: classifyWorktree(gatherWorktreeFacts(wt, defaultBranch)),
  }));

  // Pass 1: list (and count) prunable worktrees, then prune them all at once.
  const prunable = classified.filter((c) => c.result.bucket === "prune");
  for (const { wt, result } of prunable) {
    showHeader();
    console.log(`  [prune]   ${wt.path} -- ${result.reasons.join("; ")}`);
  }
  if (prunable.length > 0 && force) {
    execFileSync("git", ["-C", repoDir, "worktree", "prune", "-v"], { stdio: "inherit" });
    totals.pruned += prunable.length;
  }

  // Pass 2: classify every remaining linked worktree as locked/safe/confirm.
  for (const { wt, result } of classified) {
    if (result.bucket === "prune") {
      continue;
    }

    if (result.bucket === "locked") {
      showHeader();
      const reason = result.reasons.join("; ");
      console.log(
        reason !== ""
          ? `  [locked]  ${wt.path} (${wt.branch}) -- ${reason} -- never touched`
          : `  [locked]  ${wt.path} (${wt.branch}) -- never touched`,
      );
      continue;
    }

    if (result.bucket === "safe") {
      showHeader();
      console.log(`  [safe]    ${wt.path} (${wt.branch}) -- would remove`);
      if (force) {
        execFileSync("git", ["-C", repoDir, "worktree", "remove", wt.path], { stdio: "inherit" });
        console.log("  -> removed");
        totals.removed += 1;
      }
      continue;
    }

    // bucket === "confirm"
    showHeader();
    console.log(`  [confirm] ${wt.path} (${wt.branch}) -- ${result.reasons.join("; ")}`);
    if (force) {
      const accepted = await confirm("  Remove anyway? [y/N] ");
      if (accepted) {
        execFileSync("git", ["-C", repoDir, "worktree", "remove", "--force", wt.path], {
          stdio: "inherit",
        });
        console.log("  -> removed");
        totals.removed += 1;
      } else {
        console.log("  -> skipped");
      }
    }
  }

  if (headerShown) {
    console.log();
  }
}

async function main(): Promise<void> {
  const { force } = parseArgs(process.argv.slice(2));
  // Matches bash's ${REPOS_DIR:-...}: an unset *or* empty REPOS_DIR both fall
  // back to the default, so `??` alone (which only catches unset) isn't enough.
  const reposDir = process.env.REPOS_DIR || path.join(os.homedir(), "repos");

  if (!force) {
    console.log("Dry run -- no worktrees will be modified. Pass --force to actually clean up.");
    console.log();
  }

  const totals: Totals = { pruned: 0, removed: 0 };

  for (const repoName of listRepoNames(reposDir)) {
    await processRepo(path.join(reposDir, repoName), repoName, force, totals);
  }

  console.log(
    force
      ? `Done. Pruned ${totals.pruned} stale worktree(s), removed ${totals.removed} worktree(s).`
      : "Dry run complete. Re-run with --force to prune/remove/confirm the worktrees listed above.",
  );
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
