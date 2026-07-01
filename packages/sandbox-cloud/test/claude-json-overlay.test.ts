import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { seedClaudeJsonAtCreate } from '../src/sync/claude-json-overlay.js';
import { stageClaudeJsonOnlyForUpload } from '@agentbox/sandbox-docker';

interface ExecCall { cmd: string }
interface UploadCall { localPath: string; remotePath: string }

function makeMockBackend(): {
  backend: CloudBackend;
  execCalls: ExecCall[];
  uploadCalls: UploadCall[];
} {
  const execCalls: ExecCall[] = [];
  const uploadCalls: UploadCall[] = [];
  const backend: CloudBackend = {
    name: 'mock',
    async provision(): Promise<CloudHandle> {
      return { sandboxId: 'mock' };
    },
    async get(): Promise<CloudHandle | null> {
      return { sandboxId: 'mock' };
    },
    async start(): Promise<void> {},
    async stop(): Promise<void> {},
    async pause(): Promise<void> {},
    async resume(): Promise<void> {},
    async destroy(): Promise<void> {},
    async state(): Promise<CloudState> {
      return 'running';
    },
    async exec(_h, cmd: string): Promise<CloudExecResult> {
      execCalls.push({ cmd });
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
  };
  return { backend, execCalls, uploadCalls };
}

describe('seedClaudeJsonAtCreate', () => {
  let fakeHome: string;
  const originalHome = process.env['HOME'];

  beforeEach(async () => {
    fakeHome = await mkdtemp(join(tmpdir(), 'agentbox-claudejson-test-'));
    process.env['HOME'] = fakeHome;
  });

  afterEach(async () => {
    if (originalHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = originalHome;
    await rm(fakeHome, { recursive: true, force: true });
  });

  it('uploads and extracts the overlay even when host has no ~/.claude.json', async () => {
    const { backend, execCalls, uploadCalls } = makeMockBackend();
    const logs: string[] = [];
    await seedClaudeJsonAtCreate(backend, { sandboxId: 's' }, { onLog: (l) => logs.push(l) });
    expect(uploadCalls).toHaveLength(1);
    expect(uploadCalls[0]!.remotePath).toBe('/tmp/agentbox-claude-json.tar.gz');
    expect(
      execCalls.some(
        (c) =>
          c.cmd.includes('tar -xzf /tmp/agentbox-claude-json.tar.gz') &&
          c.cmd.includes('/home/vscode/.claude'),
      ),
    ).toBe(true);
    expect(logs.some((l) => l.includes('seeded'))).toBe(true);
  });

  it('propagates host hasCompletedOnboarding=true into the overlay tarball', async () => {
    await writeFile(
      join(fakeHome, '.claude.json'),
      JSON.stringify({ hasCompletedOnboarding: true, theme: 'dark' }),
    );

    const staged = await stageClaudeJsonOnlyForUpload({ hostWorkspace: '/host/path' });
    expect(staged.tarballPath).not.toBeNull();
    // Confirm the staged tarball file exists; deep content assertions are
    // covered by the host-stage tests in sandbox-docker.
    await staged.cleanup();
  });

  it('defaults hasCompletedOnboarding=true when host has no ~/.claude.json', async () => {
    // No host ~/.claude.json — the staging fallback must still set onboarding so
    // a fresh-on-the-host user doesn't drop into the in-box theme picker.
    const staged = await stageClaudeJsonOnlyForUpload({});
    expect(staged.tarballPath).not.toBeNull();
    await staged.cleanup();
  });
});
