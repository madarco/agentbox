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
          // Per-box claude/codex/opencode config (anonymous user; live box) —
          // allowlisted by record.{claude,codex,opencode}ConfigVolume so NOT reaped.
          'agentbox-claude-config-11111111',
          'agentbox-codex-config-11111111',
          'agentbox-opencode-config-11111111',
          // Shared codex/opencode config volumes — allowlisted unconditionally
          // (hold the user's Codex/OpenCode auth across boxes).
          'agentbox-codex-config',
          'agentbox-opencode-config',
          'agentbox-orphan-vol',
        ]),
        removeContainer: vi.fn(async () => undefined),
        removeVolume: vi.fn(async () => undefined),
        removeImage: vi.fn(async () => true),
      };
    });

    await seed({
      version: 1,
      boxes: [
        {
          ...mkBox('11111111', 'agentbox-live'),
          claudeConfigVolume: 'agentbox-claude-config-11111111',
          codexConfigVolume: 'agentbox-codex-config-11111111',
          opencodeConfigVolume: 'agentbox-opencode-config-11111111',
        },
      ],
    });

    const { pruneBoxes } = await import('../src/lifecycle.js');
    const result = await pruneBoxes({ all: true, dryRun: true });

    expect(result.removedContainers).toEqual(['agentbox-orphan']);
    // Only the orphan volume is reaped; per-box + shared codex/opencode volumes survive.
    expect(result.removedVolumes).toEqual(['agentbox-orphan-vol']);
  });

  it('with --all, reaps unreferenced checkpoint images', async () => {
    vi.doMock('../src/docker.js', async () => {
      const actual = await vi.importActual<typeof import('../src/docker.js')>('../src/docker.js');
      const { execa } = await import('execa');
      // listCheckpointImageTags shells out to `docker image ls`; stub via the
      // module barrel so the prune codepath sees our chosen tag list.
      return {
        ...actual,
        inspectContainerStatus: vi.fn(async () => 'running'),
        listAgentboxContainers: vi.fn(async () => ['agentbox-live']),
        listAgentboxVolumes: vi.fn(async () => []),
        removeContainer: vi.fn(async () => undefined),
        removeVolume: vi.fn(async () => undefined),
        removeImage: vi.fn(async () => true),
        _execa: execa,
      };
    });

    // Stub `execa` so listCheckpointImageTags' `docker image ls` returns a
    // controlled tag list. The shape is the same one-line-per-tag stdout the
    // real command produces.
    vi.doMock('execa', async () => {
      const actual = await vi.importActual<typeof import('execa')>('execa');
      return {
        ...actual,
        execa: vi.fn(async (...args: unknown[]) => {
          const cmd = args[0] as string;
          const argv = (args[1] ?? []) as string[];
          if (
            cmd === 'docker' &&
            argv[0] === 'image' &&
            argv[1] === 'ls' &&
            (argv[argv.length - 1] ?? '').startsWith('agentbox-ckpt-')
          ) {
            return {
              exitCode: 0,
              stdout:
                'agentbox-ckpt-hashA:keep\nagentbox-ckpt-hashB:orphan\nagentbox-ckpt-hashC:kept-by-manifest\n',
              stderr: '',
            };
          }
          // Fall through to the real execa for anything else (e.g. relay
          // sweep doesn't fire in dryRun=true).
          return actual.execa(cmd, argv as readonly string[]);
        }),
      };
    });

    // Seed a checkpoint manifest on disk so pruneBoxes sees an image the
    // user wants kept even when no surviving box references it. This is the
    // post-destroy "checkpoint outlives its source box" case.
    const { mkdir, writeFile } = await import('node:fs/promises');
    const keepDir = join(dir, '.agentbox', 'checkpoints', 'hashC', 'kept-by-manifest');
    await mkdir(keepDir, { recursive: true });
    await writeFile(
      join(keepDir, 'manifest.json'),
      JSON.stringify({
        schema: 2,
        name: 'kept-by-manifest',
        type: 'layered',
        image: 'agentbox-ckpt-hashC:kept-by-manifest',
        parents: [],
        base: 'workspace',
        sourceBoxId: 'srcid',
        sourceBoxName: 'srcname',
        createdAt: '2026-05-12T00:00:00.000Z',
      }) + '\n',
      'utf8',
    );

    await seed({
      version: 1,
      boxes: [
        {
          ...mkBox('11111111', 'agentbox-live'),
          checkpointImage: 'agentbox-ckpt-hashA:keep',
        },
      ],
    });

    const { pruneBoxes } = await import('../src/lifecycle.js');
    const result = await pruneBoxes({ all: true, dryRun: true });

    expect(result.removedCheckpointImages).toEqual(['agentbox-ckpt-hashB:orphan']);
    // surviving-box pin
    expect(result.removedCheckpointImages).not.toContain('agentbox-ckpt-hashA:keep');
    // manifest pin (the regression this test was rewritten to lock in)
    expect(result.removedCheckpointImages).not.toContain('agentbox-ckpt-hashC:kept-by-manifest');
  });
});
