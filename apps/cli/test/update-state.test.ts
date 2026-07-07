import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  readUpdateState,
  remoteCheckFresh,
  updateStatePath,
  writeUpdateState,
} from '../src/lib/update-state.js';

// apps/cli tests have no global $HOME isolation — point HOME at a scratch dir
// for this file so we never touch the real ~/.agentbox.
let home: string;
const realHome = process.env.HOME;

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'agentbox-update-state-'));
  process.env.HOME = home;
});

afterAll(() => {
  process.env.HOME = realHome;
  rmSync(home, { recursive: true, force: true });
});

beforeEach(() => {
  rmSync(updateStatePath(), { force: true });
});

describe('update-state', () => {
  it('reads an empty state when the file is missing', () => {
    expect(readUpdateState()).toEqual({ version: 1 });
  });

  it('round-trips fields through write/read', () => {
    writeUpdateState({ lastRunVersion: '1.2.3', traySha: 'a'.repeat(64) });
    const state = readUpdateState();
    expect(state.lastRunVersion).toBe('1.2.3');
    expect(state.traySha).toBe('a'.repeat(64));
  });

  it('merges patches without clobbering other fields', () => {
    writeUpdateState({ lastRunVersion: '1.2.3' });
    writeUpdateState({ traySha: 'b'.repeat(64) });
    writeUpdateState({
      remoteCheck: { checkedAt: '2026-07-07T00:00:00.000Z', npmLatest: '1.2.4' },
    });
    const state = readUpdateState();
    expect(state.lastRunVersion).toBe('1.2.3');
    expect(state.traySha).toBe('b'.repeat(64));
    expect(state.remoteCheck?.npmLatest).toBe('1.2.4');
  });

  it('deletes a field when the patch value is an explicit undefined', () => {
    writeUpdateState({ lastRunVersion: '1.2.3', traySha: 'c'.repeat(64) });
    writeUpdateState({ traySha: undefined });
    const state = readUpdateState();
    expect(state.traySha).toBeUndefined();
    expect(state.lastRunVersion).toBe('1.2.3');
    // The deleted key must not survive as `"traySha": undefined`-ish JSON.
    expect(readFileSync(updateStatePath(), 'utf8')).not.toContain('traySha');
  });

  it('treats a corrupt file as fresh instead of throwing', () => {
    writeUpdateState({ lastRunVersion: '1.2.3' });
    writeFileSync(updateStatePath(), '{not json');
    expect(readUpdateState()).toEqual({ version: 1 });
  });

  it('drops fields of the wrong type on read', () => {
    writeFileSync(
      updateStatePath(),
      JSON.stringify({ version: 1, lastRunVersion: 42, remoteCheck: { checkedAt: 5 } }),
    );
    const state = readUpdateState();
    expect(state.lastRunVersion).toBeUndefined();
    expect(state.remoteCheck).toBeUndefined();
  });
});

describe('remoteCheckFresh', () => {
  const now = new Date('2026-07-07T12:00:00.000Z');

  it('is false with no remoteCheck', () => {
    expect(remoteCheckFresh({ version: 1 }, now)).toBe(false);
  });

  it('is true within 24h and false after', () => {
    const fresh = { version: 1 as const, remoteCheck: { checkedAt: '2026-07-07T00:00:00.000Z' } };
    const stale = { version: 1 as const, remoteCheck: { checkedAt: '2026-07-06T11:00:00.000Z' } };
    expect(remoteCheckFresh(fresh, now)).toBe(true);
    expect(remoteCheckFresh(stale, now)).toBe(false);
  });

  it('is false for garbage or far-future timestamps', () => {
    const garbage = { version: 1 as const, remoteCheck: { checkedAt: 'not-a-date' } };
    const future = { version: 1 as const, remoteCheck: { checkedAt: '2027-01-01T00:00:00.000Z' } };
    expect(remoteCheckFresh(garbage, now)).toBe(false);
    expect(remoteCheckFresh(future, now)).toBe(false);
  });
});
