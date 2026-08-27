import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assertTempHome, resetTempAgentboxHome } from '../../../scripts/test-home.js';

/**
 * The guard that stands between a mis-wired test setup and the developer's real
 * `~/.agentbox`. Several suites `rm -rf $HOME/.agentbox` between tests; when a
 * root-level `vitest run` dropped the per-package `setupFiles`, that deleted a
 * real home (secrets.env, state.json, hub token). The workspace file fixes the
 * wiring; this refuses to delete if the wiring ever breaks again.
 */
const REAL_HOME = process.env['HOME'];

afterEach(() => {
  if (REAL_HOME !== undefined) process.env['HOME'] = REAL_HOME;
});

describe('temp-home guard', () => {
  it('accepts a HOME inside the OS temp dir', () => {
    const home = mkdtempSync(join(tmpdir(), 'agentbox-guard-ok-'));
    process.env['HOME'] = home;
    expect(assertTempHome()).toBeTruthy();
  });

  it('accepts the temp HOME this suite already runs under', () => {
    expect(() => assertTempHome()).not.toThrow();
  });

  it('refuses a HOME outside the temp dir', () => {
    process.env['HOME'] = '/Users/somebody';
    expect(() => assertTempHome()).toThrow(/not an isolated temp dir/);
  });

  it('refuses to delete .agentbox under a non-temp HOME', async () => {
    process.env['HOME'] = '/Users/somebody';
    await expect(resetTempAgentboxHome()).rejects.toThrow(/refusing to touch/);
  });

  it('names the likely cause so the failure is self-diagnosing', () => {
    process.env['HOME'] = '/Users/somebody';
    expect(() => assertTempHome()).toThrow(/vitest\.workspace\.ts/);
  });
});
