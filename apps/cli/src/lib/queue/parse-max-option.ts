/**
 * Validate a `--max-*` count flag from commander into a positive integer;
 * throws on garbage. Shared by the `--max-running` / `--max-working` queue
 * gates on the claude / codex / opencode commands.
 */
export function parseMaxOption(flag: string, raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${flag}: expected a positive integer, got "${raw}"`);
  }
  return n;
}
