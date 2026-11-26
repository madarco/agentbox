import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AGENT_SYNC_SPECS, upsertAccount, writeAccountSecret } from '@agentbox/sandbox-core';
import {
  accountAuthState,
  accountsInfoOf,
  createAccountBackend,
  parsePropagateOutput,
  subscriptionsOf,
} from '../lib/backend/accounts';

let dir: string;
let removed: string[];
let volumeAnswer: { removed: boolean; error?: string } = { removed: true };
let boxes: Array<{ name: string; accounts?: Record<string, string> }>;
const LOGIN = JSON.stringify({ claudeAiOauth: { refreshToken: 'r', expiresAt: 1 } });
const TOKEN = 'sk-ant-oat01-' + 'q'.repeat(24);

function backend() {
  return createAccountBackend({
    store: { path: join(dir, 'accounts.json'), stateDir: dir, specs: AGENT_SYNC_SPECS },
    boxes: () => Promise.resolve(boxes),
    removeVolume: (name) => {
      removed.push(name);
      return Promise.resolve(volumeAnswer);
    },
    // Never the real ~/.agentbox/machine-id.
    machineId: () => 'm-test',
  });
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agentbox-acct-api-'));
  removed = [];
  volumeAnswer = { removed: true };
  boxes = [{ name: 'b-work', accounts: { claude: 'work' } }, { name: 'b-default' }];
  const store = { path: join(dir, 'accounts.json'), stateDir: dir, specs: AGENT_SYNC_SPECS };
  await upsertAccount(
    { agent: 'claude', id: 'work', kind: 'login', label: 'Work', createdAt: 't' },
    store,
  );
  await writeAccountSecret('claude', 'work', LOGIN, store);
  await upsertAccount({ agent: 'claude', id: 'idle', kind: 'login', createdAt: 't' }, store);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('GET /api/v1/accounts (backend)', () => {
  it('lists accounts with the boxes using them, and the agents that take accounts; never a secret', async () => {
    const r = await backend().listAccounts();
    const work = r.accounts.find((a) => a.id === 'work')!;
    expect(work).toMatchObject({
      agent: 'claude',
      kind: 'login',
      label: 'Work',
      hasSecret: true,
      boxes: ['b-work'],
    });
    expect(r.accounts.find((a) => a.id === 'idle')).toMatchObject({ hasSecret: false, boxes: [] });
    expect(JSON.stringify(r)).not.toContain('refreshToken');
    expect(r.agents.map((a) => a.id)).toEqual(expect.arrayContaining(['claude', 'codex']));
  });

  it('names the machine the accounts belong to, the key custody files them under', async () => {
    const b = createAccountBackend({
      store: { path: join(dir, 'accounts.json'), stateDir: dir, specs: AGENT_SYNC_SPECS },
      boxes: () => Promise.resolve(boxes),
      machineId: () => 'm-hub',
    });
    expect((await b.listAccounts()).machine).toBe('m-hub');
  });
});

describe('POST /api/v1/accounts (backend)', () => {
  it('adds a setup token and never echoes it', async () => {
    const r = await backend().addPastedAccount({
      agent: 'claude',
      id: 'ci',
      kind: 'setup-token',
      token: TOKEN,
      label: 'CI',
    });
    expect(r.ok && r.value).toMatchObject({
      id: 'ci',
      kind: 'setup-token',
      label: 'CI',
      hasSecret: true,
    });
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });
  it('refuses a login, an unknown agent, a bad id, a short token, an existing id, and an unsupported kind', async () => {
    const b = backend();
    const code = async (input: unknown) => {
      const r = await b.addPastedAccount(input);
      return r.ok ? 'ok' : r.code;
    };
    expect(await code({ agent: 'claude', id: 'x1', kind: 'login', token: TOKEN })).toBe(
      'invalid_request',
    );
    expect(await code({ agent: 'nope', id: 'x1', kind: 'api-key', token: TOKEN })).toBe(
      'invalid_request',
    );
    expect(await code({ agent: 'claude', id: 'Bad Id', kind: 'api-key', token: TOKEN })).toBe(
      'invalid_request',
    );
    expect(await code({ agent: 'claude', id: 'x1', kind: 'api-key', token: 'short' })).toBe(
      'invalid_request',
    );
    expect(await code({ agent: 'claude', id: 'work', kind: 'api-key', token: TOKEN })).toBe(
      'conflict',
    );
    expect(await code({ agent: 'codex', id: 'x1', kind: 'setup-token', token: TOKEN })).toBe(
      'invalid_request',
    );
  });
});

describe('PATCH / DELETE /api/v1/accounts/:agent/:id (backend)', () => {
  it('relabels and clears a label', async () => {
    const b = backend();
    const r1 = await b.labelAccount('claude', 'idle', 'Spare');
    expect(r1.ok && r1.value.label).toBe('Spare');
    const r2 = await b.labelAccount('claude', 'idle', null);
    expect(r2.ok && r2.value.label).toBeUndefined();
    expect((await b.labelAccount('claude', 'nope', 'x')).ok).toBe(false);
  });
  it('removes an unused account and its volume; refuses one in use and the default', async () => {
    const b = backend();
    const inUse = await b.removeAccount('claude', 'work');
    expect(!inUse.ok && inUse.code).toBe('conflict');
    expect(!inUse.ok && inUse.error).toMatch(/b-work/);
    const def = await b.removeAccount('claude', 'default');
    expect(def.ok).toBe(false);
    const ok = await b.removeAccount('claude', 'idle');
    expect(ok.ok).toBe(true);
    expect(removed).toEqual(['agentbox-claude-config-acct-idle']);
    expect((await b.listAccounts()).accounts.map((a) => a.id)).not.toContain('idle');
  });
});

describe('accountsInfoOf (Box.accountsInfo)', () => {
  it('adds label + kind from the store; an unknown account keeps only its id', () => {
    const file = {
      accounts: [
        { agent: 'claude', id: 'work', kind: 'login' as const, label: 'Work', createdAt: 't' },
      ],
    };
    expect(accountsInfoOf({ claude: 'work', codex: 'gone' }, file)).toEqual([
      { agent: 'claude', account: 'work', label: 'Work', kind: 'login' },
      { agent: 'codex', account: 'gone' },
    ]);
    expect(accountsInfoOf(undefined, file)).toBeUndefined();
    expect(accountsInfoOf({ claude: 'default' }, file)).toBeUndefined();
  });
});

describe('removing an account whose volume docker cannot remove (review)', () => {
  it('still removes the account, and reports why the volume stayed', async () => {
    volumeAnswer = { removed: false, error: 'volume is in use - [abc]' };
    const r = await backend().removeAccount('claude', 'idle');
    expect(r.ok && r.value).toEqual({
      volumeRemoved: false,
      volumeError: 'could not remove agentbox-claude-config-acct-idle: volume is in use - [abc]',
    });
  });
  it('no such volume is not an error', async () => {
    volumeAnswer = { removed: false };
    const r = await backend().removeAccount('claude', 'idle');
    expect(r.ok && r.value).toEqual({ volumeRemoved: false });
  });
});

describe('account auth state (credentials-tui Phase 1)', () => {
  const NOW = Date.parse('2026-11-26T12:00:00Z');
  const login = { kind: 'login' as const, createdAt: '2026-01-01T00:00:00Z' };
  const ev = (o: { failedAt?: string; okAt?: string }) => ({
    failedAt: o.failedAt ?? null,
    error: o.failedAt ? 'authentication_failed' : null,
    failedBox: o.failedAt ? 'web' : null,
    okAt: o.okAt ?? null,
  });

  it('is revoked while the refusal is newer than every real reply and the stored secret', () => {
    expect(
      accountAuthState(
        login,
        ev({ failedAt: '2026-11-26T10:00:00Z', okAt: '2026-11-26T09:00:00Z' }),
        null,
        NOW,
      ),
    ).toEqual({
      state: 'revoked',
      since: '2026-11-26T10:00:00Z',
      box: 'web',
      detail: 'authentication_failed',
    });
  });
  it('a later real reply, or a newer secret (a renew), clears it', () => {
    expect(
      accountAuthState(
        login,
        ev({ failedAt: '2026-11-26T10:00:00Z', okAt: '2026-11-26T10:05:00Z' }),
        null,
        NOW,
      ).state,
    ).toBe('ok');
    expect(
      accountAuthState(
        login,
        ev({ failedAt: '2026-11-26T10:00:00Z' }),
        Date.parse('2026-11-26T11:00:00Z'),
        NOW,
      ).state,
    ).toBe('ok');
    expect(accountAuthState(login, null, null, NOW).state).toBe('ok');
  });
  it('a setup token is expiring in the last 30 days of its year', () => {
    const tok = (createdAt: string) =>
      accountAuthState({ kind: 'setup-token', createdAt }, null, null, NOW);
    expect(tok('2025-12-10T00:00:00Z')).toEqual({
      state: 'expiring',
      since: '2026-12-10T00:00:00.000Z',
    });
    expect(tok('2026-06-01T00:00:00Z').state).toBe('ok');
  });

  it('the list carries it, from the backend deps', async () => {
    const b = createAccountBackend({
      store: { path: join(dir, 'accounts.json'), stateDir: dir, specs: AGENT_SYNC_SPECS },
      boxes: () => Promise.resolve(boxes),
      machineId: () => 'm-test',
      authEvidence: (sub) =>
        Promise.resolve(sub === 'claude/work' ? ev({ failedAt: '2099-01-01T00:00:00Z' }) : null),
    });
    const r = await b.listAccounts();
    expect(r.accounts.find((a) => a.id === 'work')?.auth).toMatchObject({
      state: 'revoked',
      box: 'web',
    });
    expect(r.accounts.find((a) => a.id === 'idle')?.auth).toEqual({ state: 'ok' });
  });
});

describe('POST /api/v1/accounts/:agent/:id/renew (backend)', () => {
  it('fans a login out through propagate, the account named', async () => {
    const calls: string[] = [];
    const b = createAccountBackend({
      store: { path: join(dir, 'accounts.json'), stateDir: dir, specs: AGENT_SYNC_SPECS },
      boxes: () => Promise.resolve(boxes),
      machineId: () => 'm-test',
      runPropagate: (agent, id) => {
        calls.push(`${agent}/${id}`);
        return Promise.resolve({
          exitCode: 0,
          output:
            'pushed claude credential to volume v (b-work)\npropagated claude credential to 1 target(s)\n{"pushed":1,"failed":0}\n',
        });
      },
    });
    const r = await b.renewAccount('claude', 'work');
    expect(calls).toEqual(['claude/work']);
    expect(r.ok && r.value).toEqual({
      pushed: 1,
      failed: 0,
      output: [
        'pushed claude credential to volume v (b-work)',
        'propagated claude credential to 1 target(s)',
      ],
    });
    expect((await b.renewAccount('claude', 'nope')).ok).toBe(false);
  });
  it('refuses a pasted kind', async () => {
    const b = backend();
    await b.addPastedAccount({ agent: 'claude', id: 'ci', kind: 'setup-token', token: TOKEN });
    const r = await b.renewAccount('claude', 'ci');
    expect(!r.ok && r.code).toBe('invalid_request');
  });
  it('reads the counts off the JSON summary line', () => {
    expect(
      parsePropagateOutput(
        'a: boom\npropagated claude credential to 2 target(s), 1 failed\n{"pushed":2,"failed":1}\n',
        1,
      ),
    ).toEqual({
      pushed: 2,
      failed: 1,
      output: ['a: boom', 'propagated claude credential to 2 target(s), 1 failed'],
    });
    // It died before the summary.
    expect(parsePropagateOutput('no usable claude credential\n', 1)).toMatchObject({
      pushed: 0,
      failed: 1,
    });
  });
});

describe('Box.subscriptions', () => {
  it("names each agent's subscription, a borrower under its lender", () => {
    expect(subscriptionsOf({ agents: ['claude'], accounts: { claude: 'work' } })).toEqual({
      claude: 'claude/work',
    });
    expect(subscriptionsOf({ lastAgent: 'claude' })).toEqual({ claude: 'claude/default' });
    expect(subscriptionsOf({})).toBeUndefined();
  });
});
