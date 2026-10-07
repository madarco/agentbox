import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveAgentSpec } from '@agentbox/sandbox-core';
import type { AgentCliSpec } from '@agentbox/cli-kit';
import type { BoxRecord } from '@agentbox/sandbox-docker';
import { startOrAttach } from '../src/agents/command/start-attach.js';

const io = vi.hoisted(() => ({
  calls: [] as string[],
  mountedVolume: undefined as string | undefined,
  dockerInspect: { Mounts: [] },
  state: 'running',
  resolveVolume: vi.fn(),
  stage: vi.fn(),
  seed: vi.fn(),
}));

vi.mock('@agentbox/config', async (original) => ({
  ...(await original<typeof import('@agentbox/config')>()),
  loadEffectiveConfig: async () => ({ effective: { box: { resyncOnStart: false } } }),
}));
vi.mock('@agentbox/sandbox-docker', () => ({
  inspectBox: async () => ({ state: io.state, dockerInspect: io.dockerInspect }),
  recordLastAgent: async () => {},
  resolveContainerConfigVolume: (...args: unknown[]) => io.resolveVolume(...args),
  withContainerConfigVolume: (...args: unknown[]) => io.stage(...args),
  seedAgentDeclaredFiles: (...args: unknown[]) => io.seed(...args),
  startBox: async () => {
    io.calls.push('start-box');
  },
  unpauseBox: async () => {
    io.calls.push('unpause-box');
  },
}));
vi.mock('@agentbox/cli-kit', () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  log: { warn: vi.fn() },
  spinner: () => ({ start() {}, stop() {}, message() {} }),
  clampSpinnerLine: (line: string) => line,
}));
vi.mock('../src/box-ref.js', () => ({ reattachRef: () => 'box' }));
vi.mock('../src/agent-sessions.js', () => ({}));
vi.mock('../src/lib/queue/build-prompt-args.js', () => ({}));
vi.mock('../src/terminal/host.js', () => ({ hostAwareOpenIn: () => 'same' }));
vi.mock('../src/lib/resync-start.js', () => ({ maybeResyncWorkspace: async () => null }));
vi.mock('../src/commands/_attach-in.js', () => ({ resolveAttachInOption: () => undefined }));
vi.mock('../src/commands/_cloud-attach.js', () => ({}));
vi.mock('../src/commands/_errors.js', () => ({}));
vi.mock('../src/provider/registry.js', () => ({}));
vi.mock('../src/session-teleport/index.js', () => ({}));

const box = {
  id: 'box',
  name: 'box',
  container: 'test-box',
  image: 'test-image',
  workspacePath: '/tmp/workspace',
} as BoxRecord;

function agent(id: string) {
  const runtime = {
    cliOverrides: () => ({}),
    sessionNameOf: () => id,
    sessionInfo: vi.fn(async () => ({ running: false })),
    offerDockerLogin: vi.fn(async () => {}),
    ensureInstalled: vi.fn(async () => {
      io.calls.push('install');
    }),
    resolveConfigVolume: vi.fn(() => (id === 'claude' ? 'agentbox-claude-config' : undefined)),
    ensureVolume: vi.fn(async () => {
      io.calls.push('sync');
    }),
    startSession: vi.fn(async () => {
      io.calls.push('session');
    }),
  };
  const hooks = {
    afterVolumeSync: vi.fn(async () => {
      io.calls.push('volume-hook');
    }),
    afterConfigSync: vi.fn(async () => {
      io.calls.push('live-hook');
    }),
  };
  const spec = {
    id,
    spec: resolveAgentSpec(id),
    runtime,
    hooks,
    text: { syncConfigLabel: id },
    attachWrapped: vi.fn(),
  } as unknown as AgentCliSpec;
  return { spec, runtime, hooks };
}

beforeEach(() => {
  io.calls = [];
  io.mountedVolume = undefined;
  io.state = 'running';
  io.resolveVolume.mockReset().mockImplementation(() => io.mountedVolume);
  io.seed.mockReset().mockImplementation(async () => {
    io.calls.push('seed');
  });
  io.stage
    .mockReset()
    .mockImplementation(async (_opts, prepare: (volume: string) => Promise<unknown>) => {
      io.calls.push('stage');
      const result = await prepare('temporary-volume');
      io.calls.push('copy-back');
      return result;
    });
});

