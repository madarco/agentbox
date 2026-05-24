import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BoxRecord } from '@agentbox/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readState, recordBox, removeBoxRecord, writeState } from '../src/state.js';

describe('state.ts', () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'agentbox-state-test-'));
    file = join(dir, 'state.json');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns empty state when file does not exist', async () => {
    const state = await readState(file);
    expect(state).toEqual({ version: 1, boxes: [] });
  });

  it('round-trips a single record', async () => {
    const box: BoxRecord = {
      id: 'a1b2c3d4',
      name: 'demo',
      container: 'agentbox-a1b2c3d4',
      image: 'agentbox/box:dev',
      workspacePath: '/tmp/ws',
      snapshotDir: null,
      createdAt: '2026-05-12T12:00:00.000Z',
    };
    await recordBox(box, file);

    const reloaded = await readState(file);
    // readState migrates legacy records by defaulting `provider` to 'docker'
    // and (per 7.1) backfilling the nested `docker` shape from the flat
    // Docker-specific fields. Skip the deep equality on `docker` here —
    // the dedicated 7.1 test below covers the projection.
    const reloadedBox = reloaded.boxes[0]!;
    const rest = { ...reloadedBox };
    delete rest.docker;
    expect(rest).toEqual({ ...box, provider: 'docker' });
    expect(reloadedBox.docker?.container).toBe(box.container);
  });

  it("defaults `provider` to 'docker' for records written without it", async () => {
    const legacy = {
      version: 1,
      boxes: [
        {
          id: 'legacy01',
          name: 'legacy',
          container: 'agentbox-legacy',
          image: 'agentbox/box:dev',
          workspacePath: '/tmp/ws',
          createdAt: '2026-05-12T12:00:00.000Z',
        },
      ],
    };
    await writeState(legacy as unknown as Parameters<typeof writeState>[0], file);
    const reloaded = await readState(file);
    expect(reloaded.boxes[0]?.provider).toBe('docker');
  });

  it('preserves an explicit non-docker provider on read', async () => {
    const box: BoxRecord = {
      id: 'cloud001',
      name: 'cloud-demo',
      provider: 'daytona',
      container: 'agentbox-cloud-demo',
      image: 'agentbox/box:dev',
      workspacePath: '/tmp/ws',
      createdAt: '2026-05-12T12:00:00.000Z',
    };
    await recordBox(box, file);
    const reloaded = await readState(file);
    expect(reloaded.boxes[0]?.provider).toBe('daytona');
  });

  it('replaces an existing record with the same id', async () => {
    const base: BoxRecord = {
      id: 'a1b2c3d4',
      name: 'old',
      container: 'agentbox-a1b2c3d4',
      image: 'agentbox/box:dev',
      workspacePath: '/tmp/ws',
      snapshotDir: null,
      createdAt: '2026-05-12T12:00:00.000Z',
    };
    await recordBox(base, file);
    await recordBox({ ...base, name: 'new' }, file);

    const reloaded = await readState(file);
    expect(reloaded.boxes).toHaveLength(1);
    expect(reloaded.boxes[0]?.name).toBe('new');
  });

  it('rejects malformed state', async () => {
    await writeState(
      { version: 999, boxes: [] } as unknown as Parameters<typeof writeState>[0],
      file,
    );
    await expect(readState(file)).rejects.toThrow(/unrecognized state file shape/);
  });

  it('round-trips gitWorktrees', async () => {
    const box: BoxRecord = {
      id: 'wt000001',
      name: 'wt-demo',
      container: 'agentbox-wt-demo',
      image: 'agentbox/box:dev',
      workspacePath: '/tmp/repo',
      snapshotDir: null,
      gitWorktrees: [
        {
          kind: 'root',
          hostMainRepo: '/tmp/repo',
          containerPath: '/workspace',
          gitWorktreePath: '/home/vscode/.agentbox-worktrees/agentbox_wt-demo',
          branch: 'agentbox/wt-demo',
          relPathFromWorkspace: '',
        },
        {
          kind: 'nested',
          hostMainRepo: '/tmp/repo/app',
          containerPath: '/workspace/app',
          gitWorktreePath: '/home/vscode/.agentbox-worktrees/agentbox_wt-demo--app',
          branch: 'agentbox/wt-demo--app',
          relPathFromWorkspace: 'app',
        },
      ],
      createdAt: '2026-05-14T12:00:00.000Z',
    };
    await recordBox(box, file);
    const reloaded = await readState(file);
    const reloadedBox = reloaded.boxes[0]!;
    const rest = { ...reloadedBox };
    delete rest.docker;
    expect(rest).toEqual({ ...box, provider: 'docker' });
    expect(reloadedBox.docker?.container).toBe(box.container);
  });

  it('round-trips projectRoot + projectIndex', async () => {
    const box: BoxRecord = {
      id: 'p1234567',
      name: 'p-demo',
      container: 'agentbox-p-demo',
      image: 'agentbox/box:dev',
      workspacePath: '/Users/x/repo',
      snapshotDir: null,
      projectRoot: '/Users/x/repo',
      projectIndex: 3,
      createdAt: '2026-05-14T12:00:00.000Z',
    };
    await recordBox(box, file);
    const reloaded = await readState(file);
    expect(reloaded.boxes[0]?.projectRoot).toBe('/Users/x/repo');
    expect(reloaded.boxes[0]?.projectIndex).toBe(3);
  });

  it('mirrors docker-specific fields into box.docker on write + on legacy read (7.1)', async () => {
    const box: BoxRecord = {
      id: 'd1234567',
      name: 'docker-shape',
      container: 'agentbox-docker-shape',
      image: 'agentbox/box:dev',
      workspacePath: '/tmp/ws',
      claudeConfigVolume: 'agentbox-claude-shared',
      vncHostPort: 49001,
      webHostPort: 49002,
      portlessAlias: 'shape.localhost',
      createdAt: '2026-05-12T12:00:00.000Z',
    };
    await recordBox(box, file);
    const reloaded = await readState(file);
    const r = reloaded.boxes[0]!;
    expect(r.docker?.container).toBe('agentbox-docker-shape');
    expect(r.docker?.image).toBe('agentbox/box:dev');
    expect(r.docker?.claudeConfigVolume).toBe('agentbox-claude-shared');
    expect(r.docker?.vncHostPort).toBe(49001);
    expect(r.docker?.webHostPort).toBe(49002);
    expect(r.docker?.portlessAlias).toBe('shape.localhost');
  });

  it('cloud records do NOT get a docker shape mirrored in', async () => {
    const cloud: BoxRecord = {
      id: 'c1234567',
      name: 'cloud-shape',
      provider: 'daytona',
      container: 'agentbox-cloud-c1234567',
      image: 'agentbox/box:dev',
      workspacePath: '/tmp/ws',
      cloud: { backend: 'daytona', sandboxId: 'sb-1' },
      createdAt: '2026-05-12T12:00:00.000Z',
    };
    await recordBox(cloud, file);
    const reloaded = await readState(file);
    expect(reloaded.boxes[0]?.docker).toBeUndefined();
    expect(reloaded.boxes[0]?.cloud?.sandboxId).toBe('sb-1');
  });

  it('removeBoxRecord removes by id and reports whether anything matched', async () => {
    const a: BoxRecord = {
      id: 'aaaaaaaa',
      name: 'alpha',
      container: 'agentbox-alpha',
      image: 'agentbox/box:dev',
      workspacePath: '/tmp/ws',
      snapshotDir: null,
      createdAt: '2026-05-12T12:00:00.000Z',
    };
    const b: BoxRecord = { ...a, id: 'bbbbbbbb', name: 'beta', container: 'agentbox-beta' };
    await recordBox(a, file);
    await recordBox(b, file);

    const removed = await removeBoxRecord('aaaaaaaa', file);
    expect(removed).toBe(true);

    const after = await readState(file);
    expect(after.boxes.map((r) => r.id)).toEqual(['bbbbbbbb']);

    // No-op on unknown id.
    const removedAgain = await removeBoxRecord('aaaaaaaa', file);
    expect(removedAgain).toBe(false);
  });
});
