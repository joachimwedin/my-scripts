import { spawn } from "node:child_process";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Thin end-to-end suite for `run`'s own dispatch behavior -- registry
 * lookup, `ls`, and usage-error handling for a missing/unrecognized
 * subcommand. Spawns the real `run` shim as a subprocess, same pattern as
 * the per-op suites (e.g. `test/cleanStashes/main.test.ts`), which cover
 * what each registered subcommand actually does; this suite only exercises
 * the routing logic itself.
 */

const CLI_PATH = path.resolve(__dirname, "..", "..", "run");

type RunResult = { stdout: string; exitCode: number };

function runCli(args: string[]): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(CLI_PATH, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stdout += d.toString()));
    child.on("error", reject);
    child.on("close", (exitCode) => resolve({ stdout, exitCode: exitCode ?? -1 }));
  });
}

describe("run", () => {
  it("`run ls` prints the registered subcommand names, one per line, in registration order", async () => {
    const { stdout, exitCode } = await runCli(["ls"]);

    expect(exitCode).toBe(0);
    expect(stdout.trim().split("\n")).toEqual(["clean-branches", "clean-stashes", "clean-worktrees", "sync-repos"]);
  });

  it("an unrecognized subcommand is a usage error and exits non-zero", async () => {
    const { stdout, exitCode } = await runCli(["bogus"]);

    expect(exitCode).toBe(1);
    expect(stdout).toContain("Unknown subcommand: bogus");
  });

  it("no subcommand at all is a usage error and exits non-zero", async () => {
    const { stdout, exitCode } = await runCli([]);

    expect(exitCode).toBe(1);
    expect(stdout).toContain("Usage: run <subcommand>");
  });
});
