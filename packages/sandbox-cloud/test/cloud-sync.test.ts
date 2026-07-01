import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CloudBackend, CloudHandle, SyncContext } from '@agentbox/core';

// Mock every delegated module so the facade tests assert delegation only.
const m = vi.hoisted(() => ({
  ensureAgentHomeDirsOwned: vi.fn(),
  extractCloudAgentCredentials: vi.fn(),
  refreshAgentCredentialsBackup: vi.fn(),
  seedAgentVolumesIfFresh: vi.fn(),
  seedOpencodeModelState: vi.fn(),
  seedDynamicConfig: vi.fn(),
  ensureCodexAgentsOverride: vi.fn(),
  seedClaudeJsonAtCreate: vi.fn(),
  seedGitIdentity: vi.fn(),
  uploadEnvFiles: vi.fn(),
  uploadCarryPaths: vi.fn(),
  renderCarryEntries: vi.fn(),
}));

vi.mock('../src/sync/agent-credentials.js', () => ({
  ensureAgentHomeDirsOwned: m.ensureAgentHomeDirsOwned,
  extractCloudAgentCredentials: m.extractCloudAgentCredentials,
  refreshAgentCredentialsBackup: m.refreshAgentCredentialsBackup,
  seedAgentVolumesIfFresh: m.seedAgentVolumesIfFresh,
  seedOpencodeModelState: m.seedOpencodeModelState,
}));
vi.mock('../src/sync/dynamic-sync.js', () => ({ seedDynamicConfig: m.seedDynamicConfig }));
vi.mock('../src/sync/codex-agents-override.js', () => ({ ensureCodexAgentsOverride: m.ensureCodexAgentsOverride }));
vi.mock('../src/sync/claude-json-overlay.js', () => ({ seedClaudeJsonAtCreate: m.seedClaudeJsonAtCreate }));
vi.mock('../src/sync/git-identity.js', () => ({ seedGitIdentity: m.seedGitIdentity }));
vi.mock('../src/sync/env-files.js', () => ({ uploadEnvFiles: m.uploadEnvFiles }));
vi.mock('../src/sync/carry.js', () => ({ uploadCarryPaths: m.uploadCarryPaths }));
vi.mock('@agentbox/sandbox-core', () => ({ renderCarryEntries: m.renderCarryEntries }));

import { makeCloudSync } from '../src/sync/cloud-sync.js';

const backend = { name: 'vercel' } as unknown as CloudBackend;
const handle: CloudHandle = { sandboxId: 'sb-1' };

const logs: string[] = [];
function ctx(overrides: Partial<SyncContext> = {}): SyncContext {
  return {
    boxName: 'demo',
    boxId: 'id123',
    provider: 'cloud',
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
  m.ensureAgentHomeDirsOwned.mockResolvedValue(undefined);
  m.extractCloudAgentCredentials.mockResolvedValue(['claude']);
  m.refreshAgentCredentialsBackup.mockResolvedValue(undefined);
  m.seedAgentVolumesIfFresh.mockResolvedValue(undefined);
  m.seedOpencodeModelState.mockResolvedValue(undefined);
  m.seedDynamicConfig.mockResolvedValue(undefined);
  m.ensureCodexAgentsOverride.mockResolvedValue(undefined);
  m.seedClaudeJsonAtCreate.mockResolvedValue(undefined);
  m.seedGitIdentity.mockResolvedValue(undefined);
  m.uploadEnvFiles.mockResolvedValue({ copied: 0 });
  m.uploadCarryPaths.mockResolvedValue({ copied: 0, errors: [], applied: [] });
  m.renderCarryEntries.mockImplementation((entries: unknown) => Promise.resolve(entries));
});

