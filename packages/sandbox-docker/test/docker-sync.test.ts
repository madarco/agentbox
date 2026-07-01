import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SyncContext } from '@agentbox/core';

// Mock every delegated module so the facade tests assert delegation only —
// never shelling out to docker. Each mock exposes a hoisted vi.fn we inspect.
const m = vi.hoisted(() => ({
  ensureClaudeVolume: vi.fn(),
  seedSetupSkillIntoVolume: vi.fn(),
  syncClaudeCredentials: vi.fn(),
  ensureCodexVolume: vi.fn(),
  seedCodexHooks: vi.fn(),
  seedCodexAgentsOverride: vi.fn(),
  ensureAgentsVolume: vi.fn(),
  ensureOpencodeVolume: vi.fn(),
  seedOpencodePlugin: vi.fn(),
  copyHostEnvFilesToBox: vi.fn(),
  copyCarryPathsToBox: vi.fn(),
  resyncWorkspaceFromHost: vi.fn(),
  renderCarryEntries: vi.fn(),
}));

vi.mock('../src/claude.js', () => ({
  ensureClaudeVolume: m.ensureClaudeVolume,
  seedSetupSkillIntoVolume: m.seedSetupSkillIntoVolume,
}));
vi.mock('../src/claude-credentials.js', () => ({ syncClaudeCredentials: m.syncClaudeCredentials }));
vi.mock('../src/codex.js', () => ({
  ensureCodexVolume: m.ensureCodexVolume,
  seedCodexHooks: m.seedCodexHooks,
  seedCodexAgentsOverride: m.seedCodexAgentsOverride,
}));
vi.mock('../src/agents.js', () => ({ ensureAgentsVolume: m.ensureAgentsVolume }));
vi.mock('../src/opencode.js', () => ({
  ensureOpencodeVolume: m.ensureOpencodeVolume,
  seedOpencodePlugin: m.seedOpencodePlugin,
}));
vi.mock('../src/host-export.js', () => ({
  copyHostEnvFilesToBox: m.copyHostEnvFilesToBox,
  copyCarryPathsToBox: m.copyCarryPathsToBox,
}));
vi.mock('../src/in-box-git.js', () => ({ resyncWorkspaceFromHost: m.resyncWorkspaceFromHost }));
vi.mock('@agentbox/sandbox-core', () => ({ renderCarryEntries: m.renderCarryEntries }));

import { makeDockerSync } from '../src/sync/docker-sync.js';

const logs: string[] = [];
function ctx(overrides: Partial<SyncContext> = {}): SyncContext {
  return {
    boxName: 'demo',
    boxId: 'id123',
    provider: 'docker',
    hostWorkspace: '/host/ws',
    projectRoot: '/host/ws',
    boxWorkspace: '/workspace',
    hostHome: '/host/home',
    onLog: (line: string) => logs.push(line),
    ...overrides,
  };
}

beforeEach(() => {
  for (const fn of Object.values(m)) fn.mockReset();
  logs.length = 0;
  // Sensible defaults so awaited results don't blow up.
  m.ensureClaudeVolume.mockResolvedValue({ created: false, synced: false });
  m.seedSetupSkillIntoVolume.mockResolvedValue({ seeded: false });
  m.syncClaudeCredentials.mockResolvedValue({ direction: 'noop', volumeHasCredentials: false });
  m.ensureCodexVolume.mockResolvedValue({ created: false, synced: false });
  m.seedCodexHooks.mockResolvedValue({ seeded: false });
  m.seedCodexAgentsOverride.mockResolvedValue({ seeded: false });
  m.ensureAgentsVolume.mockResolvedValue({ created: false, synced: false });
  m.ensureOpencodeVolume.mockResolvedValue({ created: false, synced: false });
  m.seedOpencodePlugin.mockResolvedValue({ seeded: false });
  m.copyHostEnvFilesToBox.mockResolvedValue({ copied: 0 });
  m.copyCarryPathsToBox.mockResolvedValue({ copied: 0, errors: [], applied: [] });
  m.resyncWorkspaceFromHost.mockResolvedValue([]);
  m.renderCarryEntries.mockImplementation((entries: unknown) => Promise.resolve(entries));
});

describe('makeDockerSync.resyncWorkspace', () => {
  it('short-circuits empty worktrees without touching the container', async () => {
    const sync = makeDockerSync({ container: 'box1' });
    const res = await sync.resyncWorkspace(ctx(), []);
    expect(res).toEqual({ repos: [], hadConflicts: false });
    expect(m.resyncWorkspaceFromHost).not.toHaveBeenCalled();
  });

  it('delegates non-empty worktrees and reports no conflicts on a clean merge', async () => {
    m.resyncWorkspaceFromHost.mockResolvedValue([
      { containerPath: '/workspace', mergeConflicts: [], overlaySkipped: [] },
    ]);
    const sync = makeDockerSync({ container: 'box1' });
    const wt = [{ containerPath: '/workspace', hostMainRepo: '/host/ws', branch: 'agentbox/demo' }];
    const res = await sync.resyncWorkspace(ctx(), wt as never);
    expect(m.resyncWorkspaceFromHost).toHaveBeenCalledWith({
      container: 'box1',
      worktrees: wt,
      onLog: expect.any(Function),
    });
    expect(res.hadConflicts).toBe(false);
  });

  it('reports hadConflicts when a repo kept the box version', async () => {
    m.resyncWorkspaceFromHost.mockResolvedValue([
      { containerPath: '/workspace', mergeConflicts: ['a.ts'], overlaySkipped: [] },
    ]);
    const sync = makeDockerSync({ container: 'box1' });
    const res = await sync.resyncWorkspace(ctx(), [{ containerPath: '/workspace' }] as never);
    expect(res.hadConflicts).toBe(true);
  });
});

