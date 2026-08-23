import { main as cleanBranchesMain, name as cleanBranchesName } from "../cleanBranches/main.js";
import { main as cleanStashesMain, name as cleanStashesName } from "../cleanStashes/main.js";
import { main as cleanWorktreesMain, name as cleanWorktreesName } from "../cleanWorktree/main.js";
import { usageError } from "./args.js";

/**
 * Entry point for `run` (see the shim script at the repo root). Dispatches
 * to each registered TS op by kebab-case subcommand name -- `run
 * <subcommand> [args...]` -- and owns the error-exit boilerplate
 * (`main().catch(...)` / `try { main() } catch`) that used to be duplicated
 * at the bottom of each op's own entry module. No CLI framework: just a
 * small hand-rolled registry.
 *
 * Adding a future op means touching only that op's own module (to export
 * `name`/`main`) plus one line in `registry` below -- nothing else in this
 * file changes.
 */

type Op = {
  name: string;
  main: (argv: string[]) => void | Promise<void>;
};

const registry: Op[] = [
  { name: cleanBranchesName, main: cleanBranchesMain },
  { name: cleanStashesName, main: cleanStashesMain },
  { name: cleanWorktreesName, main: cleanWorktreesMain },
];

async function dispatch(argv: string[]): Promise<void> {
  const [subcommand, ...rest] = argv;

  if (subcommand === undefined) {
    usageError("Usage: run <subcommand> [args...]\nRun `run ls` to list available subcommands.");
  }

  if (subcommand === "ls") {
    for (const op of registry) {
      console.log(op.name);
    }
    return;
  }

  const op = registry.find((candidate) => candidate.name === subcommand);
  if (op === undefined) {
    usageError(`Unknown subcommand: ${subcommand}\nRun \`run ls\` to list available subcommands.`);
  }

  await op.main(rest);
}

dispatch(process.argv.slice(2)).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
