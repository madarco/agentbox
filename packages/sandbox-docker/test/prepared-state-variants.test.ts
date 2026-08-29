import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// $HOME is redirected per-file: prepared-state writes to ~/.agentbox and these
// tests must never touch the real one (apps/cli has no HOME isolation setup).
let home: string;
let origHome: string | undefined;

beforeEach(async () => {
  origHome = process.env.HOME;
  home = await mkdtemp(join(tmpdir(), 'agentbox-prepared-variants-'));
  process.env.HOME = home;
});
afterEach(async () => {
  if (origHome === undefined) delete process.env.HOME;
  else process.env.HOME = origHome;
  await rm(home, { recursive: true, force: true });
});

describe('prepared docker state — per-variant records', () => {
  it('keeps one record per agent set, so alternating agents does not rebuild', async () => {
    const { writePreparedDockerState, preparedMatches, readPreparedDockerState } =
      await import('../src/prepared-state.js');

    writePreparedDockerState({
      imageRef: 'agentbox/box:dev-claude',
      contextSha256: 'aaa',
      variant: 'claude',
    });
    writePreparedDockerState({
      imageRef: 'agentbox/box:dev-codex',
      contextSha256: 'bbb',
      variant: 'codex',
    });

    const state = readPreparedDockerState();
    // The whole point: building codex must not invalidate claude.
    expect(preparedMatches(state, 'aaa', 'claude')).toBe(true);
    expect(preparedMatches(state, 'bbb', 'codex')).toBe(true);
    expect(preparedMatches(state, 'aaa', 'codex')).toBe(false);
  });

  it('falls back to `base` for records written before variants existed', async () => {
    const { writePreparedStateRaw } = await import('@agentbox/sandbox-core');
    const { preparedMatches, readPreparedDockerState } = await import('../src/prepared-state.js');

    writePreparedStateRaw('docker', {
      schema: 1,
      base: {
        imageRef: 'agentbox/box:dev',
        contextSha256: 'legacy',
        cliVersion: '0.0.0',
        createdAt: 'x',
      },
    });
    expect(preparedMatches(readPreparedDockerState(), 'legacy', '')).toBe(true);
  });

  it('still stamps `base` so prepare --status and the freshness nag keep working', async () => {
    const { writePreparedDockerState, readPreparedDockerState } =
      await import('../src/prepared-state.js');
    writePreparedDockerState({
      imageRef: 'agentbox/box:dev-claude',
      contextSha256: 'aaa',
      variant: 'claude',
    });
    expect(readPreparedDockerState()?.base?.contextSha256).toBe('aaa');
  });
});

describe('freshness reads the base variant, not the last-prepared image', () => {
  it('does not report the agentless base stale after an agent bake', async () => {
    const { writePreparedDockerState, preparedShaFor, readPreparedDockerState } =
      await import('../src/prepared-state.js');
    // Order matters: the agent bake lands LAST, so `base` holds its hash.
    writePreparedDockerState({
      imageRef: 'agentbox/box:dev',
      contextSha256: 'baseSha',
      variant: '',
    });
    writePreparedDockerState({
      imageRef: 'agentbox/box:dev-claude',
      contextSha256: 'claudeSha',
      variant: 'claude',
    });
    const state = readPreparedDockerState();
    expect(state?.base?.contextSha256).toBe('claudeSha'); // last prepared, as before
    // ...but the base's own slot is what the freshness check must consult.
    expect(preparedShaFor(state, '')).toBe('baseSha');
    expect(preparedShaFor(state, 'claude')).toBe('claudeSha');
  });
});
