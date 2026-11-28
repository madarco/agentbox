import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CloudBackend } from '@agentbox/core';

// Scratch HOME before the imports: the account store lives under it.
const home = mkdtempSync(join(tmpdir(), 'agentbox-cloud-acct-'));
const realHome = process.env.HOME;
process.env.HOME = home;
const savedKey = process.env.ANTHROPIC_API_KEY;
process.env.ANTHROPIC_API_KEY = 'host-owner-key';
const { cloudAccountAuthority, ensureAgentVolumesForCloud } =
  await import('../src/sync/agent-credentials.js');
const core = await import('@agentbox/sandbox-core');

beforeAll(async () => {
  await core.upsertAccount({ agent: 'claude', id: 'work', kind: 'login', createdAt: 't' });
  await core.upsertAccount({ agent: 'claude', id: 'ci', kind: 'setup-token', createdAt: 't' });
  await core.writeAccountSecret(
    'claude',
    'ci',
    core.encodePastedSecret({ kind: 'setup-token', token: 'sk-ant-oat01-' + 'y'.repeat(20) }),
  );
});
afterAll(() => {
  process.env.HOME = realHome;
  if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = savedKey;
  rmSync(home, { recursive: true, force: true });
});

const volumeBackend = {
  name: 'fake',
  ensureVolume: () => Promise.resolve({ volumeId: 'vol-1' }),
} as unknown as CloudBackend;

describe('cloud seeding per account (llm-accounts Phase 3)', () => {
  it("default keeps the base subpath and today's env spray", async () => {
    const r = await ensureAgentVolumesForCloud(volumeBackend, { agents: ['claude'] });
    expect(r.mounts.map((m) => m.subpath)).toEqual(['claude/']);
    expect(r.env.ANTHROPIC_API_KEY).toBe('host-owner-key');
  });

  it("a named login mounts its sibling subpath and drops the host's key", async () => {
    const r = await ensureAgentVolumesForCloud(volumeBackend, {
      agents: ['claude'],
      accounts: { claude: 'work' },
    });
    expect(r.mounts.map((m) => m.subpath)).toEqual(['claude-acct-work/']);
    expect(r.env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("a setup-token account's token goes to the agent env file, never the sandbox env", async () => {
    const r = await ensureAgentVolumesForCloud(volumeBackend, {
      agents: ['claude'],
      accounts: { claude: 'ci' },
    });
    // The create env is visible in the provider's console and API.
    expect(r.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(r.env.ANTHROPIC_API_KEY).toBeUndefined();
    const authority = await cloudAccountAuthority(['claude'], { claude: 'ci' });
    expect(authority.set.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat01-' + 'y'.repeat(20));
    expect(authority.unset).toContain('ANTHROPIC_API_KEY');
  });
});

describe('Daytona: an already-seeded named login subpath (marker present)', () => {
  it('reconciles with the stored login instead of trusting the marker', async () => {
    const { seedAgentVolumesIfFresh } = await import('../src/sync/agent-credentials.js');
    const blob = (exp: number) =>
      JSON.stringify({ claudeAiOauth: { accessToken: 'a', refreshToken: 'r', expiresAt: exp } });
    await core.writeAccountSecret('claude', 'work', blob(999));
    const cmds: string[] = [];
    const uploads: string[] = [];
    const backend = {
      name: 'fake',
      ensureVolume: () => Promise.resolve({ volumeId: 'vol-1' }),
      exec: (_h: unknown, cmd: string) => {
        cmds.push(cmd);
        if (cmd.startsWith('test -f '))
          return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
        if (cmd.startsWith('cat '))
          return Promise.resolve({ exitCode: 0, stdout: blob(1), stderr: '' });
        return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
      },
      uploadFile: (_h: unknown, _local: string, remote: string) => {
        uploads.push(remote);
        return Promise.resolve();
      },
    } as unknown as CloudBackend;
    const logs: string[] = [];
    await seedAgentVolumesIfFresh(
      backend,
      { sandboxId: 's' },
      { agents: ['claude'], accounts: { claude: 'work' }, onLog: (l) => logs.push(l) },
    );
    expect(logs.some((l) => l.includes("account 'work' already seeded"))).toBe(true);
    // The box's older copy was read, and the stored newer login was put in…
    expect(cmds.some((c) => c.startsWith('cat ') && c.includes('.credentials.json'))).toBe(true);
    expect(logs.some((l) => l.includes('refreshed claude credential in box'))).toBe(true);
    // …without re-uploading the whole seed tarball.
    expect(uploads.some((u) => u.includes('creds.tar.gz'))).toBe(false);
  });
});
