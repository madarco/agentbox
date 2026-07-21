import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeRecordingTransport } from '../src/sync/recording-transport.js';
import { seedAgentsVolume } from '../src/sync/concerns/skills.js';

describe('skills concern — seedAgentsVolume', () => {
  let hostAgents: string;
  beforeEach(async () => {
    hostAgents = await mkdtemp(join(tmpdir(), 'agentbox-agents-'));
  });
  afterEach(async () => {
    await rm(hostAgents, { recursive: true, force: true });
  });

  it('seeds the volume from host with copyUnsafeLinks + excludes unsyncable symlinks', async () => {
    await mkdir(join(hostAgents, 'skills', 'ok'), { recursive: true });
    await writeFile(join(hostAgents, 'skills', 'ok', 'SKILL.md'), 'ok');
    // Broken symlink → unsyncable → must be excluded so rsync doesn't abort.
    await symlink('/nonexistent-target', join(hostAgents, 'skills', 'broken'));

    const t = makeRecordingTransport();
    const res = await seedAgentsVolume({
      transport: t,
      volume: 'agentbox-agents-config',
      hostAgents,
      syncFromHost: true,
    });

    expect(res).toEqual({ synced: true });
    expect(t.ops).toHaveLength(1);
    const op = t.ops[0]!;
    expect(op.op).toBe('seedVolumeFromHost');
    expect(op.args.volume).toBe('agentbox-agents-config');
    expect(op.args.sources).toEqual([
      {
        hostDir: hostAgents,
        destSubpath: '',
        exclude: ['/skills/broken'],
        copyUnsafeLinks: true,
      },
    ]);
  });

  it('emits an empty-source seed (writable-chown only) when the host has no ~/.agents', async () => {
    const t = makeRecordingTransport();
    const res = await seedAgentsVolume({
      transport: t,
      volume: 'agentbox-agents-config',
      hostAgents: join(hostAgents, 'does-not-exist'),
      syncFromHost: true,
    });

    expect(res).toEqual({ synced: false });
    expect(t.ops).toEqual([
      { op: 'seedVolumeFromHost', args: { volume: 'agentbox-agents-config', sources: [] } },
    ]);
  });

  it('does not sync when syncFromHost is false (still makes the volume writable)', async () => {
    await writeFile(join(hostAgents, 'marker'), 'x');
    const t = makeRecordingTransport();
    const res = await seedAgentsVolume({
      transport: t,
      volume: 'v',
      hostAgents,
      syncFromHost: false,
    });

    expect(res).toEqual({ synced: false });
    expect(t.ops).toEqual([{ op: 'seedVolumeFromHost', args: { volume: 'v', sources: [] } }]);
  });

  it('swallows a writable-chown failure (best-effort) but propagates a sync failure', async () => {
    // No-sync branch: seedVolumeFromHost throws → swallowed, synced:false.
    const throwing = makeRecordingTransport();
    (throwing as { seedVolumeFromHost: unknown }).seedVolumeFromHost = async () => {
      throw new Error('boom');
    };
    const res = await seedAgentsVolume({
      transport: throwing,
      volume: 'v',
      hostAgents: join(hostAgents, 'nope'),
      syncFromHost: true,
    });
    expect(res).toEqual({ synced: false });

    // Sync branch: the same failure propagates (a botched skills sync is worth surfacing).
    const throwing2 = makeRecordingTransport();
    (throwing2 as { seedVolumeFromHost: unknown }).seedVolumeFromHost = async () => {
      throw new Error('boom');
    };
    await writeFile(join(hostAgents, 'real'), 'x');
    await expect(
      seedAgentsVolume({ transport: throwing2, volume: 'v', hostAgents, syncFromHost: true }),
    ).rejects.toThrow('boom');
  });

  it('rejects a transport without the persistent-volume seam', async () => {
    const noVol = makeRecordingTransport({ withVolumes: false });
    await expect(
      seedAgentsVolume({ transport: noVol, volume: 'v', hostAgents, syncFromHost: true }),
    ).rejects.toThrow(/seedVolumeFromHost/);
  });
});
