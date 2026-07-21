import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultSnapshotName } from '../src/prepare.js';
import {
  preparedMatches,
  readPreparedDaytonaState,
  writePreparedDaytonaState,
  type PreparedDaytonaState,
} from '../src/prepared-state.js';

const SHA = 'a'.repeat(64);

function state(over: { contextSha256?: string; size?: string }): PreparedDaytonaState {
  return {
    schema: 1,
    base: {
      imageRef: 'agentbox-base-aaaaaaaaaaaa',
      contextSha256: over.contextSha256 ?? SHA,
      cliVersion: '0.0.0',
      createdAt: '2026-07-10T00:00:00Z',
    },
    ...(over.size ? { extras: { size: over.size } } : {}),
  };
}

describe('daytona preparedMatches', () => {
  it('matches when sha equal and both sizes absent (default bake)', () => {
    expect(preparedMatches(state({}), SHA)).toBe(true);
    expect(preparedMatches(state({}), SHA, undefined)).toBe(true);
  });

  it('matches when sha AND size are equal', () => {
    expect(preparedMatches(state({ size: '4-8-20' }), SHA, '4-8-20')).toBe(true);
  });

  it('does not match when the size differs', () => {
    expect(preparedMatches(state({ size: '4-8-20' }), SHA, '2-4-8')).toBe(false);
    // A sized bake must not satisfy a default (size-less) request, and vice-versa.
    expect(preparedMatches(state({ size: '4-8-20' }), SHA, undefined)).toBe(false);
    expect(preparedMatches(state({}), SHA, '4-8-20')).toBe(false);
  });

  it('does not match when the fingerprint differs regardless of size', () => {
    expect(preparedMatches(state({ size: '4-8-20' }), 'b'.repeat(64), '4-8-20')).toBe(false);
  });

  it('never matches a null state', () => {
    expect(preparedMatches(null, SHA)).toBe(false);
  });
});

describe('defaultSnapshotName size suffix', () => {
  it('appends the size key so re-sized bakes do not collide', () => {
    expect(defaultSnapshotName(SHA)).toBe('agentbox-base-aaaaaaaaaaaa');
    expect(defaultSnapshotName(SHA, '4-8-20')).toBe('agentbox-base-aaaaaaaaaaaa-4-8-20');
    expect(defaultSnapshotName(SHA, '2-4-8')).toBe('agentbox-base-aaaaaaaaaaaa-2-4-8');
  });
});

describe('daytona prepared-state size round-trip', () => {
  // Prepared-state read/write hits ~/.agentbox; isolate $HOME per-file.
  let home: string;
  let savedHome: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'agentbox-daytona-prep-'));
    mkdirSync(join(home, '.agentbox'), { recursive: true });
    savedHome = process.env.HOME;
    process.env.HOME = home;
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
  });

  it('persists the baked size in extras and round-trips through preparedMatches', () => {
    writePreparedDaytonaState({
      snapshotName: 'agentbox-base-aaaaaaaaaaaa-4-8-20',
      contextSha256: SHA,
      size: '4-8-20',
    });
    const read = readPreparedDaytonaState();
    expect(read?.extras?.size).toBe('4-8-20');
    expect(preparedMatches(read, SHA, '4-8-20')).toBe(true);
    expect(preparedMatches(read, SHA, '2-4-8')).toBe(false);
  });

  it('omits extras entirely for a default (size-less) bake', () => {
    writePreparedDaytonaState({
      snapshotName: 'agentbox-base-aaaaaaaaaaaa',
      contextSha256: SHA,
    });
    const read = readPreparedDaytonaState();
    expect(read?.extras).toBeUndefined();
    expect(preparedMatches(read, SHA)).toBe(true);
  });
});
