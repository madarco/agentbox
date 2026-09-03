import { describe, expect, it } from 'vitest';
import { resolveAgentSpec } from '@agentbox/sandbox-core';
import { requireAgentCredential } from '@agentbox/core';
import { SYNC_SCRIPT } from '../src/sync/claude-credentials.js';

/**
 * The freshness rule has TWO implementations — `shouldAcceptCredentialUpdate` in
 * TypeScript, and this shell script's `jq`, which runs in a throwaway container
 * that has only `jq`. Both must read the field the spec declares.
 *
 * Keeping the jq hardcoded is what made it a copy that could drift, and a drift
 * here is silent and expensive: an OAuth refresh ROTATES the refresh token, so a
 * direction decided on the wrong field can hand a box a dead blob and log the
 * whole fleet out.
 */
describe('the docker sync script and the spec agree on the freshness field', () => {
  const path = requireAgentCredential(resolveAgentSpec('claude')).freshness?.jsonPath;

  it('claude declares one', () => {
    // Without it, `shouldAcceptCredentialUpdate` silently degrades claude to
    // last-writer-wins — the fleet-logout case.
    expect(path).toEqual(['claudeAiOauth', 'expiresAt']);
  });

  it('renders that exact jq path, on both sides of the comparison', () => {
    const jq = `.${(path ?? []).join('.')}`;
    const lines = SYNC_SCRIPT.split('\n').filter((l) => l.includes('EXP=$('));
    expect(lines).toHaveLength(2); // the volume's and the host backup's
    for (const line of lines) expect(line).toContain(`(${jq} // 0)`);
  });

  it('never hardcodes a field the spec does not name', () => {
    // Catches the reverse drift: someone edits the script to read a new field
    // without moving the declaration.
    const jqReads = [...SYNC_SCRIPT.matchAll(/jq -r '\(([^ ]+) \/\/ 0\)/g)].map((m) => m[1]);
    for (const read of jqReads) expect(read).toBe(`.${(path ?? []).join('.')}`);
  });
});
