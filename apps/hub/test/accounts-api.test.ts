import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// removeAccount reads the global config and walks ~/.agentbox/projects, and
// config paths are fixed from $HOME at import: move HOME before any import.
const HOME = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync: mk } = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir: td } = require('node:os') as typeof import('node:os');
  const home = mk(`${td()}/agentbox-acct-api-`);
  process.env.HOME = home;
  return home;
});
afterAll(() => rmSync(HOME, { recursive: true, force: true }));

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
  await upsertAccount({ agent: 'claude', id: 'work', kind: 'login', createdAt: 't' }, store);
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
    });
    expect(r.ok && r.value).toMatchObject({
      id: 'ci',
      kind: 'setup-token',
      hasSecret: true,
    });
    expect(r.ok && r.value).not.toHaveProperty('label');
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });
  it('normalizes a new name, keeps an existing one as is, refuses the rest', async () => {
    const b = backend();
    const r = await b.addPastedAccount({
      agent: 'claude',
      id: 'Work Max',
      kind: 'setup-token',
      token: TOKEN,
    });
    expect(r.ok && r.value.id).toBe('work_max');
    const bad = await b.addPastedAccount({
      agent: 'claude',
      id: 'bad.name',
      kind: 'setup-token',
      token: TOKEN,
    });
    expect(!bad.ok && bad.error).toMatch(/not a usable name/);
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
    expect(await code({ agent: 'claude', id: 'Bad.Id', kind: 'api-key', token: TOKEN })).toBe(
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

describe('DELETE /api/v1/accounts/:agent/:id (backend)', () => {
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
  it('adds the kind from the store; an unknown account keeps only its id', () => {
    const file = {
      accounts: [{ agent: 'claude', id: 'work', kind: 'login' as const, createdAt: 't' }],
    };
    expect(accountsInfoOf({ claude: 'work', codex: 'gone' }, file)).toEqual([
      { agent: 'claude', account: 'work', kind: 'login' },
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
  const box = (o: { box?: string; failedAt?: string; okAt?: string }) => ({
    box: o.box ?? 'web',
    failedAt: o.failedAt ?? null,
    error: o.failedAt ? 'authentication_failed' : null,
    okAt: o.okAt ?? null,
  });
  const ev = (o: { failedAt?: string; okAt?: string }) => ({ boxes: [box(o)] });

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
  it("one box's real reply does not hide another box's refusal", () => {
    const r = accountAuthState(
      login,
      {
        boxes: [
          box({ box: 'a', okAt: '2026-11-26T11:00:00Z' }),
          box({ box: 'b', failedAt: '2026-11-26T10:00:00Z', okAt: '2026-11-26T09:00:00Z' }),
          box({ box: 'c', failedAt: '2026-11-26T08:00:00Z', okAt: '2026-11-26T08:30:00Z' }),
        ],
      },
      null,
      NOW,
    );
    expect(r).toMatchObject({ state: 'revoked', box: 'b', since: '2026-11-26T10:00:00Z' });
  });
  it("names the signal: a box's signed-out login file (Phase 4)", () => {
    const r = accountAuthState(
      login,
      {
        boxes: [
          {
            box: 'web',
            failedAt: '2026-11-26T10:00:00Z',
            error: 'credentials-dead',
            source: 'box' as const,
            okAt: null,
          },
        ],
      },
      null,
      NOW,
    );
    expect(r).toEqual({
      state: 'revoked',
      since: '2026-11-26T10:00:00Z',
      box: 'web',
      detail: 'credentials-dead',
      source: 'box',
    });
    // A renew (newer secret) clears it like any refusal.
    expect(
      accountAuthState(
        login,
        {
          boxes: [
            {
              box: 'web',
              failedAt: '2026-11-26T10:00:00Z',
              error: 'credentials-dead',
              source: 'box' as const,
              okAt: null,
            },
          ],
        },
        Date.parse('2026-11-26T11:00:00Z'),
        NOW,
      ).state,
    ).toBe('ok');
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

describe('GET /api/v1/accounts: the default login and a corrupt store', () => {
  it("lists default from the agent's own login file when it was never backed up", async () => {
    const { mkdirSync, writeFileSync } = await import('node:fs');
    mkdirSync(join(HOME, '.claude'), { recursive: true });
    writeFileSync(join(HOME, '.claude', '.credentials.json'), LOGIN);
    try {
      const r = await backend().listAccounts();
      expect(r.accounts.find((a) => a.agent === 'claude' && a.id === 'default')).toMatchObject({
        kind: 'login',
        hasSecret: true,
      });
    } finally {
      rmSync(join(HOME, '.claude'), { recursive: true, force: true });
    }
  });

  it('reports an untrustworthy accounts.json by name instead of hiding its accounts', async () => {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(dir, 'accounts.json'), '{not json');
    const r = await backend().listAccounts();
    expect(r.storeError).toContain(join(dir, 'accounts.json'));
    expect(r.storeError).toContain('.bak');
    expect(r.accounts.some((a) => a.id === 'work')).toBe(false);
  });
});
