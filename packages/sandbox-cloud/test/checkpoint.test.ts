import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cloudSnapshotName,
  CLOUD_CHECKPOINTS_ROOT,
  CLOUD_SNAPSHOT_NAME_PREFIX,
  listCloudCheckpoints,
  probeCloudCheckpoint,
  removeCloudCheckpointDir,
  resolveCloudCheckpoint,
  writeCloudCheckpointManifest,
} from '../src/checkpoint.js';
import { isSnapshotGoneError } from '../src/snapshot-error.js';

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
      baseProvider: backend,
      baseFingerprint: 'deadbeefcafef00d',
      cliVersion: '9.9.9',
    });
    // Schema 2 carries the base fingerprint so staleness is verifiable.
    expect(info.manifest.schema).toBe(2);
    expect(info.manifest.name).toBe('setup');
    expect(info.manifest.backend).toBe(backend);
    expect(info.manifest.baseFingerprint).toBe('deadbeefcafef00d');
    expect(info.manifest.snapshotName).toContain('test_cloud_ckpt');
    // Manifest file lives on disk and is valid JSON.
    const raw = await readFile(join(info.dir, 'manifest.json'), 'utf8');
    expect(JSON.parse(raw)).toMatchObject({ schema: 2, name: 'setup', backend });

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

describe('probeCloudCheckpoint', () => {
  const projectRoot = '/projects/test-probe';

  // Same caveat as 'manifest agent set' below: CLOUD_CHECKPOINTS_ROOT is fixed
  // at module load, so these manifests are written under the REAL home however
  // HOME is overridden afterwards. Clean up so a test run leaves nothing behind.
  afterAll(async () => {
    const backendRoot = join(CLOUD_CHECKPOINTS_ROOT, 'vercel');
    const segments = await readdir(backendRoot).catch(() => [] as string[]);
    for (const seg of segments.filter((d) => d.includes('test_probe'))) {
      await rm(join(backendRoot, seg), { recursive: true, force: true });
    }
  });

  async function seed(name: string): Promise<void> {
    await writeCloudCheckpointManifest(projectRoot, 'vercel', name, {
      snapshotName: `snap_${name}`,
      sourceBoxId: 'a',
      sourceBoxName: 'x',
    });
  }

  it('reports not-live with no prune when there is no manifest', async () => {
    const backend = { name: 'vercel', snapshotExists: async () => true };
    expect(await probeCloudCheckpoint(backend, projectRoot, 'absent')).toEqual({
      live: false,
      pruned: false,
    });
  });

  it('keeps a live snapshot and leaves the manifest in place', async () => {
    await seed('warm');
    const backend = { name: 'vercel', snapshotExists: async () => true };
    expect(await probeCloudCheckpoint(backend, projectRoot, 'warm')).toEqual({
      live: true,
      pruned: false,
    });
    expect(await resolveCloudCheckpoint(projectRoot, 'vercel', 'warm')).not.toBeNull();
    await removeCloudCheckpointDir(projectRoot, 'vercel', 'warm');
  });

  it('prunes the manifest when the snapshot is gone', async () => {
    await seed('stale');
    const backend = { name: 'vercel', snapshotExists: async () => false };
    expect(await probeCloudCheckpoint(backend, projectRoot, 'stale')).toEqual({
      live: false,
      pruned: true,
    });
    // The dangling manifest is gone so the next read provisions from base.
    expect(await resolveCloudCheckpoint(projectRoot, 'vercel', 'stale')).toBeNull();
  });

  it('assumes live (no prune) when the backend cannot probe', async () => {
    await seed('unprobable');
    const backend = { name: 'vercel' };
    expect(await probeCloudCheckpoint(backend, projectRoot, 'unprobable')).toEqual({
      live: true,
      pruned: false,
    });
    expect(await resolveCloudCheckpoint(projectRoot, 'vercel', 'unprobable')).not.toBeNull();
    await removeCloudCheckpointDir(projectRoot, 'vercel', 'unprobable');
  });
});

