import { describe, expect, it } from 'vitest';
import {
  accountCloudSubpath,
  accountConfigVolume,
  accountCustodyPath,
  accountIdProblem,
  accountKindProblem,
  accountSecretPath,
  agentAccountKinds,
  agentIdProblem,
  DEFAULT_ACCOUNT_ID,
  findAccount,
  migrateAccountsFile,
  type AgentSyncSpec,
} from '../src/index.js';

const spec = (over: Partial<AgentSyncSpec> = {}): AgentSyncSpec =>
  ({
    id: 'claude',
    dockerVolume: 'agentbox-claude-config',
    credential: {
      boxRelPath: '.credentials.json',
      boxAbsPath: '/home/vscode/.claude/.credentials.json',
      hostBackup: '/home/u/.agentbox/claude-credentials.json',
      cloudMountPath: '/home/vscode/.agentbox-creds/claude',
      cloudSubpath: 'claude/',
      realShape: 'claude-oauth',
    },
    accountKinds: ['login', 'setup-token', 'api-key'],
    ...over,
  }) as AgentSyncSpec;

describe('accountIdProblem', () => {
  it.each(['default', 'work', 'a', 'team-2', 'b1234abcd', 'x'.repeat(32)])('accepts %s', (id) => {
    expect(accountIdProblem(id)).toBeNull();
  });
  it.each(['', 'Work', '-a', 'a-', 'a.b', 'a/b', 'a_b', 'auth.json', 'x'.repeat(33), '..'])(
    'rejects %j',
    (id) => {
      expect(accountIdProblem(id)).toMatch(/lowercase/);
    },
  );
});

describe('account kinds', () => {
  it('absent accountKinds means no named accounts', () => {
    const s = spec({ accountKinds: undefined });
    expect(agentAccountKinds(s)).toEqual([]);
    expect(accountKindProblem(s, 'login')).toMatch(/does not support named accounts/);
  });
  it('refuses a kind the agent does not list', () => {
    const s = spec({ id: 'codex', accountKinds: ['login', 'api-key'] });
    expect(accountKindProblem(s, 'api-key')).toBeNull();
    expect(accountKindProblem(s, 'setup-token')).toMatch(/supported: login, api-key/);
  });
});

describe('per-account names', () => {
  it('default maps to every legacy single-slot name', () => {
    const s = spec();
    expect(accountSecretPath(s, DEFAULT_ACCOUNT_ID, '/home/u/.agentbox')).toBe(
      '/home/u/.agentbox/claude-credentials.json',
    );
    expect(accountCustodyPath('claude', 'default', '.credentials.json')).toBe(
      'agents/claude/.credentials.json',
    );
    expect(accountConfigVolume('agentbox-claude-config', 'default')).toBe('agentbox-claude-config');
    expect(accountCloudSubpath('claude/', 'default')).toBe('claude/');
  });

  it('named accounts get their own names', () => {
    const s = spec();
    expect(accountSecretPath(s, 'work', '/home/u/.agentbox')).toBe(
      '/home/u/.agentbox/credentials/claude/work.json',
    );
    expect(accountCustodyPath('codex', 'work', 'auth.json')).toBe(
      'agents/codex/accounts/work/auth.json',
    );
    expect(accountCloudSubpath('claude/', 'work')).toBe('claude-acct-work/');
    expect(accountCloudSubpath('claude', 'work')).toBe('claude-acct-work/');
  });

  it('a named Daytona subpath is a sibling, never inside the mounted default subtree', () => {
    expect(accountCloudSubpath('claude/', 'work').startsWith('claude/')).toBe(false);
  });

  it('a named custody path never nests under a dotless default file', () => {
    // A plugin credential `token` with an account also named `token`.
    const def = accountCustodyPath('foo', 'default', 'token');
    const named = accountCustodyPath('foo', 'token', 'token');
    expect(named.startsWith(`${def}/`)).toBe(false);
  });

  it('an account volume cannot collide with a per-box isolated volume', () => {
    // `box.isolateClaudeConfig` mints `<volume>-<boxId>`; a box id is a valid slug.
    const boxId = 'b1234abcd';
    expect(accountConfigVolume('agentbox-claude-config', boxId)).not.toBe(
      `agentbox-claude-config-${boxId}`,
    );
    expect(accountConfigVolume('agentbox-claude-config', 'work')).toBe(
      'agentbox-claude-config-acct-work',
    );
  });

  it('never builds a secret path from an unsafe agent or account id (review #6)', () => {
    expect(() => accountSecretPath(spec({ id: '../../x' }), 'work', '/s')).toThrow(/agent id/);
    expect(() => accountSecretPath(spec(), '../x', '/s')).toThrow(/lowercase/);
  });

  it('default has no secret path for an agent without a credential', () => {
    expect(accountSecretPath(spec({ credential: undefined }), 'default', '/s')).toBeUndefined();
  });
});

