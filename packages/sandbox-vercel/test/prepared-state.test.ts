import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  readPreparedState,
  writePreparedState,
  ensureVercelBaseSnapshot,
  preparedStatePath,
} from '../src/prepared-state.js';

let home: string;
let savedHome: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'agentbox-vercel-prep-'));
  mkdirSync(join(home, '.agentbox'), { recursive: true });
  savedHome = process.env.HOME;
  process.env.HOME = home;
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
});

describe('vercel prepared-state', () => {
  it('returns an empty schema-1 state when the file is absent', () => {
    expect(readPreparedState()).toEqual({ schema: 1 });
  });

  it('round-trips a base snapshot record', () => {
    writePreparedState({
      schema: 1,
      base: { snapshotId: 'snap_abc', contextSha256: 'deadbeef', createdAt: '2026-05-28T00:00:00Z' },
    });
    const s = readPreparedState();
    expect(s.base?.snapshotId).toBe('snap_abc');
    expect(s.base?.contextSha256).toBe('deadbeef');
  });

  it('refuses an unknown schema (treated as rebuild-needed)', () => {
    writeFileSync(preparedStatePath(), JSON.stringify({ schema: 99, base: { snapshotId: 'x' } }));
    expect(readPreparedState()).toEqual({ schema: 1 });
  });

  it('ensureVercelBaseSnapshot throws with the prepare hint when no base exists', () => {
    expect(() => ensureVercelBaseSnapshot()).toThrow(/agentbox prepare --provider vercel/);
  });

  it('ensureVercelBaseSnapshot passes once a base is recorded', () => {
    writePreparedState({ schema: 1, base: { snapshotId: 'snap_x', createdAt: '2026-05-28T00:00:00Z' } });
    expect(() => ensureVercelBaseSnapshot()).not.toThrow();
  });
});
