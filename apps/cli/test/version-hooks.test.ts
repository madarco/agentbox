import { describe, expect, it } from 'vitest';
import { nudgeEligible, nudgeMessage } from '../src/lib/update-check.js';
import type { UpdateState } from '../src/lib/update-state.js';

function stateWithLatest(npmLatest?: string): UpdateState {
  return {
    version: 1,
    remoteCheck: { checkedAt: '2026-07-07T00:00:00.000Z', ...(npmLatest ? { npmLatest } : {}) },
  };
}

describe('nudgeEligible', () => {
  it('only nudges npm/pnpm installs with a real version', () => {
    expect(nudgeEligible('npm', '0.22.1')).toBe(true);
    expect(nudgeEligible('pnpm', '0.22.1')).toBe(true);
    // `direct` means a checkout run via symlink — self-update would skip the
    // package step, so pointing at it would be a dead end. (A global bin
    // invoked from the shell classifies as npm/pnpm via symlink resolution.)
    expect(nudgeEligible('direct', '0.22.1')).toBe(false);
    expect(nudgeEligible('npx', '0.22.1')).toBe(false);
    expect(nudgeEligible('npm', '0.0.0-dev')).toBe(false);
  });
});

describe('nudgeMessage', () => {
  it('nudges when the cached latest is newer', () => {
    expect(nudgeMessage(stateWithLatest('0.23.0'), 'npm', '0.22.1')).toContain('0.23.0');
    expect(nudgeMessage(stateWithLatest('0.23.0'), 'npm', '0.22.1')).toContain(
      'agentbox self-update',
    );
  });

  it('stays quiet when current, no cache, or ineligible', () => {
    expect(nudgeMessage(stateWithLatest('0.22.1'), 'npm', '0.22.1')).toBeNull();
    expect(nudgeMessage(stateWithLatest(), 'npm', '0.22.1')).toBeNull();
    expect(nudgeMessage({ version: 1 }, 'npm', '0.22.1')).toBeNull();
    expect(nudgeMessage(stateWithLatest('0.23.0'), 'npx', '0.22.1')).toBeNull();
    expect(nudgeMessage(stateWithLatest('0.23.0'), 'npm', '0.0.0-dev')).toBeNull();
  });
});