describe.each(['codex', 'opencode', 'pi', 'claude'])('%s startup configuration', (id) => {
  it('syncs an unmounted config before launching, including Claude’s shared-volume fallback', async () => {
    const { spec, runtime, hooks } = agent(id);
    await startOrAttach(spec, box, [], { attach: false });
    expect(io.calls).toEqual([
      'install',
      'stage',
      'sync',
      'seed',
      'volume-hook',
      'copy-back',
      'live-hook',
      'session',
    ]);
    expect(io.resolveVolume).toHaveBeenCalledWith(
      io.dockerInspect,
      spec.spec.staticPaths[0]!.boxDir,
    );
    expect(runtime.ensureVolume).toHaveBeenCalledWith(
      { volume: 'temporary-volume' },
      { syncFromHost: true, image: box.image, hostWorkspace: box.workspacePath },
    );
    expect(hooks.afterConfigSync).toHaveBeenCalledWith(
      box,
      expect.objectContaining({ volume: undefined }),
    );
    expect(runtime.resolveConfigVolume).not.toHaveBeenCalled();
  });

  it('keeps host config untouched on attach/--no-sync-config while installing box-owned seeds', async () => {
    const { spec, runtime } = agent(id);
    await startOrAttach(spec, box, [], { attach: false, syncConfig: false });
    expect(runtime.ensureVolume).not.toHaveBeenCalled();
    expect(io.calls).toEqual([
      'install',
      'stage',
      'seed',
      'volume-hook',
      'copy-back',
      'live-hook',
      'session',
    ]);
  });

  it('syncs an actual mounted volume directly', async () => {
    io.mountedVolume = 'mounted-volume';
    const { spec, runtime } = agent(id);
    await startOrAttach(spec, box, [], { attach: false });
    expect(io.stage).not.toHaveBeenCalled();
    expect(runtime.ensureVolume).toHaveBeenCalledWith(
      { volume: 'mounted-volume' },
      expect.any(Object),
    );
    expect(io.seed).toHaveBeenCalledWith(id, 'mounted-volume', box.image);
    expect(io.calls).toEqual(['install', 'sync', 'seed', 'volume-hook', 'live-hook', 'session']);
  });
});

it('does not sync or install under an already-running session', async () => {
  const { spec, runtime } = agent('codex');
  runtime.sessionInfo.mockResolvedValue({ running: true });
  await startOrAttach(spec, box, [], { attach: false });
  expect(io.calls).toEqual([]);
  expect(io.resolveVolume).not.toHaveBeenCalled();
});

it.each(['paused', 'stopped'])('brings a %s box up before accessing its config', async (state) => {
  io.state = state;
  await startOrAttach(agent('codex').spec, box, [], { attach: false });
  expect(io.calls[0]).toBe(state === 'paused' ? 'unpause-box' : 'start-box');
  expect(io.calls.at(-1)).toBe('session');
});

it('does not launch or copy back after failed configuration sync', async () => {
  const { spec, runtime } = agent('codex');
  runtime.ensureVolume.mockRejectedValue(new Error('sync failed'));
  await expect(startOrAttach(spec, box, [], { attach: false })).rejects.toThrow('sync failed');
  expect(runtime.startSession).not.toHaveBeenCalled();
  expect(io.calls).not.toContain('copy-back');
});

it('does not launch after failed copy-back', async () => {
  const { spec, runtime } = agent('codex');
  io.stage.mockRejectedValue(new Error('copy failed'));
  await expect(startOrAttach(spec, box, [], { attach: false })).rejects.toThrow('copy failed');
  expect(runtime.startSession).not.toHaveBeenCalled();
});

it('does not sync or launch when the inspection has no usable mount data', async () => {
  const { spec, runtime } = agent('codex');
  io.resolveVolume.mockImplementation(() => {
    throw new Error('could not inspect container config mounts');
  });
  await expect(startOrAttach(spec, box, [], { attach: false })).rejects.toThrow(
    'could not inspect container config mounts',
  );
  expect(runtime.ensureVolume).not.toHaveBeenCalled();
  expect(io.stage).not.toHaveBeenCalled();
  expect(runtime.startSession).not.toHaveBeenCalled();
});
