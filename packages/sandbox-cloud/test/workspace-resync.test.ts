import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CloudBackend, CloudHandle, ResyncWorktree } from '@agentbox/core';

// Host git runs via execa; route by argv so the pre-fetch is deterministic.
const { execaMock } = vi.hoisted(() => ({ execaMock: vi.fn() }));
vi.mock('execa', () => ({ execa: execaMock }));

import { resyncCloudWorkspace } from '../src/sync/workspace-resync.js';

const HOST_TIP = 'a'.repeat(40);
const BASE = 'b'.repeat(40); // shared ancestor (fork base)
const BOX_TIP = 'c'.repeat(40); // box-only commit

// Fake host git: the box branch's newest commit (BOX_TIP) is absent on the host;
// BASE is present → BASE is the shared ancestor P.
function routeExeca(args: string[]): { exitCode: number; stdout: string; stderr: string } {
  const j = args.join(' ');
  if (j.includes('rev-parse HEAD')) return { exitCode: 0, stdout: HOST_TIP, stderr: '' };
  if (j.includes('cat-file --batch-check')) {
    // batch-check echoes: present commits get "<sha> commit <n>", absent "<sha> missing".
    return { exitCode: 0, stdout: `${BOX_TIP} missing\n${BASE} commit 42`, stderr: '' };
  }
  if (j.includes('stash create')) return { exitCode: 0, stdout: '', stderr: '' }; // clean host
  if (j.includes('bundle create')) return { exitCode: 0, stdout: '', stderr: '' };
  if (j.includes('update-ref')) return { exitCode: 0, stdout: '', stderr: '' };
  if (j.includes('ls-files')) return { exitCode: 0, stdout: '', stderr: '' }; // no untracked
  return { exitCode: 0, stdout: '', stderr: '' };
}

const boxExec: string[] = [];
function makeBackend(name: string): CloudBackend {
  return {
    name,
    async exec(_h: CloudHandle, cmd: string) {
      boxExec.push(cmd);
      // The box branch = fork base (BASE) + a box-only commit (BOX_TIP), newest first.
      if (cmd.includes('rev-list --max-count')) {
        return { exitCode: 0, stdout: `${BOX_TIP}\n${BASE}`, stderr: '' };
      }
      // status --porcelain → clean; MERGE_HEAD verify → fail (treat as fast-forward);
      // everything else → ok empty. Enough for the concern to issue its commands.
      return { exitCode: cmd.includes('MERGE_HEAD') ? 1 : 0, stdout: '', stderr: '' };
    },
    async uploadFile() {},
  } as unknown as CloudBackend;
}

const handle: CloudHandle = { sandboxId: 'sb-1' };
const worktree: ResyncWorktree = {
  containerPath: '/workspace',
  hostMainRepo: '/host/repo',
  branch: 'agentbox/demo',
};

beforeEach(() => {
  execaMock.mockReset();
  execaMock.mockImplementation((_bin: string, args: string[]) => Promise.resolve(routeExeca(args)));
  boxExec.length = 0;
});

describe('resyncCloudWorkspace pre-fetch', () => {
  it('bundles P..H excluding ^base and fetches it into the box — never reset --hard', async () => {
    const backend = makeBackend('hetzner');
    await resyncCloudWorkspace(backend, handle, [worktree]);

    const execaCalls = execaMock.mock.calls.map((c) => (c[1] as string[]).join(' '));
    // Bundle excludes what the box already holds (`^BASE`) and ships the target.
    const bundle = execaCalls.find((c) => c.includes('bundle create'));
    expect(bundle).toBeDefined();
    expect(bundle).toContain('refs/agentbox-resync/target');
    expect(bundle).toContain(`^${BASE}`);

    // The box fetches the private refs from the uploaded bundle.
    expect(boxExec.some((c) => c.includes('fetch --no-tags') && c.includes('refs/agentbox-resync/target'))).toBe(true);

    // DATA-LOSS GUARD: the live-box resync must NEVER reset --hard / checkout -f
    // (that would drop in-box commits). Merge-only.
    expect(boxExec.some((c) => /reset\s+--hard/.test(c))).toBe(false);
    expect(boxExec.some((c) => /checkout\s+-f/.test(c))).toBe(false);
  });

  it('overlays untracked only (no bundle, no merge) when no shared ancestor exists', async () => {
    // Host has neither the box tip nor the base → P not found.
    execaMock.mockImplementation((_bin: string, args: string[]) => {
      const j = args.join(' ');
      if (j.includes('cat-file --batch-check')) {
        return Promise.resolve({ exitCode: 0, stdout: `${BOX_TIP} missing`, stderr: '' });
      }
      return Promise.resolve(routeExeca(args));
    });
    const backend = makeBackend('hetzner');
    await resyncCloudWorkspace(backend, handle, [worktree]);

    const execaCalls = execaMock.mock.calls.map((c) => (c[1] as string[]).join(' '));
    expect(execaCalls.some((c) => c.includes('bundle create'))).toBe(false);
    // No merge issued against the target ref.
    expect(boxExec.some((c) => c.includes('merge') && c.includes('refs/agentbox-resync/target'))).toBe(false);
  });

  it('runs the untracked probe as root on vercel (avoids the $()/while re-parse hang)', async () => {
    const seenUsers: Array<string | undefined> = [];
    const backend = {
      name: 'vercel',
      async exec(_h: CloudHandle, cmd: string, opts?: { user?: string }) {
        boxExec.push(cmd);
        if (cmd.includes('base64 -d')) seenUsers.push(opts?.user);
        if (cmd.includes('rev-list --max-count')) return { exitCode: 0, stdout: `${BOX_TIP}\n${BASE}`, stderr: '' };
        // Report one untracked host file so the probe actually runs.
        return { exitCode: cmd.includes('MERGE_HEAD') ? 1 : 0, stdout: '', stderr: '' };
      },
      async uploadFile() {},
    } as unknown as CloudBackend;
    // Host has one untracked file so the concern probes the box.
    execaMock.mockImplementation((_bin: string, args: string[]) => {
      const j = args.join(' ');
      if (j.includes('ls-files')) return Promise.resolve({ exitCode: 0, stdout: 'note.txt\0', stderr: '' });
      return Promise.resolve(routeExeca(args));
    });
    await resyncCloudWorkspace(backend, handle, [worktree]);
    // The probe ran and every probe invocation was as root.
    expect(seenUsers.length).toBeGreaterThan(0);
    expect(seenUsers.every((u) => u === 'root')).toBe(true);
  });
});
