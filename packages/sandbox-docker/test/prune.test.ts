import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoxRecord, StateFile } from '../src/state.js';

// pruneBoxes reads/writes STATE_FILE, which is resolved against $HOME at module
// load time. To isolate, we redirect HOME, vi.resetModules so the next import
// re-evaluates state.ts with the new HOME, then dynamic-import everything.

const mkBox = (id: string, container: string): BoxRecord => ({
  id,
  name: id,
  container,
  image: 'agentbox/box:dev',
  workspacePath: '/tmp/ws',
  lowerPath: '/tmp/ws',
  upperVolume: `agentbox-upper-${id}`,
  snapshotDir: null,
  createdAt: '2026-05-12T00:00:00.000Z',
});

describe('pruneBoxes', () => {
  let dir: string;
  const originalHome = process.env['HOME'];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'agentbox-prune-test-'));
    process.env['HOME'] = dir;
    vi.resetModules();
  });

  afterEach(async () => {
    vi.resetModules();
    vi.doUnmock('../src/docker.js');
    process.env['HOME'] = originalHome;
    await rm(dir, { recursive: true, force: true });
  });

  async function seed(state: StateFile): Promise<void> {
    const { writeState, STATE_FILE } = await import('../src/state.js');
    await writeState(state, STATE_FILE);
  }

  it('returns dryRun=true and removes nothing when --dry-run set', async () => {
    vi.doMock('../src/docker.js', async () => {
      const actual = await vi.importActual<typeof import('../src/docker.js')>('../src/docker.js');
      return {
        ...actual,
        inspectContainerStatus: vi.fn(async () => 'missing'),
        listAgentboxContainers: vi.fn(async () => []),
        listAgentboxVolumes: vi.fn(async () => []),
        removeContainer: vi.fn(async () => undefined),
        removeVolume: vi.fn(async () => undefined),
      };
    });

    await seed({
      version: 1,
      boxes: [mkBox('aaaaaaaa', 'agentbox-aaaaaaaa'), mkBox('bbbbbbbb', 'agentbox-bbbbbbbb')],
    });

    const { pruneBoxes } = await import('../src/lifecycle.js');
    const result = await pruneBoxes({ dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(result.removedRecords.sort()).toEqual(['aaaaaaaa', 'bbbbbbbb']);

    const { readState, STATE_FILE } = await import('../src/state.js');
    const after = await readState(STATE_FILE);
    expect(after.boxes).toHaveLength(2);
  });

  it('drops only the missing-container records in default mode', async () => {
    vi.doMock('../src/docker.js', async () => {
      const actual = await vi.importActual<typeof import('../src/docker.js')>('../src/docker.js');
      return {
        ...actual,
        inspectContainerStatus: vi.fn(async (name: string) =>
          name === 'agentbox-live' ? 'running' : 'missing',
        ),
        listAgentboxContainers: vi.fn(async () => []),
        listAgentboxVolumes: vi.fn(async () => []),
        removeContainer: vi.fn(async () => undefined),
        removeVolume: vi.fn(async () => undefined),
      };
    });

    await seed({
      version: 1,
      boxes: [mkBox('11111111', 'agentbox-live'), mkBox('22222222', 'agentbox-gone')],
    });

    const { pruneBoxes } = await import('../src/lifecycle.js');
    const result = await pruneBoxes();

    expect(result.removedRecords).toEqual(['22222222']);
    expect(result.removedContainers).toEqual([]);

    const { readState, STATE_FILE } = await import('../src/state.js');
    const after = await readState(STATE_FILE);
    expect(after.boxes.map((b) => b.id)).toEqual(['11111111']);
  });

  it('with --all, also flags orphan agentbox-* containers/volumes', async () => {
    vi.doMock('../src/docker.js', async () => {
      const actual = await vi.importActual<typeof import('../src/docker.js')>('../src/docker.js');
      return {
        ...actual,
        inspectContainerStatus: vi.fn(async () => 'running'),
        listAgentboxContainers: vi.fn(async () => ['agentbox-live', 'agentbox-orphan']),
        listAgentboxVolumes: vi.fn(async () => [
          'agentbox-upper-11111111',
          // Back-compat guard: the per-box nm volume was removed, but a box
          // created before that still has agentbox-nm-<id> on disk. The prune
          // allowlist reconstructs the name for surviving boxes so it is NOT
          // reaped even though BoxRecord no longer carries the field.
          'agentbox-nm-11111111',
          'agentbox-orphan-vol',
        ]),
        removeContainer: vi.fn(async () => undefined),
        removeVolume: vi.fn(async () => undefined),
      };
    });

    await seed({
      version: 1,
      boxes: [mkBox('11111111', 'agentbox-live')],
    });

    const { pruneBoxes } = await import('../src/lifecycle.js');
    const result = await pruneBoxes({ all: true, dryRun: true });

    expect(result.removedContainers).toEqual(['agentbox-orphan']);
    expect(result.removedVolumes).toEqual(['agentbox-orphan-vol']);
  });

  it('with --all, reaps an orphan legacy agentbox-nm volume with no surviving box', async () => {
    vi.doMock('../src/docker.js', async () => {
      const actual = await vi.importActual<typeof import('../src/docker.js')>('../src/docker.js');
      return {
        ...actual,
        inspectContainerStatus: vi.fn(async () => 'running'),
        listAgentboxContainers: vi.fn(async () => ['agentbox-live']),
        listAgentboxVolumes: vi.fn(async () => [
          'agentbox-upper-11111111',
          // No surviving box owns id 99999999, so this legacy nm volume is
          // not allowlisted and must be reaped by the generic agentbox-* sweep.
          'agentbox-nm-99999999',
        ]),
        removeContainer: vi.fn(async () => undefined),
        removeVolume: vi.fn(async () => undefined),
      };
    });

    await seed({
      version: 1,
      boxes: [mkBox('11111111', 'agentbox-live')],
    });

    const { pruneBoxes } = await import('../src/lifecycle.js');
    const result = await pruneBoxes({ all: true, dryRun: true });

    expect(result.removedVolumes).toEqual(['agentbox-nm-99999999']);
  });
});
