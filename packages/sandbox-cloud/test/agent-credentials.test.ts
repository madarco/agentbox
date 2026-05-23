import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  CloudBackend,
  CloudExecResult,
  CloudFileEntry,
  CloudHandle,
  CloudPreviewUrl,
  CloudState,
} from '@agentbox/core';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { seedAgentVolumesIfFresh, ensureAgentVolumesForCloud } from '../src/agent-credentials.js';

interface ExecCall {
  cmd: string;
}

interface UploadCall {
  localPath: string;
  remotePath: string;
}

function makeMockBackend(opts: {
  /** Map of seed-marker paths that the mock pretends already exist. */
  existingMarkers?: Set<string>;
  /** Volume ids returned from ensureVolume, keyed by name. */
  volumeIds?: Map<string, string>;
}): {
  backend: CloudBackend;
  execCalls: ExecCall[];
  uploadCalls: UploadCall[];
  destroyed: boolean;
} {
  const existing = opts.existingMarkers ?? new Set<string>();
  const ids = opts.volumeIds ?? new Map<string, string>();
  const execCalls: ExecCall[] = [];
  const uploadCalls: UploadCall[] = [];
  const state = { destroyed: false };

  const backend: CloudBackend = {
    name: 'mock',
    async provision(): Promise<CloudHandle> {
      return { sandboxId: 'mock-sandbox' };
    },
    async get(): Promise<CloudHandle | null> {
      return { sandboxId: 'mock-sandbox' };
    },
    async start(): Promise<void> {},
    async stop(): Promise<void> {},
    async pause(): Promise<void> {},
    async resume(): Promise<void> {},
    async destroy(): Promise<void> {
      state.destroyed = true;
    },
    async state(): Promise<CloudState> {
      return 'running';
    },
    async exec(_h, cmd: string): Promise<CloudExecResult> {
      execCalls.push({ cmd });
      // Marker-probe shape: `test -f <mountPath>/<marker>`. Return 0 when we
      // pretend the marker exists, 1 otherwise.
      const m = /^test -f (.+\/\.agentbox-seeded-at)$/.exec(cmd);
      if (m) {
        return existing.has(m[1]!)
          ? { exitCode: 0, stdout: '', stderr: '' }
          : { exitCode: 1, stdout: '', stderr: '' };
      }
      // Treat every other exec (the seed install script) as a success.
      return { exitCode: 0, stdout: '', stderr: '' };
    },
    async uploadFile(_h, localPath: string, remotePath: string): Promise<void> {
      uploadCalls.push({ localPath, remotePath });
    },
    async downloadFile(): Promise<void> {},
    async listFiles(): Promise<CloudFileEntry[]> {
      return [];
    },
    async previewUrl(): Promise<CloudPreviewUrl> {
      return { url: 'https://mock/' };
    },
    async ensureVolume(name: string): Promise<{ volumeId: string }> {
      return { volumeId: ids.get(name) ?? `mock-${name}` };
    },
  };

  return { backend, execCalls, uploadCalls, get destroyed() { return state.destroyed; } } as never;
}

describe('ensureAgentVolumesForCloud', () => {
  it('returns three mount specs and OPENCODE_CONFIG_DIR when backend has volumes', async () => {
    const { backend } = makeMockBackend({});
    const res = await ensureAgentVolumesForCloud(backend);
    expect(res.agents).toEqual(['claude', 'codex', 'opencode']);
    expect(res.mounts).toHaveLength(3);
    expect(res.mounts.map((m) => m.mountPath)).toContain('/home/vscode/.claude');
    expect(res.mounts.map((m) => m.mountPath)).toContain('/home/vscode/.codex');
    expect(res.mounts.map((m) => m.mountPath)).toContain(
      '/home/vscode/.local/share/opencode',
    );
    expect(res.env['OPENCODE_CONFIG_DIR']).toBe('/home/vscode/.local/share/opencode/config');
  });

  it('returns empty mounts when backend has no volume primitive', async () => {
    const { backend } = makeMockBackend({});
    // Remove ensureVolume to simulate a backend without volumes.
    delete (backend as { ensureVolume?: unknown }).ensureVolume;
    const logs: string[] = [];
    const res = await ensureAgentVolumesForCloud(backend, { onLog: (l) => logs.push(l) });
    expect(res.mounts).toEqual([]);
    expect(res.agents).toEqual([]);
    expect(res.env).toEqual({});
    expect(logs.some((l) => l.includes('has no volume primitive'))).toBe(true);
  });
});

