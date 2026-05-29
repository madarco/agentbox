import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Mock the SDK loader so provision never touches the real @vercel/sandbox.
const mocks = vi.hoisted(() => ({ create: vi.fn(), get: vi.fn() }));
vi.mock('../src/sdk.js', () => ({
  resolveCredentials: () => ({}),
  ensureFreshCredentials: () => Promise.resolve(),
  Sandbox: { create: mocks.create, get: mocks.get },
  Snapshot: { get: vi.fn() },
}));

// A base snapshot exists, so provision boots without a checkpoint ref.
vi.mock('../src/prepared-state.js', () => ({
  readPreparedState: () => ({ base: { snapshotId: 'snap_base' } }),
}));

// Control the credential stagers — each returns a real temp tarball path or null
// (host has no creds for that agent). cleanup is asserted to run.
const stage = vi.hoisted(() => ({
  claude: vi.fn(),
  codex: vi.fn(),
  opencode: vi.fn(),
}));
vi.mock('@agentbox/sandbox-cloud', () => ({
  stageClaudeCredentialsForUpload: stage.claude,
  stageCodexCredentialsForUpload: stage.codex,
  stageOpencodeCredentialsForUpload: stage.opencode,
}));

import { vercelBackend } from '../src/backend.js';

let tmp: string;
let cleanups: Array<ReturnType<typeof vi.fn>>;

async function fakeTarball(name: string): Promise<string> {
  const p = join(tmp, name);
  await writeFile(p, 'TARBALL');
  return p;
}

function stageResult(tarballPath: string | null, warnings: string[] = []) {
  const cleanup = vi.fn(async () => undefined);
  cleanups.push(cleanup);
  return { tarballPath, cleanup, warnings };
}

beforeEach(async () => {
  vi.clearAllMocks();
  cleanups = [];
  tmp = await mkdtemp(join(tmpdir(), 'vcred-'));
  mocks.create.mockResolvedValue({ name: 'box-1' });
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('vercelBackend.provision — per-box credential push', () => {
  it('uploads + extracts a tarball for each agent that has host creds', async () => {
    const runCommand = vi.fn(async () => ({ exitCode: 0 }));
    const writeFiles = vi.fn(async () => undefined);
    mocks.get.mockResolvedValue({ name: 'box-1', writeFiles, runCommand });

    stage.claude.mockResolvedValue(stageResult(await fakeTarball('claude.tgz')));
    stage.codex.mockResolvedValue(stageResult(await fakeTarball('codex.tgz')));
    stage.opencode.mockResolvedValue(stageResult(await fakeTarball('opencode.tgz')));

    const handle = await vercelBackend.provision({ name: 'box-1' } as never);
    expect(handle).toEqual({ sandboxId: 'box-1' });

    // One writeFiles + one runCommand per agent (3 total each).
    expect(writeFiles).toHaveBeenCalledTimes(3);
    expect(runCommand).toHaveBeenCalledTimes(3);

    const remotes = writeFiles.mock.calls.map((c) => (c[0] as Array<{ path: string }>)[0].path);
    expect(remotes).toEqual([
      '/tmp/agentbox-claude-creds.tar.gz',
      '/tmp/agentbox-codex-creds.tar.gz',
      '/tmp/agentbox-opencode-creds.tar.gz',
    ]);

    // Each extract targets the matching ~/.agentbox-creds/<kind> dest.
    const extracts = runCommand.mock.calls.map((c) => (c[0] as { args: string[] }).args[1]);
    expect(extracts[0]).toContain('/home/vscode/.agentbox-creds/claude');
    expect(extracts[1]).toContain('/home/vscode/.agentbox-creds/codex');
    expect(extracts[2]).toContain('/home/vscode/.agentbox-creds/opencode');
    expect(extracts[0]).toContain('sudo -u vscode tar -xzf /tmp/agentbox-claude-creds.tar.gz');

    // Staging temp files are always cleaned up.
    for (const c of cleanups) expect(c).toHaveBeenCalledTimes(1);
  });

  it('skips agents with no host credentials and still returns the handle', async () => {
    const runCommand = vi.fn(async () => ({ exitCode: 0 }));
    const writeFiles = vi.fn(async () => undefined);
    mocks.get.mockResolvedValue({ name: 'box-1', writeFiles, runCommand });

    stage.claude.mockResolvedValue(stageResult(await fakeTarball('claude.tgz')));
    stage.codex.mockResolvedValue(stageResult(null)); // no host codex auth
    stage.opencode.mockResolvedValue(stageResult(null)); // no host opencode auth

    const handle = await vercelBackend.provision({ name: 'box-1' } as never);
    expect(handle).toEqual({ sandboxId: 'box-1' });
    expect(writeFiles).toHaveBeenCalledTimes(1);
    expect(runCommand).toHaveBeenCalledTimes(1);
    for (const c of cleanups) expect(c).toHaveBeenCalledTimes(1);
  });

  it('a non-zero extract is logged, not thrown', async () => {
    const runCommand = vi.fn(async () => ({ exitCode: 2 }));
    const writeFiles = vi.fn(async () => undefined);
    mocks.get.mockResolvedValue({ name: 'box-1', writeFiles, runCommand });
    stage.claude.mockResolvedValue(stageResult(await fakeTarball('claude.tgz')));
    stage.codex.mockResolvedValue(stageResult(null));
    stage.opencode.mockResolvedValue(stageResult(null));

    const logs: string[] = [];
    const handle = await vercelBackend.provision({ name: 'box-1', onLog: (l) => logs.push(l) } as never);
    expect(handle).toEqual({ sandboxId: 'box-1' });
    expect(logs.some((l) => l.includes('claude credential extract failed'))).toBe(true);
  });

  it('a push failure never blocks create — handle is still returned', async () => {
    // Sandbox.get rejects → push throws → caught + logged, create still succeeds.
    mocks.get.mockRejectedValue(new Error('transient'));
    stage.claude.mockResolvedValue(stageResult(null));
    stage.codex.mockResolvedValue(stageResult(null));
    stage.opencode.mockResolvedValue(stageResult(null));

    const logs: string[] = [];
    const handle = await vercelBackend.provision({ name: 'box-1', onLog: (l) => logs.push(l) } as never);
    expect(handle).toEqual({ sandboxId: 'box-1' });
    expect(logs.some((l) => l.includes('agent credential push failed'))).toBe(true);
  });
});
