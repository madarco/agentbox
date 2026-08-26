import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadEffectiveConfig } from '../src/load.js';
import { setConfigValue, unsetConfigValue } from '../src/write.js';

let tmpCwd: string;

beforeEach(async () => {
  tmpCwd = await realpath(await mkdtemp(join(tmpdir(), 'agentbox-cfg-conc-')));
});

afterEach(async () => {
  await rm(tmpCwd, { recursive: true, force: true });
  await rm(join(homedir(), '.agentbox'), { recursive: true, force: true });
});

// Two image bakes now run in parallel (one per provider) and each pins its own
// `box.image<Provider>` from a separate detached worker. Without the file lock
// around the read-modify-write, the second writer's read predates the first
// writer's write and its key is silently dropped.
describe('concurrent setConfigValue', () => {
  it('keeps every key when writes race', async () => {
    await Promise.all([
      setConfigValue('global', 'box.imageE2b', 'e2b-template-123', tmpCwd),
      setConfigValue('global', 'box.imageHetzner', '987654', tmpCwd),
      setConfigValue('global', 'box.imageVercel', 'snap-abc', tmpCwd),
    ]);
    const loaded = await loadEffectiveConfig(tmpCwd);
    expect(loaded.effective.box.imageE2b).toBe('e2b-template-123');
    expect(loaded.effective.box.imageHetzner).toBe('987654');
    expect(loaded.effective.box.imageVercel).toBe('snap-abc');
  });

  it('keeps unrelated keys when an unset races a set', async () => {
    await setConfigValue('global', 'box.imageE2b', 'e2b-template-123', tmpCwd);
    await Promise.all([
      unsetConfigValue('global', 'box.imageE2b', tmpCwd),
      setConfigValue('global', 'box.imageHetzner', '987654', tmpCwd),
    ]);
    const loaded = await loadEffectiveConfig(tmpCwd);
    expect(loaded.effective.box.imageE2b).toBe('');
    expect(loaded.effective.box.imageHetzner).toBe('987654');
  });
});