describe('seedAgentVolumesIfFresh', () => {
  // Use a fake HOME so the stage* helpers see no ~/.claude / ~/.codex /
  // ~/.local/share/opencode and short-circuit to "nothing to stage". This
  // keeps the test hermetic: we're verifying the marker-check + dispatch
  // logic, not the staging mechanics (which need real rsync/tar and are
  // covered by manual e2e).
  let fakeHome: string;
  const originalHome = process.env['HOME'];

  beforeAll(async () => {
    fakeHome = await mkdtemp(join(tmpdir(), 'agentbox-creds-test-'));
    process.env['HOME'] = fakeHome;
  });

  afterAll(async () => {
    if (originalHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = originalHome;
    await rm(fakeHome, { recursive: true, force: true });
  });

  it('skips agents whose marker already exists in the volume', async () => {
    const { backend, uploadCalls, execCalls } = makeMockBackend({
      existingMarkers: new Set([
        '/home/vscode/.claude/.agentbox-seeded-at',
        '/home/vscode/.codex/.agentbox-seeded-at',
        '/home/vscode/.local/share/opencode/.agentbox-seeded-at',
      ]),
    });
    const logs: string[] = [];
    await seedAgentVolumesIfFresh(backend, { sandboxId: 's' }, {
      onLog: (l) => logs.push(l),
    });
    // No uploads, three marker-probe execs.
    expect(uploadCalls).toEqual([]);
    expect(execCalls.filter((c) => c.cmd.startsWith('test -f ')).length).toBe(3);
    // No extract execs (which use 'tar -xzf' or 'set -e').
    expect(execCalls.some((c) => c.cmd.includes('tar -xzf'))).toBe(false);
    expect(logs.every((l) => l.includes('already seeded') || l.includes('mounting only'))).toBe(
      true,
    );
  });

  it('does not upload when host has no agent state to stage', async () => {
    // fakeHome contains no ~/.claude / ~/.codex / opencode dirs, so the stage
    // helpers return null tarballPath. Markers are absent so the code reaches
    // the staging step, but staging short-circuits.
    const { backend, uploadCalls } = makeMockBackend({});
    await seedAgentVolumesIfFresh(backend, { sandboxId: 's' });
    expect(uploadCalls).toEqual([]);
  });

  it('attempts upload + extract when marker absent and host has codex state with auth.json', async () => {
    // Materialize a tiny ~/.codex/auth.json on the fake HOME so
    // stageCodexForUpload produces a real tarball. The mock exec returns 0
    // for the install script, so we should see exactly one upload + one
    // tar-extract exec for codex (and zero for claude/opencode because their
    // host dirs don't exist).
    const codexDir = join(fakeHome, '.codex');
    await mkdir(codexDir, { recursive: true });
    await writeFile(join(codexDir, 'auth.json'), '{"token":"redacted"}\n');
    await writeFile(join(codexDir, 'config.toml'), 'model = "gpt-5"\n');

    const { backend, uploadCalls, execCalls } = makeMockBackend({});
    await seedAgentVolumesIfFresh(backend, { sandboxId: 's' });
    expect(uploadCalls).toHaveLength(1);
    expect(uploadCalls[0]!.remotePath).toBe('/tmp/agentbox-codex-seed.tar.gz');
    // The install command for codex extracts into /home/vscode/.codex.
    expect(
      execCalls.some(
        (c) => c.cmd.includes('tar -xzf') && c.cmd.includes('/home/vscode/.codex'),
      ),
    ).toBe(true);
    // No upload for the other two agents (no host state).
    expect(uploadCalls.some((c) => c.remotePath.includes('claude'))).toBe(false);
    expect(uploadCalls.some((c) => c.remotePath.includes('opencode'))).toBe(false);

    // Cleanup the codex dir before the next test so it doesn't leak.
    await rm(codexDir, { recursive: true, force: true });
  });

  it('warns + skips codex when ~/.codex exists but auth.json is missing (Keychain landmine)', async () => {
    const codexDir = join(fakeHome, '.codex');
    await mkdir(codexDir, { recursive: true });
    await writeFile(join(codexDir, 'config.toml'), 'model = "gpt-5"\n');
    // intentionally NO auth.json — simulates the macOS Keychain default.

    const { backend, uploadCalls } = makeMockBackend({});
    const logs: string[] = [];
    await seedAgentVolumesIfFresh(backend, { sandboxId: 's' }, { onLog: (l) => logs.push(l) });
    expect(uploadCalls.some((c) => c.remotePath.includes('codex'))).toBe(false);
    expect(
      logs.some((l) => /auth\.json missing|cli_auth_credentials_store/i.test(l)),
    ).toBe(true);

    await rm(codexDir, { recursive: true, force: true });
  });
});