describe('makeCloudSync.seedCredentials', () => {
  it('refreshes backups then seeds the given agents', async () => {
    const sync = makeCloudSync(backend, handle, { agents: ['claude', 'codex'] });
    await sync.seedCredentials(ctx());
    expect(m.refreshAgentCredentialsBackup).toHaveBeenCalledTimes(1);
    expect(m.seedAgentVolumesIfFresh).toHaveBeenCalledWith(backend, handle, {
      agents: ['claude', 'codex'],
      hostWorkspace: '/host/ws',
      onLog: expect.any(Function),
    });
  });

  it('refreshes backups but skips the seed when no agents have a volume', async () => {
    const sync = makeCloudSync(backend, handle, { agents: [] });
    await sync.seedCredentials(ctx());
    expect(m.refreshAgentCredentialsBackup).toHaveBeenCalledTimes(1);
    expect(m.seedAgentVolumesIfFresh).not.toHaveBeenCalled();
  });
});

describe('makeCloudSync.seedAgentConfig', () => {
  it('runs the runtime config seeds in create order', async () => {
    const order: string[] = [];
    m.ensureAgentHomeDirsOwned.mockImplementation(() => { order.push('ownership'); return Promise.resolve(); });
    m.ensureCodexAgentsOverride.mockImplementation(() => { order.push('codex'); return Promise.resolve(); });
    m.seedOpencodeModelState.mockImplementation(() => { order.push('opencode'); return Promise.resolve(); });
    m.seedClaudeJsonAtCreate.mockImplementation(() => { order.push('claudeJson'); return Promise.resolve(); });
    m.seedDynamicConfig.mockImplementation(() => { order.push('dynamic'); return Promise.resolve(); });
    const sync = makeCloudSync(backend, handle);
    await sync.seedAgentConfig(ctx());
    expect(order).toEqual(['ownership', 'codex', 'opencode', 'claudeJson', 'dynamic']);
    expect(m.seedClaudeJsonAtCreate).toHaveBeenCalledWith(backend, handle, {
      hostWorkspace: '/host/ws',
      onLog: expect.any(Function),
    });
  });
});

describe('makeCloudSync — remaining ops', () => {
  it('seedGitIdentity delegates with the host repo', async () => {
    const sync = makeCloudSync(backend, handle);
    await sync.seedGitIdentity(ctx());
    expect(m.seedGitIdentity).toHaveBeenCalledWith(backend, handle, {
      hostRepo: '/host/ws',
      onLog: expect.any(Function),
    });
  });

  it('extractCredentials delegates to extractCloudAgentCredentials', async () => {
    const sync = makeCloudSync(backend, handle);
    const res = await sync.extractCredentials(ctx());
    expect(m.extractCloudAgentCredentials).toHaveBeenCalledWith(backend, handle);
    expect(res).toEqual(['claude']);
  });

  it('seedEnvFiles delegates to uploadEnvFiles with the patterns', async () => {
    m.uploadEnvFiles.mockResolvedValue({ copied: 2 });
    const sync = makeCloudSync(backend, handle);
    const res = await sync.seedEnvFiles(ctx(), ['.env', 'secrets.toml']);
    expect(m.uploadEnvFiles).toHaveBeenCalledWith({
      backend,
      handle,
      workspacePath: '/host/ws',
      files: ['.env', 'secrets.toml'],
      workspaceDir: '/workspace',
      onLog: expect.any(Function),
    });
    expect(res).toEqual({ copied: 2 });
  });

  it('applyCarry renders then uploads', async () => {
    const entries = [{ rawSrc: '~/x', absSrc: '/host/x' }];
    m.uploadCarryPaths.mockResolvedValue({ copied: 1, errors: [], applied: [{ src: 'a', dest: 'b', bytes: 1 }] });
    const sync = makeCloudSync(backend, handle);
    const res = await sync.applyCarry(ctx(), entries as never);
    expect(m.renderCarryEntries).toHaveBeenCalledWith(
      entries,
      { name: 'demo', id: 'id123', kind: 'cloud', hostWorkspace: '/host/ws', projectRoot: '/host/ws' },
      expect.any(Function),
    );
    expect(m.uploadCarryPaths).toHaveBeenCalledWith({
      backend,
      handle,
      entries,
      onLog: expect.any(Function),
    });
    expect(res.copied).toBe(1);
  });

  it('resyncWorkspace short-circuits when there are no worktrees', async () => {
    const sync = makeCloudSync(backend, handle);
    await expect(sync.resyncWorkspace(ctx(), [])).resolves.toEqual({ repos: [], hadConflicts: false });
  });
});
