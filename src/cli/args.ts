export function usageError(message: string): never {
  console.error(message);
  process.exit(1);
}

export function parseArgs(argv: string[]): { force: boolean } {
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