describe('isSnapshotGoneError', () => {
  it('matches a Vercel 410 APIError by status code', () => {
    expect(
      isSnapshotGoneError({ response: { status: 410 }, message: 'Status code 410 is not ok' }),
    ).toBe(true);
    expect(isSnapshotGoneError({ status: 410 })).toBe(true);
  });

  it('matches the "Snapshot expired or deleted." body message', () => {
    expect(
      isSnapshotGoneError({ json: { error: { message: 'Snapshot expired or deleted.' } } }),
    ).toBe(true);
  });

  it('matches a "snapshot not found" message', () => {
    expect(isSnapshotGoneError(new Error('snapshot not found'))).toBe(true);
  });

  it('does not match unrelated errors', () => {
    expect(isSnapshotGoneError(new Error('network timeout'))).toBe(false);
    expect(isSnapshotGoneError({ status: 500 })).toBe(false);
    expect(isSnapshotGoneError(null)).toBe(false);
    expect(isSnapshotGoneError('boom')).toBe(false);
  });
});

describe('manifest agent set', () => {
  const root = '/tmp/agentbox-agents-proj';

  // `CLOUD_CHECKPOINTS_ROOT` is computed from `homedir()` at MODULE LOAD, so
  // the `beforeAll` HOME override above does not move it — these manifests land
  // wherever the module resolved at import time. Ask the module rather than
  // reconstructing the path, so the test is correct either way, and clean up
  // after ourselves so a test run never leaves residue behind.
  const segmentDir = async (): Promise<string> => {
    const backendRoot = join(CLOUD_CHECKPOINTS_ROOT, 'vercel');
    const segment = (await readdir(backendRoot)).find((d) => d.includes('agentbox_agents_proj'));
    return join(backendRoot, segment as string);
  };

  afterAll(async () => {
    await rm(await segmentDir().catch(() => ''), { recursive: true, force: true });
  });

  it('round-trips the agent set the box was created for', async () => {
    const info = await writeCloudCheckpointManifest(root, 'vercel', 'warm', {
      snapshotName: 'snap_a',
      sourceBoxId: 'b1',
      sourceBoxName: 'box1',
      agents: ['claude'],
    });
    expect(info.manifest.agents).toEqual(['claude']);
    const found = await resolveCloudCheckpoint(root, 'vercel', 'warm');
    expect(found?.manifest.agents).toEqual(['claude']);
  });

  it('omits the field entirely when the box has no agent set', async () => {
    // Absent must mean UNKNOWN, so it has to be distinguishable from `[]`.
    // Writing `[]` would read as "captured with no agents" and could be
    // mistaken for a real value by a future consumer.
    const info = await writeCloudCheckpointManifest(root, 'vercel', 'noagents', {
      snapshotName: 'snap_b',
      sourceBoxId: 'b2',
      sourceBoxName: 'box2',
    });
    expect(info.manifest.agents).toBeUndefined();
    expect(Object.keys(info.manifest)).not.toContain('agents');
  });

  it('a legacy manifest with no agents field still loads', async () => {
    // The whole reason the schema was NOT bumped: an older manifest — and an
    // older CLI reading a newer one — must keep working, just without the
    // warning. A schema bump would have made these checkpoints disappear.
    const file = join(await segmentDir(), 'noagents', 'manifest.json');
    const raw = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    expect(raw.schema).toBe(2);
    expect(raw.agents).toBeUndefined();
    const found = await resolveCloudCheckpoint(root, 'vercel', 'noagents');
    expect(found).not.toBeNull();
    expect(found?.manifest.snapshotName).toBe('snap_b');
  });

  it('an unknown extra field does not make the manifest unreadable', async () => {
    // Guards the forward-compat assumption the no-bump decision rests on.
    const file = join(await segmentDir(), 'warm', 'manifest.json');
    const raw = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    raw.somethingFromTheFuture = { nested: true };
    await writeFile(file, JSON.stringify(raw, null, 2) + '\n', 'utf8');
    const found = await resolveCloudCheckpoint(root, 'vercel', 'warm');
    expect(found?.manifest.agents).toEqual(['claude']);
  });
});