describe('makeDockerSync — simple ops', () => {
  it('seedEnvFiles delegates to copyHostEnvFilesToBox', async () => {
    m.copyHostEnvFilesToBox.mockResolvedValue({ copied: 3 });
    const sync = makeDockerSync({ container: 'box1' });
    const res = await sync.seedEnvFiles(ctx(), ['.env']);
    expect(m.copyHostEnvFilesToBox).toHaveBeenCalledWith({
      container: 'box1',
      workspaceDir: '/host/ws',
      patterns: ['.env'],
      onLog: expect.any(Function),
    });
    expect(res).toEqual({ copied: 3 });
  });

  it('applyCarry renders then copies, threading the ctx identity', async () => {
    const entries = [{ rawSrc: '~/x', absSrc: '/host/x' }];
    m.copyCarryPathsToBox.mockResolvedValue({ copied: 1, errors: [], applied: [{ src: 'a', dest: 'b', bytes: 1 }] });
    const sync = makeDockerSync({ container: 'box1' });
    const res = await sync.applyCarry(ctx(), entries as never);
    expect(m.renderCarryEntries).toHaveBeenCalledWith(
      entries,
      { name: 'demo', id: 'id123', kind: 'docker', hostWorkspace: '/host/ws', projectRoot: '/host/ws' },
      expect.any(Function),
    );
    expect(m.copyCarryPathsToBox).toHaveBeenCalledWith({
      container: 'box1',
      entries,
      onLog: expect.any(Function),
    });
    expect(res.copied).toBe(1);
  });

  it('seedGitIdentity and extractCredentials are documented no-ops', async () => {
    const sync = makeDockerSync({ container: 'box1' });
    await expect(sync.seedGitIdentity(ctx())).resolves.toBeUndefined();
    await expect(sync.extractCredentials(ctx())).resolves.toEqual([]);
  });
});

const createHandle = {
  container: 'box1',
  image: 'agentbox/box:dev',
  claudeIsolate: false,
  claudeSpec: { volume: 'agentbox-claude-config' },
};

describe('makeDockerSync.seedCredentials', () => {
  it('delegates to syncClaudeCredentials with the spec + isolate + image', async () => {
    const sync = makeDockerSync(createHandle);
    await sync.seedCredentials(ctx());
    expect(m.syncClaudeCredentials).toHaveBeenCalledWith(
      { volume: 'agentbox-claude-config' },
      { image: 'agentbox/box:dev', isolate: false },
    );
  });

  it('logs the extracted direction', async () => {
    m.syncClaudeCredentials.mockResolvedValue({ direction: 'extracted', volumeHasCredentials: true });
    const sync = makeDockerSync(createHandle);
    await sync.seedCredentials(ctx());
    expect(logs).toContain('extracted box claude credentials to host backup');
  });

  it('throws when built without a create-time handle', async () => {
    const sync = makeDockerSync({ container: 'box1' });
    await expect(sync.seedCredentials(ctx())).rejects.toThrow(/create-time handle/);
  });
});

describe('makeDockerSync.seedAgentConfig', () => {
  it('always seeds the claude volume + setup skill', async () => {
    const sync = makeDockerSync(createHandle);
    await sync.seedAgentConfig(ctx());
    expect(m.ensureClaudeVolume).toHaveBeenCalledWith(
      { volume: 'agentbox-claude-config' },
      { syncFromHost: true, image: 'agentbox/box:dev', hostWorkspace: '/host/ws' },
    );
    expect(m.seedSetupSkillIntoVolume).toHaveBeenCalledWith('agentbox-claude-config', 'agentbox/box:dev');
    // No codex/agents/opencode spec ⇒ those tools skipped.
    expect(m.ensureCodexVolume).not.toHaveBeenCalled();
    expect(m.ensureAgentsVolume).not.toHaveBeenCalled();
    expect(m.ensureOpencodeVolume).not.toHaveBeenCalled();
  });

  it('seeds codex/agents/opencode when their specs are present, in order', async () => {
    const order: string[] = [];
    m.ensureClaudeVolume.mockImplementation(() => { order.push('claude'); return Promise.resolve({ created: false, synced: false }); });
    m.ensureCodexVolume.mockImplementation(() => { order.push('codex'); return Promise.resolve({ created: false, synced: false }); });
    m.ensureAgentsVolume.mockImplementation(() => { order.push('agents'); return Promise.resolve({ created: false, synced: false }); });
    m.ensureOpencodeVolume.mockImplementation(() => { order.push('opencode'); return Promise.resolve({ created: false, synced: false }); });
    const sync = makeDockerSync({
      ...createHandle,
      codexSpec: { volume: 'agentbox-codex' } as never,
      agentsSpec: { volume: 'agentbox-agents' } as never,
      opencodeSpec: { volume: 'agentbox-opencode' } as never,
    });
    await sync.seedAgentConfig(ctx());
    expect(order).toEqual(['claude', 'codex', 'agents', 'opencode']);
    expect(m.seedCodexAgentsOverride).toHaveBeenCalledWith('agentbox-codex', 'agentbox/box:dev');
    expect(m.seedOpencodePlugin).toHaveBeenCalledWith('agentbox-opencode', 'agentbox/box:dev');
  });

  it('throws when built without a create-time handle', async () => {
    const sync = makeDockerSync({ container: 'box1' });
    await expect(sync.seedAgentConfig(ctx())).rejects.toThrow(/create-time handle/);
  });
});
