import { mkdtemp, realpath, rm, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hashProjectPath, projectConfigDir } from '../src/paths.js';
import { listProjectsConfigured, registerProject, unregisterProject } from '../src/write.js';

let tmpCwd: string;

beforeEach(async () => {
  tmpCwd = await realpath(await mkdtemp(join(tmpdir(), 'agentbox-cfg-unreg-')));
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

describe('unregisterProject', () => {
  it('removes the registry dir and delists the project', async () => {
    await registerProject(tmpCwd);
    const dir = projectConfigDir(tmpCwd);
    expect(await exists(dir)).toBe(true);
    expect(await listProjectsConfigured()).toHaveLength(1);

    const removed = await unregisterProject(hashProjectPath(tmpCwd));

    expect(removed).toBe(true);
    expect(await exists(dir)).toBe(false);
    expect(await listProjectsConfigured()).toEqual([]);
  });

  it('is idempotent — returns false when the hash is not registered', async () => {
    expect(await unregisterProject(hashProjectPath(tmpCwd))).toBe(false);
    expect(await unregisterProject('deadbeefdeadbeef')).toBe(false);
  });
});
