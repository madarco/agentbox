import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Scratch HOME before the imports: the account store lives under it, and the
// default backup lookup must not see the real one.
const home = mkdtempSync(join(tmpdir(), 'agentbox-custody-acct-'));
const realHome = process.env.HOME;
process.env.HOME = home;
const { collectAgentCredentialUploads } = await import('../src/control-plane/custody-client.js');
const core = await import('@agentbox/sandbox-core');
const { getMachineId } = await import('@agentbox/config');

const LOGIN = JSON.stringify({ claudeAiOauth: { refreshToken: 'r', expiresAt: 5 } });

beforeAll(async () => {
  await core.upsertAccount({ agent: 'claude', id: 'work', kind: 'login', createdAt: 't' });
  await core.writeAccountSecret('claude', 'work', LOGIN);
  await core.upsertAccount({ agent: 'claude', id: 'ci', kind: 'setup-token', createdAt: 't' });
  await core.writeAccountSecret(
    'claude',
    'ci',
    core.encodePastedSecret({ kind: 'setup-token', token: 'sk-ant-oat01-' + 'z'.repeat(20) }),
  );
  await core.upsertAccount({ agent: 'claude', id: 'nosecret', kind: 'login', createdAt: 't' });
});
afterAll(() => {
  process.env.HOME = realHome;
  rmSync(home, { recursive: true, force: true });
});

describe('custody push carries named accounts (llm-accounts Phase 4)', () => {
  it('uploads each named LOGIN under this machine, never a pasted secret', async () => {
    const items = await collectAgentCredentialUploads();
    const machine = getMachineId();
    expect(items.map((i) => i.path)).toEqual([
      `agents/claude/accounts/${machine}/work/.credentials.json`,
    ]);
    expect(items[0]!.data.toString()).toBe(LOGIN);
  });
  it('honours the agent filter', async () => {
    expect(await collectAgentCredentialUploads('codex')).toEqual([]);
  });
});
