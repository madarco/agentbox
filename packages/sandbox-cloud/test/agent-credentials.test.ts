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
import { readFile, stat } from 'node:fs/promises';
import {
  ensureAgentVolumesForCloud,
  extractCloudAgentCredentials,
  seedAgentVolumesIfFresh,
} from '../src/sync/agent-credentials.js';

interface ExecCall {
  cmd: string;
}

interface UploadCall {
  localPath: string;
  remotePath: string;
}

function makeMockBackend(opts: {
  /** Seed-marker paths that the mock pretends already exist. */
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
      const m = /^test -f (.+\/\.agentbox-seeded-at)$/.exec(cmd);
      if (m) {
        return existing.has(m[1]!)
          ? { exitCode: 0, stdout: '', stderr: '' }
          : { exitCode: 1, stdout: '', stderr: '' };
      }
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
  it('returns three subpath mounts of the shared credentials volume', async () => {
    const { backend } = makeMockBackend({});
    const res = await ensureAgentVolumesForCloud(backend);
    expect(res.agents).toEqual(['claude', 'codex', 'opencode']);
    expect(res.mounts).toHaveLength(3);

    // All three mounts share the same volumeId (single shared volume).
    const volumeIds = new Set(res.mounts.map((m) => m.volumeId));
    expect(volumeIds.size).toBe(1);
    expect([...volumeIds][0]).toBe('mock-agentbox-credentials');

    // Each mount targets the per-agent cred dir with the expected subpath.
    const byPath = new Map(res.mounts.map((m) => [m.mountPath, m] as const));
    expect(byPath.get('/home/vscode/.agentbox-creds/claude')?.subpath).toBe('claude/');
    expect(byPath.get('/home/vscode/.agentbox-creds/codex')?.subpath).toBe('codex/');
    expect(byPath.get('/home/vscode/.agentbox-creds/opencode')?.subpath).toBe('opencode/');

    expect(res.env['OPENCODE_CONFIG_DIR']).toBe('/home/vscode/.local/share/opencode/config');
  });

  it('returns empty mounts but full agents list when backend has no volume primitive', async () => {
    const { backend } = makeMockBackend({});
    delete (backend as { ensureVolume?: unknown }).ensureVolume;
    const logs: string[] = [];
    const res = await ensureAgentVolumesForCloud(backend, { onLog: (l) => logs.push(l) });
    // Non-volume backends (e2b, vercel, hetzner) still get the seed: the
    // unified seedAgentVolumesIfFresh falls back to a direct extract into the
    // box-baked ~/.agentbox-creds/<agent>/ dirs. No volume to mount, but the
    // agent list must be populated so the seed actually runs.
    expect(res.mounts).toEqual([]);
    expect(res.agents).toEqual(['claude', 'codex', 'opencode']);
    expect(res.env['OPENCODE_CONFIG_DIR']).toBe('/home/vscode/.local/share/opencode/config');
    expect(logs.some((l) => l.includes('has no volume primitive'))).toBe(true);
  });
});

describe('seedAgentVolumesIfFresh (credentials-only)', () => {
  // Fake HOME with no agent dirs → stage* helpers return null tarballPath.
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

  it('skips agents whose credentials marker already exists', async () => {
    const { backend, uploadCalls, execCalls } = makeMockBackend({
      existingMarkers: new Set([
        '/home/vscode/.agentbox-creds/claude/.agentbox-seeded-at',
        '/home/vscode/.agentbox-creds/codex/.agentbox-seeded-at',
        '/home/vscode/.agentbox-creds/opencode/.agentbox-seeded-at',
      ]),
    });
    const logs: string[] = [];
    await seedAgentVolumesIfFresh(backend, { sandboxId: 's' }, {
      onLog: (l) => logs.push(l),
    });
    expect(uploadCalls).toEqual([]);
    expect(execCalls.filter((c) => c.cmd.startsWith('test -f ')).length).toBe(3);
    expect(execCalls.some((c) => c.cmd.includes('tar -xzf'))).toBe(false);
    expect(
      logs.every((l) => l.includes('already seeded') || l.includes('mounting only')),
    ).toBe(true);
  });

  // Tests below pass `agents: ['codex', 'opencode']` to exclude claude — the
  // claude credentials stage reads from `~/.agentbox/claude-credentials.json`
  // via STATE_DIR which is captured at module-load time, before the
  // beforeAll() hook can redirect HOME. Excluding claude keeps the dispatch
  // tests hermetic.

  it('does not upload when host has no credentials to stage (codex/opencode)', async () => {
    const { backend, uploadCalls } = makeMockBackend({});
    await seedAgentVolumesIfFresh(backend, { sandboxId: 's' }, {
      agents: ['codex', 'opencode'],
    });
    expect(uploadCalls).toEqual([]);
  });

  it('uploads codex auth.json + extracts into the codex cred dir when marker absent', async () => {
    const codexDir = join(fakeHome, '.codex');
    await mkdir(codexDir, { recursive: true });
    await writeFile(join(codexDir, 'auth.json'), '{"token":"redacted"}\n');
    // config.toml is static content — should NOT trigger a credentials seed.
    await writeFile(join(codexDir, 'config.toml'), 'model = "gpt-5"\n');

    const { backend, uploadCalls, execCalls } = makeMockBackend({});
    await seedAgentVolumesIfFresh(backend, { sandboxId: 's' }, {
      agents: ['codex', 'opencode'],
    });

    expect(uploadCalls).toHaveLength(1);
    expect(uploadCalls[0]!.remotePath).toBe('/tmp/agentbox-codex-creds.tar.gz');
    expect(
      execCalls.some(
        (c) =>
          c.cmd.includes('tar -xzf') &&
          c.cmd.includes('/home/vscode/.agentbox-creds/codex'),
      ),
    ).toBe(true);
    expect(uploadCalls.some((c) => c.remotePath.includes('opencode'))).toBe(false);

    await rm(codexDir, { recursive: true, force: true });
  });

  it('warns + skips codex when ~/.codex exists but auth.json is missing (Keychain landmine)', async () => {
    const codexDir = join(fakeHome, '.codex');
    await mkdir(codexDir, { recursive: true });
    await writeFile(join(codexDir, 'config.toml'), 'model = "gpt-5"\n');
    // intentionally NO auth.json

    const { backend, uploadCalls } = makeMockBackend({});
    const logs: string[] = [];
    await seedAgentVolumesIfFresh(backend, { sandboxId: 's' }, {
      agents: ['codex', 'opencode'],
      onLog: (l) => logs.push(l),
    });
    expect(uploadCalls.some((c) => c.remotePath.includes('codex'))).toBe(false);
    expect(
      logs.some((l) => /auth\.json missing|cli_auth_credentials_store/i.test(l)),
    ).toBe(true);

    await rm(codexDir, { recursive: true, force: true });
  });
});

