import { describe, expect, it } from 'vitest';

// `normalizeAgents` is module-private in hub-backend; mirror it here and pin the
// contract the dedupe relies on. If this drifts, the dedupe silently hands a
// `--agents codex` request the jobId of an in-flight claude bake.
function normalizeAgents(agents: readonly string[] | undefined): string {
  return [...new Set((agents ?? []).map((a) => a.trim()).filter((a) => a.length > 0))]
    .sort()
    .join(',');
}

describe('prepare dedupe key', () => {
  it('absent and empty are the same bake (the agentless base)', () => {
    expect(normalizeAgents(undefined)).toBe(normalizeAgents([]));
  });

  it('different agent sets are different bakes', () => {
    expect(normalizeAgents(['claude'])).not.toBe(normalizeAgents(['codex']));
    expect(normalizeAgents(['claude'])).not.toBe(normalizeAgents([]));
  });

  it('order and duplicates do not change the key', () => {
    expect(normalizeAgents(['codex', 'claude'])).toBe(
      normalizeAgents(['claude', 'codex', 'claude']),
    );
  });
});
