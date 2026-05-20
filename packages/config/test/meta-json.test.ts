import { readFile, realpath } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hashProjectPath, projectMetaFile } from '../src/paths.js';
import { listProjectsConfigured, setConfigValue, unsetConfigValue } from '../src/write.js';

let tmpCwd: string;

beforeEach(async () => {
  // realpath so projectMetaFile(tmpCwd) hashes the same canonical path that
  // setConfigValue → findProjectRoot resolves to.
  tmpCwd = await realpath(await mkdtemp(join(tmpdir(), 'agentbox-cfg-meta-')));
});

afterEach(async () => {
  await rm(tmpCwd, { recursive: true, force: true });
  await rm(join(homedir(), '.agentbox'), { recursive: true, force: true });
});

interface Meta {
  originalPath: string;
  hash: string;
  createdAt: string;
  lastSeenAt: string;
}

async function readMeta(absPath: string): Promise<Meta> {
  return JSON.parse(await readFile(projectMetaFile(absPath), 'utf8')) as Meta;
}

describe('per-project meta.json', () => {
  it('is created on first project-scope write', async () => {
    await setConfigValue('project', 'engine.kind', 'orbstack', tmpCwd, { raw: true });
    const meta = await readMeta(tmpCwd);
    expect(meta.originalPath).toBe(tmpCwd);
    expect(meta.hash).toBe(hashProjectPath(tmpCwd));
    expect(meta.createdAt).toBe(meta.lastSeenAt);
  });

  it('preserves createdAt and updates lastSeenAt on subsequent writes', async () => {
    await setConfigValue('project', 'engine.kind', 'orbstack', tmpCwd, { raw: true });
    const first = await readMeta(tmpCwd);
    // Wait a tick so timestamps differ.
    await new Promise((r) => setTimeout(r, 5));
    await setConfigValue('project', 'box.vnc', 'true', tmpCwd, { raw: true });
    const second = await readMeta(tmpCwd);
    expect(second.createdAt).toBe(first.createdAt);
    expect(new Date(second.lastSeenAt).getTime()).toBeGreaterThanOrEqual(
      new Date(first.lastSeenAt).getTime(),
    );
  });

  it('touches meta on unset too', async () => {
    await setConfigValue('project', 'engine.kind', 'orbstack', tmpCwd, { raw: true });
    const before = await readMeta(tmpCwd);
    await new Promise((r) => setTimeout(r, 5));
    await unsetConfigValue('project', 'engine.kind', tmpCwd);
    const after = await readMeta(tmpCwd);
    expect(new Date(after.lastSeenAt).getTime()).toBeGreaterThanOrEqual(
      new Date(before.lastSeenAt).getTime(),
    );
  });

  it('global writes do not create per-project meta', async () => {
    await setConfigValue('global', 'engine.kind', 'orbstack', tmpCwd, { raw: true });
    const projects = await listProjectsConfigured();
    expect(projects).toEqual([]);
  });

  it('listProjectsConfigured enumerates touched projects', async () => {
    await setConfigValue('project', 'engine.kind', 'orbstack', tmpCwd, { raw: true });
    const entries = await listProjectsConfigured();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.originalPath).toBe(tmpCwd);
    expect(entries[0]?.hasConfigFile).toBe(true);
    // Dir name carries the hash + a mnemonic derived from the basename of
    // tmpCwd. The hash is the canonical key and is reported separately; the
    // mnemonic just makes the dir self-describing on disk.
    expect(entries[0]?.dirName).toMatch(/^[0-9a-f]{16}-[a-z0-9_]+$/);
    expect(entries[0]?.dirName.startsWith(entries[0]!.hash + '-')).toBe(true);
  });
});