describe('extractCloudAgentCredentials', () => {
  let dir: string;
  const realClaude = JSON.stringify({ claudeAiOauth: { refreshToken: 'rt-real' } });

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'agentbox-extract-test-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  // Mock backend whose `exec` answers `cat <path>` from a provided file map.
  function backendCatting(files: Record<string, string | undefined>): CloudBackend {
    return {
      name: 'mock',
      async provision(): Promise<CloudHandle> { return { sandboxId: 's' }; },
      async get(): Promise<CloudHandle | null> { return { sandboxId: 's' }; },
      async start() {}, async stop() {}, async pause() {}, async resume() {},
      async destroy() {},
      async state(): Promise<CloudState> { return 'running'; },
      async exec(_h, cmd: string): Promise<CloudExecResult> {
        const m = /^cat (\S+) 2>\/dev\/null$/.exec(cmd);
        if (m) {
          const content = files[m[1]!];
          return content === undefined
            ? { exitCode: 1, stdout: '', stderr: '' }
            : { exitCode: 0, stdout: content, stderr: '' };
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      },
      async uploadFile() {}, async downloadFile() {},
      async listFiles(): Promise<CloudFileEntry[]> { return []; },
      async previewUrl(): Promise<CloudPreviewUrl> { return { url: 'https://mock/' }; },
    };
  }

  it('writes only agents with a real credential (0600) and returns them', async () => {
    const backups = {
      claude: join(dir, 'claude-credentials.json'),
      codex: join(dir, 'codex-credentials.json'),
      opencode: join(dir, 'opencode-credentials.json'),
    };
    const backend = backendCatting({
      '/home/vscode/.claude/.credentials.json': realClaude,
      '/home/vscode/.codex/auth.json': '{}', // empty object → not "real" → skipped
      // opencode file missing → exec exit 1 → skipped
    });
    const extracted = await extractCloudAgentCredentials(backend, { sandboxId: 's' }, { backups });
    expect(extracted).toEqual(['claude']);
    expect(await readFile(backups.claude, 'utf8')).toBe(realClaude);
    expect((await stat(backups.claude)).mode & 0o777).toBe(0o600);
    await expect(stat(backups.codex)).rejects.toThrow();
    await expect(stat(backups.opencode)).rejects.toThrow();
  });

  it('extracts codex + opencode when their auth files are non-empty JSON', async () => {
    const backups = {
      claude: join(dir, 'c2.json'),
      codex: join(dir, 'codex2.json'),
      opencode: join(dir, 'oc2.json'),
    };
    const backend = backendCatting({
      '/home/vscode/.codex/auth.json': '{"OPENAI_API_KEY":"sk-x"}',
      '/home/vscode/.local/share/opencode/auth.json': '{"anthropic":{"type":"oauth"}}',
    });
    const extracted = await extractCloudAgentCredentials(backend, { sandboxId: 's' }, { backups });
    expect(extracted.sort()).toEqual(['codex', 'opencode']);
  });

  it('swallows a failing exec and returns []', async () => {
    const backend: CloudBackend = {
      ...backendCatting({}),
      async exec(): Promise<CloudExecResult> { throw new Error('transient'); },
    };
    const logs: string[] = [];
    const extracted = await extractCloudAgentCredentials(
      backend,
      { sandboxId: 's' },
      { backups: { claude: join(dir, 'never.json') }, onLog: (l) => logs.push(l) },
    );
    expect(extracted).toEqual([]);
    expect(logs.some((l) => l.includes('extract failed'))).toBe(true);
  });
});

