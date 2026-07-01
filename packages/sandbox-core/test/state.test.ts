import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BoxRecord } from '@agentbox/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  readState,
  recordBox,
  recordLastAgent,
  removeBoxRecord,
  reserveProjectIndex,
  writeState,
} from '../src/state.js';

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
      container: 'cloud:cloud001',
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

  it('records lastAgent without touching other fields', async () => {
    const box: BoxRecord = {
      id: 'a1b2c3d4',
      name: 'demo',
      container: 'agentbox-a1b2c3d4',
      image: 'agentbox/box:dev',
      workspacePath: '/tmp/ws',
      createdAt: '2026-05-12T12:00:00.000Z',
    };
    await recordBox(box, file);
    await recordLastAgent('a1b2c3d4', 'codex', file);
    let reloaded = await readState(file);
    expect(reloaded.boxes[0]?.lastAgent).toBe('codex');
    expect(reloaded.boxes[0]?.name).toBe('demo');
    // Overwrites on a subsequent launch.
    await recordLastAgent('a1b2c3d4', 'opencode', file);
    reloaded = await readState(file);
    expect(reloaded.boxes[0]?.lastAgent).toBe('opencode');
  });

  it('recordLastAgent is a no-op for an unknown box id', async () => {
    const box: BoxRecord = {
      id: 'a1b2c3d4',
      name: 'demo',
      container: 'agentbox-a1b2c3d4',
      image: 'agentbox/box:dev',
      workspacePath: '/tmp/ws',
      createdAt: '2026-05-12T12:00:00.000Z',
    };
    await recordBox(box, file);
    await recordLastAgent('does-not-exist', 'claude', file);
    const reloaded = await readState(file);
    expect(reloaded.boxes).toHaveLength(1);
    expect(reloaded.boxes[0]?.lastAgent).toBeUndefined();
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
      portlessVncAlias: 'vnc-shape.localhost',
      portlessVncUrl: 'https://vnc-shape.localhost',
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
    expect(r.docker?.portlessVncAlias).toBe('vnc-shape.localhost');
    expect(r.docker?.portlessVncUrl).toBe('https://vnc-shape.localhost');
  });

  it('cloud records do NOT get a docker shape mirrored in', async () => {
    const cloud: BoxRecord = {
      id: 'c1234567',
      name: 'cloud-shape',
      provider: 'daytona',
      container: 'cloud:sb-c1234567',
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

  it('concurrent recordBox calls do not lose records or corrupt the file', async () => {
    // Mirrors the failure mode of several parallel `agentbox create` processes
    // writing state.json at once: the unlocked read-modify-write used to drop
    // records (last writer wins) and could leave a half-overwritten file.
    const boxes: BoxRecord[] = Array.from({ length: 25 }, (_, i) => ({
      id: `box${String(i).padStart(4, '0')}`,
      name: `n${String(i)}`,
      container: `agentbox-n${String(i)}`,
      image: 'agentbox/box:dev',
      workspacePath: '/tmp/ws',
      snapshotDir: null,
      createdAt: '2026-05-12T12:00:00.000Z',
    }));
    await Promise.all(boxes.map((b) => recordBox(b, file)));

    const reloaded = await readState(file);
    expect(reloaded.boxes).toHaveLength(boxes.length);
    expect(new Set(reloaded.boxes.map((b) => b.id)).size).toBe(boxes.length);
  });

  it('concurrent record + remove stays consistent (no lost survivors)', async () => {
    const seed: BoxRecord[] = Array.from({ length: 10 }, (_, i) => ({
      id: `seed${String(i)}`,
      name: `s${String(i)}`,
      container: `agentbox-s${String(i)}`,
      image: 'agentbox/box:dev',
      workspacePath: '/tmp/ws',
      snapshotDir: null,
      createdAt: '2026-05-12T12:00:00.000Z',
    }));
    for (const b of seed) await recordBox(b, file);

    // Remove the even ids while concurrently adding new ones.
    const removals = seed.filter((_, i) => i % 2 === 0).map((b) => removeBoxRecord(b.id, file));
    const additions = Array.from({ length: 5 }, (_, i) =>
      recordBox({ ...seed[0]!, id: `new${String(i)}`, name: `x${String(i)}` }, file),
    );
    await Promise.all([...removals, ...additions]);

    const ids = new Set((await readState(file)).boxes.map((b) => b.id));
    // All odd seeds survive, all 5 new ones present, no even seeds left.
    for (const i of [1, 3, 5, 7, 9]) expect(ids.has(`seed${String(i)}`)).toBe(true);
    for (const i of [0, 1, 2, 3, 4]) expect(ids.has(`new${String(i)}`)).toBe(true);
    for (const i of [0, 2, 4, 6, 8]) expect(ids.has(`seed${String(i)}`)).toBe(false);
  });

  it('reserveProjectIndex hands out distinct indices to concurrent reservations', async () => {
    // The reservation is what makes the index race-free: each create reserves +
    // persists atomically *before* it bakes the index into its dirs, so two
    // concurrent creates in one project can't claim the same number (which would
    // otherwise force a record-vs-dir desync).
    const mk = (id: string): BoxRecord => ({
      id,
      name: id,
      container: `agentbox-${id}`,
      image: 'agentbox/box:dev',
      workspacePath: '/repo',
      createdAt: '2026-05-12T12:00:00.000Z',
    });
    const ids = ['r0', 'r1', 'r2', 'r3', 'r4'];
    const indices = await Promise.all(ids.map((id) => reserveProjectIndex(mk(id), '/repo', file)));

    // Every reservation got a distinct index, and the persisted record carries it.
    expect(new Set(indices).size).toBe(ids.length);
    expect([...indices].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
    const persisted = (await readState(file)).boxes;
    expect(persisted).toHaveLength(ids.length);
    expect(new Set(persisted.map((b) => b.projectIndex)).size).toBe(ids.length);

    // A different project has its own index space, starting at 1.
    const other = await reserveProjectIndex(mk('other1'), '/other', file);
    expect(other).toBe(1);
  });
});
