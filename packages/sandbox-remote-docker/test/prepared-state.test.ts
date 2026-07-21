import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readPreparedState, recordPreparedHost, removePreparedHost } from '../src/prepared-state.js';

// `writePreparedStateRaw` writes to `$HOME/.agentbox/remote-docker-prepared.json`.
// Point HOME at a throwaway dir so these tests never touch the developer's real
// prepared-state (this package has no HOME-isolating vitest setup file).
let tmpHome: string | undefined;
let origHome: string | undefined;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'agentbox-prepared-test-'));
  origHome = process.env.HOME;
  process.env.HOME = tmpHome;
});

afterEach(() => {
  if (origHome === undefined) delete process.env.HOME;
  else process.env.HOME = origHome;
  origHome = undefined;
  if (tmpHome) {
    rmSync(tmpHome, { recursive: true, force: true });
    tmpHome = undefined;
  }
});

describe('removePreparedHost', () => {
  it('drops one host and leaves the others intact', () => {
    recordPreparedHost('macmini', { imageRef: 'agentbox/box:aaa', contextSha256: 'aaa' });
    recordPreparedHost('buildbox', { imageRef: 'agentbox/box:bbb', contextSha256: 'bbb' });

    const removed = removePreparedHost('macmini');
    expect(removed).toBe(true);

    const state = readPreparedState();
    expect(state?.hosts.macmini).toBeUndefined();
    expect(state?.hosts.buildbox?.imageRef).toBe('agentbox/box:bbb');
  });

  it('returns false for a host that was never recorded', () => {
    recordPreparedHost('buildbox', { imageRef: 'agentbox/box:bbb', contextSha256: 'bbb' });
    expect(removePreparedHost('nope')).toBe(false);
    // The existing host is untouched.
    expect(readPreparedState()?.hosts.buildbox?.imageRef).toBe('agentbox/box:bbb');
  });

  it('returns false when there is no prepared-state file at all', () => {
    expect(readPreparedState()).toBeNull();
    expect(removePreparedHost('macmini')).toBe(false);
  });
});
