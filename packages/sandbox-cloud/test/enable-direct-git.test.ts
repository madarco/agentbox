import { afterEach, describe, expect, it } from 'vitest';
import type {
  BoxRecord,
  CloudBackend,
  CloudExecResult,
  CloudHandle,
  CloudPreviewUrl,
  CloudState,
  ResolvedCarryEntry,
} from '@agentbox/core';
import { readState, removeBoxRecord } from '@agentbox/sandbox-core';
import { createCloudProvider } from '../src/cloud-provider.js';

// enableDirectGit persists via recordBox → the real ~/.agentbox/state.json
// (STATE_FILE is frozen from homedir() at module load, so $HOME can't isolate
// it). Use a clearly-fake box id and scrub just that entry afterwards.
const TEST_ID = 'test-enable-direct-git-xyz';

afterEach(async () => {
  await removeBoxRecord(TEST_ID).catch(() => {});
});

function makeBackend(execCalls: string[]): CloudBackend {
  return {
    name: 'test-backend',
    provision: async () => ({ sandboxId: 'sb-1' }),
    get: async () => null,
    start: async () => {},
    stop: async () => {},
    pause: async () => {},
    resume: async () => {},
    destroy: async () => {},
    state: async (): Promise<CloudState> => 'running',
    exec: async (_h: CloudHandle, cmd: string): Promise<CloudExecResult> => {
      execCalls.push(cmd);
      return { exitCode: 0, stdout: '', stderr: '' };
    },
    uploadFile: async () => {},
    downloadFile: async () => {},
    listFiles: async () => [],
    previewUrl: async (_h: CloudHandle, port: number): Promise<CloudPreviewUrl> => ({
      url: `https://${String(port)}.example`,
    }),
  };
}

function makeBox(): BoxRecord {
  return {
    id: TEST_ID,
    name: 'test-directgit-box',
    provider: 'test-backend',
    workspacePath: '/tmp/does-not-matter',
    cloud: { backend: 'test-backend', sandboxId: 'sb-1' },
  } as unknown as BoxRecord;
}

// The carry upload tars a nonexistent src → uploadCarryPaths records a per-entry
// error but does not throw, so the seed + env-flip + persist still run. We
// assert on those observable effects.
const ENTRIES: ResolvedCarryEntry[] = [
  {
    rawSrc: '~/.config/agentbox/git-direct-mode',
    rawDest: '~/.config/agentbox/git-direct-mode',
    absSrc: '/nonexistent/git-direct-mode',
    absDest: '/home/vscode/.config/agentbox/git-direct-mode',
    kind: 'file',
    mode: 0o600,
    user: 1000,
    optional: false,
  } as unknown as ResolvedCarryEntry,
];

describe('provider.enableDirectGit', () => {
  it('seeds git config, flips AGENTBOX_GIT_DIRECT in box.env, and persists gitPushMode=direct', async () => {
    const execCalls: string[] = [];
    const provider = createCloudProvider(makeBackend(execCalls));

    await provider.enableDirectGit!(makeBox(), ENTRIES, { hostRepo: '/tmp/does-not-matter' });

    // The box env flip ran (idempotent AGENTBOX_GIT_DIRECT append into box.env).
    const flip = execCalls.find((c) => c.includes('AGENTBOX_GIT_DIRECT'));
    expect(flip, 'expected an exec that sets AGENTBOX_GIT_DIRECT').toBeTruthy();
    expect(flip).toContain('/etc/agentbox/box.env');

    // seedGitCredentials issued the git-config script.
    expect(execCalls.some((c) => c.includes('git config'))).toBe(true);

    // The record persisted gitPushMode=direct.
    const state = await readState();
    expect(state.boxes.find((b) => b.id === TEST_ID)?.cloud?.gitPushMode).toBe('direct');
  });

  it('wires enableDirectGit onto every cloud provider (CLI guards on it for docker)', () => {
    expect(typeof createCloudProvider(makeBackend([])).enableDirectGit).toBe('function');
  });
});
