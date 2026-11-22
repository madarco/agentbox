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
const { ensureAgentVolumesForCloud } = await import('../src/sync/agent-credentials.js');
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

  it('a setup-token account injects its own token', async () => {
    const r = await ensureAgentVolumesForCloud(volumeBackend, {
      agents: ['claude'],
      accounts: { claude: 'ci' },
    });
    expect(r.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat01-' + 'y'.repeat(20));
    expect(r.env.ANTHROPIC_API_KEY).toBeUndefined();
  });
});
