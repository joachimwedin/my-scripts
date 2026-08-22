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
 * Asks `question` on a real terminal and resolves to whether the answer means
 * "yes", per `isYes`. Thin I/O wrapper -- not unit tested here, since it
 * requires a real tty to exercise; the end-to-end integration suite (ticket
 * #6) covers it via a real subprocess.
 *
 * If no real tty is attached to stdin (`process.stdin.isTTY` is falsy -- e.g.
 * stdin is piped, redirected, or otherwise non-interactive), resolves to
 * `false` immediately without prompting or attempting to read: a read that
 * can't happen is always treated as "no", exactly like a failed read, never
 * as an implicit "yes", and this never hangs waiting on input that can't
 * arrive.
 */
export async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    return false;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(question);
    return isYes(answer);
  } finally {
    rl.close();
  }
}
