import { describe, expect, it } from 'vitest';
import { decideHubUpdate, describeHubUpdate } from '../src/lib/hub-update-decision.js';

const REMOTE = { provider: 'hetzner', url: 'https://1.2.3.4.sslip.io' };
const TARGET = '0.29.0';

describe('decideHubUpdate', () => {
  it('updates a deployed control box that is behind', () => {
    const d = decideHubUpdate({
      record: REMOTE,
      liveVersion: '0.28.0',
      targetVersion: TARGET,
      skipHubFlag: false,
    });
    expect(d).toEqual({
      update: true,
      url: REMOTE.url,
      from: '0.28.0',
      to: TARGET,
    });
  });

  it('does nothing when this machine has no control box', () => {
    const d = decideHubUpdate({
      record: null,
      liveVersion: undefined,
      targetVersion: TARGET,
      skipHubFlag: false,
    });
    expect(d).toEqual({ update: false, reason: 'no-control-box' });
    // Nothing to say in the plan either — most machines are this case.
    expect(describeHubUpdate(d)).toBeNull();
  });

  it('does nothing for an exposed hub — the refresh already restarts it', () => {
    const d = decideHubUpdate({
      record: { provider: 'local', url: 'http://127.0.0.1:8787' },
      liveVersion: '0.28.0',
      targetVersion: TARGET,
      skipHubFlag: false,
    });
    expect(d).toEqual({ update: false, reason: 'local' });
    expect(describeHubUpdate(d)).toBeNull();
  });

  it('skips a control box already on the target build', () => {
    const d = decideHubUpdate({
      record: REMOTE,
      liveVersion: TARGET,
      targetVersion: TARGET,
      skipHubFlag: false,
    });
    expect(d).toEqual({ update: false, reason: 'already-current' });
    expect(describeHubUpdate(d)).toMatch(/already on this build/);
  });

  it('still updates a control box that did not answer', () => {
    // Unreachable is a reason to redeploy, not to skip — a half-finished update
    // is exactly the state that leaves a hub silent.
    const d = decideHubUpdate({
      record: REMOTE,
      liveVersion: undefined,
      targetVersion: TARGET,
      skipHubFlag: false,
    });
    expect(d.update).toBe(true);
    if (!d.update) return;
    expect(d.from).toBeUndefined();
    expect(describeHubUpdate(d)).toContain('unknown → 0.29.0');
  });

  it('honors --skip-hub even with a control box behind', () => {
    const d = decideHubUpdate({
      record: REMOTE,
      liveVersion: '0.28.0',
      targetVersion: TARGET,
      skipHubFlag: true,
    });
    expect(d).toEqual({ update: false, reason: 'flag' });
    expect(describeHubUpdate(d)).toMatch(/--skip-hub/);
  });

  it('ignores a record with no url (a partially-written deploy)', () => {
    const d = decideHubUpdate({
      record: { provider: 'hetzner' },
      liveVersion: undefined,
      targetVersion: TARGET,
      skipHubFlag: false,
    });
    expect(d).toEqual({ update: false, reason: 'no-control-box' });
  });
});
