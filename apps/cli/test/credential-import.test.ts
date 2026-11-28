import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Scratch HOME before the imports: the account store, the default backup and
// the machine id all live under it.
const home = mkdtempSync(join(tmpdir(), 'agentbox-cred-import-'));
const realHome = process.env.HOME;
process.env.HOME = home;
const { collectAccountImportItems, describeImportResult, pullNamedLoginsFromHub } =
  await import('../src/control-plane/credential-import.js');
const core = await import('@agentbox/sandbox-core');
const { getMachineId } = await import('@agentbox/config');

const login = (expiresAt: number) =>
  JSON.stringify({ claudeAiOauth: { refreshToken: 'r', expiresAt, accountUuid: 'u1' } });
const TOKEN = core.encodePastedSecret({
  kind: 'setup-token',
  token: 'sk-ant-oat01-' + 'z'.repeat(30),
});

beforeAll(async () => {
  await core.writeCredentialBackup('claude', login(10));
  await core.upsertAccount({ agent: 'claude', id: 'second', kind: 'login', createdAt: 't' });
  await core.writeAccountSecret('claude', 'second', login(100));
  await core.upsertAccount({ agent: 'claude', id: 'ci', kind: 'setup-token', createdAt: 't' });
  await core.writeAccountSecret('claude', 'ci', TOKEN);
});
afterAll(() => {
  process.env.HOME = realHome;
  rmSync(home, { recursive: true, force: true });
});

describe('collectAccountImportItems (llm-accounts Phase 9)', () => {
  it('sends the default login, every named login and every pasted key, keyed by this machine', async () => {
    const items = await collectAccountImportItems({ only: 'claude' });
    const machine = getMachineId();
    expect(items.map((i) => `${i.id}:${i.kind}`)).toEqual([
      'default:login',
      'second:login',
      'ci:setup-token',
    ]);
    expect(items.every((i) => i.machine === machine)).toBe(true);
    expect((await collectAccountImportItems({ only: 'codex' })).length).toBe(0);
  });

  it('describes a rename with the name that still works here', () => {
    expect(
      describeImportResult({
        agent: 'claude',
        id: 'second',
        hubId: 'second_2',
        action: 'renamed',
        reason: 'taken',
      }),
    ).toContain("as claude/second_2 (taken); a create here naming 'second' uses it");
    expect(
      describeImportResult({ agent: 'claude', id: 'x', action: 'kept', reason: 'r' }),
    ).toBeNull();
  });
});

describe('pullNamedLoginsFromHub', () => {
  it("brings the hub's newer copy back under this PC's own name, never an older one", async () => {
    const machine = getMachineId();
    const hubMachine = 'hub-machine';
    const list = {
      machine: hubMachine,
      agents: [],
      accounts: [
        {
          agent: 'claude',
          id: 'second_2',
          kind: 'login' as const,
          hasSecret: true,
          boxes: [],
          importedFrom: [{ machine, id: 'second' }],
        },
      ],
    };
    const path = `agents/claude/accounts/${hubMachine}/second_2/.credentials.json`;
    const newer = await pullNamedLoginsFromHub({
      list,
      get: (p) => Promise.resolve(p === path ? Buffer.from(login(500)) : null),
    });
    expect(newer).toEqual({ pulled: ['claude/second'], kept: [] });
    expect(
      JSON.parse((await core.readAccountSecret('claude', 'second'))!).claudeAiOauth.expiresAt,
    ).toBe(500);
    const older = await pullNamedLoginsFromHub({
      list,
      get: () => Promise.resolve(Buffer.from(login(200))),
    });
    expect(older).toEqual({ pulled: [], kept: ['claude/second'] });
  });
});
