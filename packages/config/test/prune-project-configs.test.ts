import { mkdtemp, realpath, rm, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { projectConfigDir } from '../src/paths.js';
import {
  bumpProjectGcCounter,
  listProjectsConfigured,
  pruneOrphanProjectConfigs,
  setConfigValue,
} from '../src/write.js';

let tmpCwd: string;

beforeEach(async () => {
  tmpCwd = await realpath(await mkdtemp(join(tmpdir(), 'agentbox-cfg-gc-')));
});

afterEach(async () => {
  await rm(tmpCwd, { recursive: true, force: true });
  await rm(join(homedir(), '.agentbox'), { recursive: true, force: true });
});

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

describe('pruneOrphanProjectConfigs', () => {
  it('removes a project dir whose workspace folder was deleted', async () => {
    await setConfigValue('project', 'engine.kind', 'orbstack', tmpCwd, { raw: true });
    const dir = projectConfigDir(tmpCwd);
    expect(await exists(dir)).toBe(true);

    await rm(tmpCwd, { recursive: true, force: true });
    const res = await pruneOrphanProjectConfigs();

    expect(res.removed.map((r) => r.originalPath)).toEqual([tmpCwd]);
    expect(await exists(dir)).toBe(false);
    expect(await listProjectsConfigured()).toEqual([]);
  });

  it('keeps a project whose workspace still exists', async () => {
    await setConfigValue('project', 'engine.kind', 'orbstack', tmpCwd, { raw: true });
    const res = await pruneOrphanProjectConfigs();
    expect(res.removed).toEqual([]);
    expect(await exists(projectConfigDir(tmpCwd))).toBe(true);
  });

  it('respects protectedPaths even when the folder is gone', async () => {
    await setConfigValue('project', 'engine.kind', 'orbstack', tmpCwd, { raw: true });
    await rm(tmpCwd, { recursive: true, force: true });

    const res = await pruneOrphanProjectConfigs({ protectedPaths: [tmpCwd] });
    expect(res.removed).toEqual([]);
    expect(await exists(projectConfigDir(tmpCwd))).toBe(true);
  });

  it('dryRun reports orphans but removes nothing', async () => {
    await setConfigValue('project', 'engine.kind', 'orbstack', tmpCwd, { raw: true });
    await rm(tmpCwd, { recursive: true, force: true });

    const res = await pruneOrphanProjectConfigs({ dryRun: true });
    expect(res.dryRun).toBe(true);
    expect(res.removed.map((r) => r.originalPath)).toEqual([tmpCwd]);
    expect(await exists(projectConfigDir(tmpCwd))).toBe(true);
  });
});

describe('bumpProjectGcCounter', () => {
  it('increments monotonically and survives a missing counter file', async () => {
    expect(await bumpProjectGcCounter()).toBe(1);
    expect(await bumpProjectGcCounter()).toBe(2);
    expect(await bumpProjectGcCounter()).toBe(3);
  });

  it('does not interfere with listProjectsConfigured', async () => {
    await bumpProjectGcCounter();
    await setConfigValue('project', 'engine.kind', 'orbstack', tmpCwd, { raw: true });
    const entries = await listProjectsConfigured();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.originalPath).toBe(tmpCwd);
  });
});