describe('migrateAccountsFile', () => {
  const legacy = [{ agent: 'claude', createdAt: '2026-01-01T00:00:00.000Z' }];

  it('a missing file plus a legacy login yields one default login account', () => {
    expect(migrateAccountsFile(undefined, legacy)).toEqual({
      version: 1,
      accounts: [
        { agent: 'claude', id: 'default', kind: 'login', createdAt: '2026-01-01T00:00:00.000Z' },
      ],
    });
  });

  it('no file and no legacy login yields no accounts', () => {
    expect(migrateAccountsFile(undefined, [])).toEqual({ version: 1, accounts: [] });
  });

  it('a stored default row is hidden while its legacy login is gone', () => {
    const raw = {
      accounts: [{ agent: 'claude', id: 'default', kind: 'login', label: 'P', createdAt: 'x' }],
    };
    expect(migrateAccountsFile(raw, []).accounts).toEqual([]);
  });

  it('drops rows the accept rule refuses, and an invalid default does not hide the fold', () => {
    const raw = {
      accounts: [
        { agent: 'claude', id: 'default', kind: 'api-key', createdAt: 'x' },
        { agent: 'gone', id: 'work', kind: 'login', createdAt: 'x' },
      ],
    };
    const out = migrateAccountsFile(raw, legacy, {
      accept: (a) => a.agent === 'claude' && a.kind === 'login',
    });
    expect(out.accounts).toEqual([
      { agent: 'claude', id: 'default', kind: 'login', createdAt: '2026-01-01T00:00:00.000Z' },
    ]);
  });

  it('an existing default row wins over the legacy slot', () => {
    const raw = {
      version: 1,
      accounts: [
        { agent: 'claude', id: 'default', kind: 'login', label: 'Personal', createdAt: 'x' },
      ],
    };
    const out = migrateAccountsFile(raw, legacy);
    expect(out.accounts).toHaveLength(1);
    expect(out.accounts[0]!.label).toBe('Personal');
  });

  it('drops malformed rows and duplicates, keeps the rest', () => {
    const raw = {
      version: 1,
      accounts: [
        { agent: 'claude', id: 'work', kind: 'setup-token', createdAt: 't' },
        { agent: 'claude', id: 'work', kind: 'api-key', createdAt: 't2' },
        { agent: 'claude', id: 'Bad Id', kind: 'login', createdAt: 't' },
        { agent: 'claude', id: 'x', kind: 'password', createdAt: 't' },
        { agent: '', id: 'y', kind: 'login', createdAt: 't' },
        { agent: 'codex', id: 'z', kind: 'login' },
        null,
        'nope',
      ],
    };
    const out = migrateAccountsFile(raw, []);
    expect(out.accounts).toEqual([
      { agent: 'claude', id: 'work', kind: 'setup-token', createdAt: 't' },
    ]);
  });

  it('keeps only known identity fields', () => {
    const raw = {
      accounts: [
        {
          agent: 'claude',
          id: 'work',
          kind: 'login',
          createdAt: 't',
          identity: { email: 'a@b.c', org: '', token: 'secret' },
        },
      ],
    };
    expect(migrateAccountsFile(raw, []).accounts[0]!.identity).toEqual({ email: 'a@b.c' });
  });

  it('tolerates a non-object or wrong-shape file', () => {
    expect(migrateAccountsFile('garbage', legacy).accounts).toHaveLength(1);
    expect(migrateAccountsFile({ accounts: 'x' }, []).accounts).toEqual([]);
  });

  it('is idempotent', () => {
    const once = migrateAccountsFile(
      { accounts: [{ agent: 'codex', id: 'work', kind: 'api-key', createdAt: 't' }] },
      legacy,
    );
    expect(migrateAccountsFile(once, legacy)).toEqual(once);
    expect(findAccount(once, 'claude', 'default')?.kind).toBe('login');
    expect(findAccount(once, 'codex', 'default')).toBeUndefined();
  });
});

describe('agentIdProblem', () => {
  it.each(['claude', 'codex', 'opencode', 'pi', 'openclaw', 'example', 'my_agent-2'])(
    'accepts %s',
    (id) => expect(agentIdProblem(id)).toBeNull(),
  );
  it.each(['', '../x', 'a/b', 'A', '-a', '.x', 'x'.repeat(65)])('rejects %j', (id) =>
    expect(agentIdProblem(id)).toMatch(/agent id/),
  );
});

describe('migrateAccountsFile canonicalAgent (review #8)', () => {
  it('canonicalizes before de-duplicating', () => {
    const raw = {
      accounts: [
        { agent: 'claude-code', id: 'work', kind: 'login', label: 'A', createdAt: 't' },
        { agent: 'claude', id: 'work', kind: 'login', label: 'B', createdAt: 't' },
      ],
    };
    const out = migrateAccountsFile(raw, [], {
      canonicalAgent: (a) => (a === 'claude-code' ? 'claude' : a),
    });
    expect(out.accounts).toEqual([
      { agent: 'claude', id: 'work', kind: 'login', label: 'A', createdAt: 't' },
    ]);
  });
});
