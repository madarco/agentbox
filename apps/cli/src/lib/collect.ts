/**
 * commander's repeatable-option reducer: `--box a --box b` → `['a','b']`.
 * Pair it with an empty-array default (`.option('--box <ref>', '…', collect, [])`).
 */
export function collect(value: string, acc: string[]): string[] {
  acc.push(value);
  return acc;
}
