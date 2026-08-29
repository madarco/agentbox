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

describe('hetzner prepared-state schema migration', () => {
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
    // A v2 file has exactly one bake and it is the agentless base, so the
    // migration is lossless — nobody has to re-bake a VPS to get variants.
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
    const before = {
      schema: 3 as const,
      base: {
        imageId: 200,
        description: 'agentbox-claude-v3',
        createdAt: '2026-03-01T00:00:00.000Z',
        contextSha256: 'cccc3333',
      },
      variants: {
        '': {
          imageId: 100,
          description: 'agentbox-base-v3',
          createdAt: '2026-02-01T00:00:00.000Z',
          contextSha256: 'aaaa1111',
        },
        claude: {
          imageId: 200,
          description: 'agentbox-claude-v3',
          createdAt: '2026-03-01T00:00:00.000Z',
          contextSha256: 'cccc3333',
        },
      },
    };
    writePreparedState(before);
    const got = readPreparedState();
    expect(got).toEqual(before);
    // `base` holds the most RECENT bake (here the claude variant), which is
    // exactly why callers must go through preparedEntryFor rather than read it.
    expect(preparedEntryFor(got, '')?.imageId).toBe(100);
    expect(preparedEntryFor(got, 'claude')?.imageId).toBe(200);
  });

  it('returns an empty state when no file exists', async () => {
    await rm(preparedStatePath(), { force: true });
    const got = readPreparedState();
    expect(got.schema).toBe(3);
    expect(got.base).toBeUndefined();
  });
});
