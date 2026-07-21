import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_ENV_PATTERNS, scanHostEnvFiles } from '../src/sync/host-export.js';

describe('scanHostEnvFiles', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'agentbox-scan-env-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns matching files relative to workspaceDir, prefix-stripped', async () => {
    await writeFile(join(dir, '.env'), 'A=1');
    await writeFile(join(dir, '.env.local'), 'B=2');
    await writeFile(join(dir, 'README.md'), 'unrelated');

    const out = await scanHostEnvFiles(dir, DEFAULT_ENV_PATTERNS);
    expect(out.sort()).toEqual(['.env', '.env.local']);
    // No "./" prefix — must be relative without it so the tar -C extract lands correctly.
    expect(out.every((p) => !p.startsWith('./'))).toBe(true);
  });

  it('walks into subdirs (monorepo-friendly) but prunes node_modules and .git', async () => {
    await mkdir(join(dir, 'apps', 'web'), { recursive: true });
    await mkdir(join(dir, 'node_modules', 'pkg'), { recursive: true });
    await mkdir(join(dir, '.git'), { recursive: true });
    await writeFile(join(dir, 'apps', 'web', '.env.local'), 'X=1');
    await writeFile(join(dir, 'node_modules', 'pkg', '.env'), 'leak=1');
    await writeFile(join(dir, '.git', '.env'), 'gitleak=1');

    const out = await scanHostEnvFiles(dir, DEFAULT_ENV_PATTERNS);
    expect(out).toEqual(['apps/web/.env.local']);
  });

  it('returns [] for an empty patterns list (no scan)', async () => {
    await writeFile(join(dir, '.env'), 'A=1');
    expect(await scanHostEnvFiles(dir, [])).toEqual([]);
  });

  it('returns [] when nothing matches (no throw on empty stdout)', async () => {
    await writeFile(join(dir, 'README.md'), 'unrelated');
    expect(await scanHostEnvFiles(dir, DEFAULT_ENV_PATTERNS)).toEqual([]);
  });

  it('returns [] when workspaceDir does not exist (best-effort, no throw)', async () => {
    const ghost = join(dir, 'does-not-exist');
    expect(await scanHostEnvFiles(ghost, DEFAULT_ENV_PATTERNS)).toEqual([]);
  });
});
