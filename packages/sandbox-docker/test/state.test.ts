import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readState, recordBox, removeBoxRecord, writeState, type BoxRecord } from '../src/state.js';

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
      lowerPath: '/tmp/ws',
      upperVolume: 'agentbox-upper-a1b2c3d4',
      nodeModulesVolume: 'agentbox-nm-a1b2c3d4',
      snapshotDir: null,
      createdAt: '2026-05-12T12:00:00.000Z',
    };
    await recordBox(box, file);

    const reloaded = await readState(file);
    expect(reloaded.boxes).toEqual([box]);
  });

  it('replaces an existing record with the same id', async () => {
    const base: BoxRecord = {
      id: 'a1b2c3d4',
      name: 'old',
      container: 'agentbox-a1b2c3d4',
      image: 'agentbox/box:dev',
      workspacePath: '/tmp/ws',
      lowerPath: '/tmp/ws',
      upperVolume: 'agentbox-upper-a1b2c3d4',
      nodeModulesVolume: 'agentbox-nm-a1b2c3d4',
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
      lowerPath: '/tmp/repo/.worktree',
      upperVolume: 'agentbox-upper-wt000001',
      nodeModulesVolume: 'agentbox-nm-wt000001',
      snapshotDir: null,
      gitWorktrees: [
        {
          kind: 'root',
          hostMainRepo: '/tmp/repo',
          hostWorktreeDir: '/tmp/box/worktrees/root',
          containerPath: '/workspace',
          branch: 'agentbox/wt-demo',
          relPathFromWorkspace: '',
        },
        {
          kind: 'nested',
          hostMainRepo: '/tmp/repo/app',
          hostWorktreeDir: '/tmp/box/worktrees/app',
          containerPath: '/workspace/app',
          branch: 'agentbox/wt-demo--app',
          relPathFromWorkspace: 'app',
        },
      ],
      createdAt: '2026-05-14T12:00:00.000Z',
    };
    await recordBox(box, file);
    const reloaded = await readState(file);
    expect(reloaded.boxes).toEqual([box]);
  });

  it('round-trips projectRoot + projectIndex', async () => {
    const box: BoxRecord = {
      id: 'p1234567',
      name: 'p-demo',
      container: 'agentbox-p-demo',
      image: 'agentbox/box:dev',
      workspacePath: '/Users/x/repo',
      lowerPath: '/Users/x/repo',
      upperVolume: 'agentbox-upper-p1234567',
      nodeModulesVolume: 'agentbox-nm-p1234567',
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

  it('removeBoxRecord removes by id and reports whether anything matched', async () => {
    const a: BoxRecord = {
      id: 'aaaaaaaa',
      name: 'alpha',
      container: 'agentbox-alpha',
      image: 'agentbox/box:dev',
      workspacePath: '/tmp/ws',
      lowerPath: '/tmp/ws',
      upperVolume: 'agentbox-upper-aaaaaaaa',
      nodeModulesVolume: 'agentbox-nm-aaaaaaaa',
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
