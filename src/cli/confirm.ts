import * as readline from "node:readline/promises";

/**
 * True when `answer` means "yes": "y" or "yes", case-insensitively. Pure
 * function -- no I/O, safe to unit test directly against string inputs.
 */
export function isYes(answer: string): boolean {
  const normalized = answer.toLowerCase();
  return normalized === "y" || normalized === "yes";
}

/**
 * Asks a question naming the specific item it's about -- built internally as
 * `` `  ${message} ${name} [y/N] ` `` (the two-space indent, the space before
 * `name`, and the trailing `[y/N]` suffix are identical across every call
 * site; only `message`, the leading verb phrase, varies per call site) -- on
 * a real terminal, and resolves to whether the answer means "yes", per
 * `isYes`. Thin I/O wrapper -- not unit tested here, since it requires a real
 * tty to exercise; the end-to-end integration suites for `clean-branches`,
 * `clean-worktree`, and `ensure-pristine` cover it via a real subprocess.
 *
 * If no real tty is attached to stdin (`process.stdin.isTTY` is falsy -- e.g.
 * stdin is piped, redirected, or otherwise non-interactive), resolves to
 * `false` immediately without prompting or attempting to read: a read that
 * can't happen is always treated as "no", exactly like a failed read, never
 * as an implicit "yes", and this never hangs waiting on input that can't
 * arrive.
 */
export async function confirm(message: string, name: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    return false;
  }

  const question = `  ${message} ${name} [y/N] `;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(question);
    return isYes(answer);
  } finally {
    rl.close();
  }
}
