import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cloudSnapshotName,
  CLOUD_SNAPSHOT_NAME_PREFIX,
  listCloudCheckpoints,
  removeCloudCheckpointDir,
  resolveCloudCheckpoint,
  writeCloudCheckpointManifest,
} from '../src/checkpoint.js';

// Override HOME so writeCloudCheckpointManifest writes under a tmp dir
// instead of the real `~/.agentbox/`. Restored at the end.
let originalHome: string | undefined;
let tmpHome: string;

beforeAll(async () => {
  originalHome = process.env.HOME;
  tmpHome = await mkdtemp(join(tmpdir(), 'agentbox-ckpt-test-'));
  process.env.HOME = tmpHome;
});

afterAll(async () => {
  process.env.HOME = originalHome;
  await rm(tmpHome, { recursive: true, force: true });
});

describe('cloudSnapshotName', () => {
  it('produces an org-unique name with the agentbox-ckpt- prefix', () => {
    const name = cloudSnapshotName('/Users/marco/projects/express-server', 'setup');
    expect(name.startsWith(CLOUD_SNAPSHOT_NAME_PREFIX)).toBe(true);
    expect(name.endsWith('-setup')).toBe(true);
    // Contains the project mnemonic so the Daytona dashboard reads
    // self-describing (project hash + mnemonic + checkpoint name).
    expect(name).toContain('express_server');
  });

  it('is deterministic for the same project + name', () => {
    const a = cloudSnapshotName('/projects/foo', 'setup');
    const b = cloudSnapshotName('/projects/foo', 'setup');
    expect(a).toBe(b);
  });

  it('differs across projects with the same checkpoint name', () => {
    const a = cloudSnapshotName('/projects/foo', 'setup');
    const b = cloudSnapshotName('/projects/bar', 'setup');
    expect(a).not.toBe(b);
  });

  it('differs across checkpoint names within the same project', () => {
    const a = cloudSnapshotName('/projects/foo', 'setup');
    const b = cloudSnapshotName('/projects/foo', 'with-deps');
    expect(a).not.toBe(b);
    expect(a.endsWith('-setup')).toBe(true);
    expect(b.endsWith('-with-deps')).toBe(true);
  });
});

describe('manifest lifecycle', () => {
  const projectRoot = '/projects/test-cloud-ckpt';
  const backend = 'daytona';

  it('writes, resolves, lists, and removes a manifest', async () => {
    // resolve before write → null
    expect(await resolveCloudCheckpoint(projectRoot, backend, 'setup')).toBeNull();

    const info = await writeCloudCheckpointManifest(projectRoot, backend, 'setup', {
      snapshotName: cloudSnapshotName(projectRoot, 'setup'),
      sourceBoxId: 'abc123',
      sourceBoxName: 'test-cloud-ckpt-abc123',
    });
    expect(info.manifest.schema).toBe(1);
    expect(info.manifest.name).toBe('setup');
    expect(info.manifest.backend).toBe(backend);
    expect(info.manifest.snapshotName).toContain('test_cloud_ckpt');
    // Manifest file lives on disk and is valid JSON.
    const raw = await readFile(join(info.dir, 'manifest.json'), 'utf8');
    expect(JSON.parse(raw)).toMatchObject({ schema: 1, name: 'setup', backend });

    // resolve after write → populated
    const resolved = await resolveCloudCheckpoint(projectRoot, backend, 'setup');
    expect(resolved?.manifest.snapshotName).toBe(info.manifest.snapshotName);

    // list returns the one we just wrote
    const list = await listCloudCheckpoints(projectRoot, backend);
    expect(list.map((c) => c.name)).toEqual(['setup']);

    // remove → resolve again returns null
    expect(await removeCloudCheckpointDir(projectRoot, backend, 'setup')).toBe(true);
    expect(await resolveCloudCheckpoint(projectRoot, backend, 'setup')).toBeNull();

    // remove on a missing manifest returns false (idempotent)
    expect(await removeCloudCheckpointDir(projectRoot, backend, 'setup')).toBe(false);
  });

  it('keeps backends isolated', async () => {
    await writeCloudCheckpointManifest(projectRoot, 'daytona', 'setup', {
      snapshotName: cloudSnapshotName(projectRoot, 'setup'),
      sourceBoxId: 'a',
      sourceBoxName: 'x',
    });
    // A different backend with the same project + name finds nothing.
    expect(await resolveCloudCheckpoint(projectRoot, 'other-backend', 'setup')).toBeNull();
    await removeCloudCheckpointDir(projectRoot, 'daytona', 'setup');
  });
});
