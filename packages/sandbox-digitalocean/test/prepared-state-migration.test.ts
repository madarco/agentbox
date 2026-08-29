// Set HOME before any import that reads `homedir()` at module load.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TEST_HOME = mkdtempSync(join(tmpdir(), 'agentbox-hetz-mig-'));
process.env.HOME = TEST_HOME;

import { mkdir, rm, writeFile } from 'node:fs/promises';
import { afterAll, describe, expect, it } from 'vitest';
import {
  preparedEntryFor,
  preparedStatePath,
  readPreparedState,
  writePreparedState,
} from '../src/prepared-state.js';

async function writeRaw(content: unknown): Promise<void> {
  const path = preparedStatePath();
  await mkdir(join(TEST_HOME, '.agentbox'), { recursive: true });
  await writeFile(path, JSON.stringify(content, null, 2) + '\n', 'utf8');
}

describe('digitalocean prepared-state schema migration', () => {
  afterAll(async () => {
    await rm(TEST_HOME, { recursive: true, force: true });
  });

  it('lifts a schema-1 file forward by renaming installScriptSha256 → contextSha256', async () => {
    await writeRaw({
      schema: 1,
      base: {
        imageId: 42,
        description: 'agentbox-base-1234567890',
        createdAt: '2026-01-01T00:00:00.000Z',
        installScriptSha256: 'deadbeefcafebabe',
      },
      // A legacy `projects` key (the never-wired per-project tier) is ignored.
      projects: {
        foo: { imageId: 7, description: 'p-foo', createdAt: '2026-01-02T00:00:00.000Z' },
      },
    });
    const got = readPreparedState();
    expect(got.schema).toBe(3);
    expect(got.base?.imageId).toBe(42);
    expect(got.base?.contextSha256).toBe('deadbeefcafebabe');
    expect((got as unknown as { projects?: unknown }).projects).toBeUndefined();
    // `installScriptSha256` is dropped; the new field carries the value.
    expect(
      (got.base as unknown as { installScriptSha256?: string }).installScriptSha256,
    ).toBeUndefined();
  });

  it('returns an empty state for an unrecognised schema', async () => {
    await writeRaw({ schema: 99, base: { imageId: 1, description: 'x', createdAt: 'y' } });
    const got = readPreparedState();
    expect(got.schema).toBe(3);
    expect(got.base).toBeUndefined();
  });

  it('lifts a schema-2 file forward by seeding the variants map from base', async () => {
    // A v2 file has exactly one bake, so the migration is lossless -- nobody has
    // to re-bake a Droplet to get variants. That base predates the agentless
    // install-box.sh and still carries all three agents, but its contextSha256
    // no longer matches, so the freshness surface reports it stale and the next
    // prepare replaces it. Until then the user's boxes keep booting.
    const base = {
      imageId: 100,
      description: 'agentbox-base-v2',
      createdAt: '2026-02-01T00:00:00.000Z',
      contextSha256: 'aaaa1111bbbb2222',
      cliVersion: '0.7.0',
      cliCommit: 'abc1234',
    };
    await writeRaw({ schema: 2, base });
    const got = readPreparedState();
    expect(got.schema).toBe(3);
    expect(got.base).toEqual(base);
    expect(preparedEntryFor(got, '')).toEqual(base);
    // ...and it is NOT offered as any agent's variant.
    expect(preparedEntryFor(got, 'claude')).toBeUndefined();
  });

  it('round-trips schema-3 variants unchanged', async () => {
    const base = {
      imageId: 100,
      description: 'agentbox-base-v3',
      createdAt: '2026-02-01T00:00:00.000Z',
      contextSha256: 'aaaa1111bbbb2222',
    };
    const claude = {
      imageId: 101,
      description: 'agentbox-claude-v3',
      createdAt: '2026-02-02T00:00:00.000Z',
      contextSha256: 'cccc3333dddd4444',
    };
    const before = { schema: 3 as const, base, variants: { '': base, claude } };
    writePreparedState(before);
    const got = readPreparedState();
    expect(got).toEqual(before);
    expect(preparedEntryFor(got, 'claude')?.imageId).toBe(101);
    // A variant nobody baked falls through to undefined, NOT to the base -- the
    // caller decides whether to fall back, so it can log the difference.
    expect(preparedEntryFor(got, 'codex')).toBeUndefined();
  });

  it('returns an empty state when no file exists', async () => {
    await rm(preparedStatePath(), { force: true });
    const got = readPreparedState();
    expect(got.schema).toBe(3);
    expect(got.base).toBeUndefined();
  });
});
