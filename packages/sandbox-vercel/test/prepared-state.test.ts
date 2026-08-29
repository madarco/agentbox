import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  preparedEntryFor,
  readPreparedState,
  sharedSnapshotIds,
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
  it('returns an empty schema-2 state when the file is absent', () => {
    expect(readPreparedState()).toEqual({ schema: 2 });
  });

  it('round-trips a base snapshot record', () => {
    writePreparedState({
      schema: 2,
      base: {
        snapshotId: 'snap_abc',
        contextSha256: 'deadbeef',
        createdAt: '2026-05-28T00:00:00Z',
      },
    });
    const s = readPreparedState();
    expect(s.base?.snapshotId).toBe('snap_abc');
    expect(s.base?.contextSha256).toBe('deadbeef');
  });

  it('lifts a schema-1 file forward by seeding the variants map from base', () => {
    // The migration users actually hit. A v1 file has exactly one bake and it is
    // the base, so this is lossless -- nobody re-bakes to get variants. Getting
    // it wrong reads as "no base" and silently forces a full re-bake.
    const base = {
      snapshotId: 'snap_wPS9mFWDaUWwS35J3XDMHGeagnEf',
      contextSha256: 'c937d5ba',
      cliVersion: '0.28.2',
      createdAt: '2026-08-27T12:51:27.721Z',
    };
    writeFileSync(preparedStatePath(), JSON.stringify({ schema: 1, base }));
    const s = readPreparedState();
    expect(s.schema).toBe(2);
    expect(s.base).toEqual(base);
    expect(preparedEntryFor(s, '')).toEqual(base);
    // ...and it is NOT offered as any agent's variant.
    expect(preparedEntryFor(s, 'claude')).toBeUndefined();
  });

  it('round-trips schema-2 variants', () => {
    const base = { snapshotId: 'snap_base', createdAt: '2026-05-28T00:00:00Z' };
    const claude = { snapshotId: 'snap_claude', createdAt: '2026-05-29T00:00:00Z' };
    writePreparedState({ schema: 2, base, variants: { '': base, claude } });
    const s = readPreparedState();
    expect(preparedEntryFor(s, 'claude')?.snapshotId).toBe('snap_claude');
    // A variant nobody baked falls through to undefined, NOT to the base -- the
    // caller decides whether to fall back so it can log the difference.
    expect(preparedEntryFor(s, 'codex')).toBeUndefined();
  });

  it('sharedSnapshotIds covers the base AND every variant', () => {
    // This set is what stops `destroy` and `checkpoint rm` deleting a snapshot
    // other boxes boot from. Missing a variant here is a data-loss bug.
    const base = { snapshotId: 'snap_base', createdAt: 'x' };
    const claude = { snapshotId: 'snap_claude', createdAt: 'y' };
    const codex = { snapshotId: 'snap_codex', createdAt: 'z' };
    const ids = sharedSnapshotIds({ schema: 2, base, variants: { '': base, claude, codex } });
    expect([...ids].sort()).toEqual(['snap_base', 'snap_claude', 'snap_codex']);
  });

  it('refuses an unknown schema (treated as rebuild-needed)', () => {
    writeFileSync(preparedStatePath(), JSON.stringify({ schema: 99, base: { snapshotId: 'x' } }));
    expect(readPreparedState()).toEqual({ schema: 2 });
  });

  it('ensureVercelBaseSnapshot throws with the prepare hint when no base exists', () => {
    expect(() => ensureVercelBaseSnapshot()).toThrow(/agentbox prepare --provider vercel/);
  });

  it('ensureVercelBaseSnapshot passes once a base is recorded', () => {
    writePreparedState({
      schema: 2,
      base: { snapshotId: 'snap_x', createdAt: '2026-05-28T00:00:00Z' },
    });
    expect(() => ensureVercelBaseSnapshot()).not.toThrow();
  });
});
