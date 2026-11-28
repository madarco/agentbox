import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentSyncSpec, LlmAccount } from '@agentbox/core';
import {
  AccountsFileError,
  accountProblem,
  accountsFileProblem,
  defaultLoginPaths,
  purgeAgentAccounts,
  storedAccountIds,
  decodePastedSecret,
  encodePastedSecret,
  pastedSecretProblem,
  resolveLoginAccount,
  readAccounts,
  readAccountSecret,
  removeAccount,
  upsertAccount,
  writeAccountSecret,
  type AccountStoreOptions,
} from '../src/llm-accounts.js';

let dir: string;
let opts: AccountStoreOptions;
let claudeBackup: string;

const specsFor = (d: string): AgentSyncSpec[] => [
  {
    id: 'claude',
    credential: {
      boxRelPath: '.credentials.json',
      boxAbsPath: '/home/vscode/.claude/.credentials.json',
      hostBackup: join(d, 'claude-credentials.json'),
      cloudMountPath: '/home/vscode/.agentbox-creds/claude',
      cloudSubpath: 'claude/',
      realShape: 'claude-oauth',
    },
    accountKinds: ['login', 'setup-token', 'api-key'],
    aliases: ['claude-code'],
  } as unknown as AgentSyncSpec,
  {
    id: 'codex',
    credential: {
      boxRelPath: 'auth.json',
      boxAbsPath: '/home/vscode/.codex/auth.json',
      hostBackup: join(d, 'codex-credentials.json'),
      cloudMountPath: '/home/vscode/.agentbox-creds/codex',
      cloudSubpath: 'codex/',
      realShape: 'nonempty-json',
    },
    accountKinds: ['login', 'api-key'],
  } as unknown as AgentSyncSpec,
  { id: 'openclaw' } as AgentSyncSpec,
];

const REAL_CLAUDE = JSON.stringify({ claudeAiOauth: { accessToken: 'a', refreshToken: 'r' } });

const acct = (over: Partial<LlmAccount> = {}): LlmAccount => ({
  agent: 'claude',
  id: 'work',
  kind: 'setup-token',
  createdAt: '2026-11-22T00:00:00.000Z',
  ...over,
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agentbox-accounts-'));
  claudeBackup = join(dir, 'claude-credentials.json');
  opts = { path: join(dir, 'accounts.json'), stateDir: dir, specs: specsFor(dir) };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('default migration', () => {
  it('an existing legacy login reads as account default with no file written', async () => {
    writeFileSync(claudeBackup, REAL_CLAUDE);
    const file = await readAccounts(opts);
    expect(file.accounts).toEqual([
      expect.objectContaining({ agent: 'claude', id: 'default', kind: 'login' }),
    ]);
    expect(existsSync(opts.path!)).toBe(false);
  });

  it('a placeholder backup is not a login', async () => {
    writeFileSync(claudeBackup, JSON.stringify({ claudeAiOauth: { accessToken: 'a' } }));
    writeFileSync(join(dir, 'codex-credentials.json'), '{}');
    expect((await readAccounts(opts)).accounts).toEqual([]);
  });

  it('the first mutation persists the migrated default alongside the new row', async () => {
    writeFileSync(claudeBackup, REAL_CLAUDE);
    await upsertAccount(acct(), opts);
    const onDisk = JSON.parse(readFileSync(opts.path!, 'utf8')) as { accounts: LlmAccount[] };
    expect(onDisk.accounts.map((a) => a.id).sort()).toEqual(['default', 'work']);
    expect(statSync(opts.path!).mode & 0o777).toBe(0o600);
  });

  it('a stored default is listed only while its legacy login is real', async () => {
    writeFileSync(claudeBackup, REAL_CLAUDE);
    await upsertAccount(acct({ id: 'default', kind: 'login' }), opts);
    rmSync(claudeBackup);
    expect((await readAccounts(opts)).accounts).toEqual([]);
    writeFileSync(claudeBackup, REAL_CLAUDE);
    expect((await readAccounts(opts)).accounts).toEqual([
      expect.objectContaining({ id: 'default' }),
    ]);
  });

  it('uses the passed spec realShape, not the global registry', async () => {
    const custom = [{ ...specsFor(dir)[0]!, id: 'myagent', aliases: [] } as AgentSyncSpec];
    writeFileSync(claudeBackup, JSON.stringify({ claudeAiOauth: { accessToken: 'a' } }));
    expect((await readAccounts({ ...opts, specs: custom })).accounts).toEqual([]);
  });

  it('drops hand-edited rows the write rules refuse', async () => {
    writeFileSync(claudeBackup, REAL_CLAUDE);
    writeFileSync(
      opts.path!,
      JSON.stringify({
        version: 1,
        accounts: [
          { agent: 'claude', id: 'default', kind: 'api-key', createdAt: 't' },
          { agent: 'codex', id: 'work', kind: 'setup-token', createdAt: 't' },
          { agent: 'uninstalled', id: 'work', kind: 'login', createdAt: 't' },
        ],
      }),
    );
    expect((await readAccounts(opts)).accounts).toEqual([
      expect.objectContaining({ agent: 'claude', id: 'default', kind: 'login' }),
    ]);
  });

  it('an alias resolves to the canonical agent id', async () => {
    await upsertAccount(acct({ agent: 'claude-code' }), opts);
    expect((await readAccounts(opts)).accounts[0]!.agent).toBe('claude');
    expect(await removeAccount('claude-code', 'work', opts)).toBe(true);
  });

  it('a corrupt index still shows the default login', async () => {
    writeFileSync(claudeBackup, REAL_CLAUDE);
    writeFileSync(opts.path!, '{not json');
    expect((await readAccounts(opts)).accounts.map((a) => a.id)).toEqual(['default']);
  });
});

describe('accountProblem', () => {
  const specs = specsFor('/x');
  it('accepts a supported named account', () => {
    expect(accountProblem(acct(), specs)).toBeNull();
  });
  it('refuses unknown agents, bad ids and unsupported kinds', () => {
    expect(accountProblem(acct({ agent: 'nope' }), specs)).toMatch(/unknown agent/);
    expect(accountProblem(acct({ id: 'Work' }), specs)).toMatch(/lowercase/);
    expect(accountProblem(acct({ agent: 'codex' }), specs)).toMatch(/setup-token/);
    expect(accountProblem(acct({ agent: 'openclaw', kind: 'login' }), specs)).toMatch(
      /does not support named accounts/,
    );
  });
  it('default must be a login on an agent with a credential', () => {
    expect(accountProblem(acct({ id: 'default', kind: 'login' }), specs)).toBeNull();
    expect(accountProblem(acct({ id: 'default', kind: 'api-key' }), specs)).toMatch(
      /default account is the agent's login/,
    );
    expect(
      accountProblem(acct({ agent: 'openclaw', id: 'default', kind: 'login' }), specs),
    ).toMatch(/no credential/);
  });
});

describe('upsert / remove / secrets', () => {
  it('upsert refuses an invalid account and writes nothing', async () => {
    await expect(upsertAccount(acct({ agent: 'codex' }), opts)).rejects.toThrow(/setup-token/);
    expect(existsSync(opts.path!)).toBe(false);
  });

  it('upsert replaces the same (agent, id) and keeps other agents apart', async () => {
    await upsertAccount(acct(), opts);
    await upsertAccount(acct({ agent: 'codex', kind: 'api-key' }), opts);
    await upsertAccount(acct({ kind: 'setup-token' }), opts);
    const file = await readAccounts(opts);
    expect(file.accounts).toHaveLength(2);
    expect(file.accounts.find((a) => a.agent === 'claude')?.kind).toBe('setup-token');
  });

  it('named secrets live under credentials/<agent>/<id>.json at 0600', async () => {
    await upsertAccount(acct(), opts);
    const secret = encodePastedSecret({ kind: 'setup-token', token: 'tok' });
    const res = await writeAccountSecret('claude', 'work', secret, opts);
    expect(res).toMatchObject({
      written: true,
      path: join(dir, 'credentials', 'claude', 'work.json'),
    });
    expect(statSync(res.path).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'credentials', 'claude')).mode & 0o777).toBe(0o700);
    expect(decodePastedSecret((await readAccountSecret('claude', 'work', opts))!)).toEqual({
      kind: 'setup-token',
      token: 'tok',
    });
    // The two agents' `work` accounts never share a file.
    expect(await readAccountSecret('codex', 'work', opts)).toBeNull();
  });

  it('the default secret IS the legacy backup', async () => {
    writeFileSync(claudeBackup, REAL_CLAUDE);
    expect(await readAccountSecret('claude', 'default', opts)).toBe(REAL_CLAUDE);
    expect(await readAccountSecret('openclaw', 'default', opts)).toBeNull();
  });

  it('a bad id is never turned into a path', async () => {
    await expect(writeAccountSecret('claude', '../x', 's', opts)).rejects.toThrow(/lowercase/);
    expect(await readAccountSecret('claude', '../x', opts)).toBeNull();
  });

  it('remove drops the row and the secret, and refuses default', async () => {
    await upsertAccount(acct(), opts);
    const { path } = await writeAccountSecret(
      'claude',
      'work',
      encodePastedSecret({ kind: 'setup-token', token: 't' }),
      opts,
    );
    expect(await removeAccount('claude', 'work', opts)).toBe(true);
    expect(existsSync(path)).toBe(false);
    expect((await readAccounts(opts)).accounts).toEqual([]);
    expect(await removeAccount('claude', 'work', opts)).toBe(false);
    await expect(removeAccount('claude', 'default', opts)).rejects.toThrow(/cannot be removed/);
  });

  it('remove never turns a bad id into a path', async () => {
    writeFileSync(claudeBackup, REAL_CLAUDE);
    await expect(removeAccount('claude', '../../claude-credentials', opts)).rejects.toThrow(
      /lowercase/,
    );
    expect(existsSync(claudeBackup)).toBe(true);
  });
});

const claudeLogin = (expiresAt: number): string =>
  JSON.stringify({ claudeAiOauth: { accessToken: 'a', refreshToken: 'r', expiresAt } });

describe('writeAccountSecret guards (review #3)', () => {
  // The freshness rule rides the spec: give the test claude spec claude's real one.
  const withFreshness = (d: string): AgentSyncSpec[] => {
    const specs = specsFor(d);
    specs[0] = {
      ...specs[0]!,
      credential: {
        ...specs[0]!.credential!,
        freshness: { jsonPath: ['claudeAiOauth', 'expiresAt'] },
      },
    };
    return specs;
  };

  it('refuses the default account: the legacy backup has its own guarded writer', async () => {
    writeFileSync(claudeBackup, claudeLogin(200));
    await expect(writeAccountSecret('claude', 'default', claudeLogin(100), opts)).rejects.toThrow(
      /writeCredentialBackup/,
    );
    expect(readFileSync(claudeBackup, 'utf8')).toBe(claudeLogin(200));
  });

  it('refuses a secret for an account with no row', async () => {
    await expect(
      writeAccountSecret(
        'claude',
        'work',
        encodePastedSecret({ kind: 'api-key', token: 'k' }),
        opts,
      ),
    ).rejects.toThrow(/add it first/);
  });

  it('a login account takes only a real, strictly newer credential', async () => {
    const o = { ...opts, specs: withFreshness(dir) };
    await upsertAccount(acct({ kind: 'login' }), o);
    expect((await writeAccountSecret('claude', 'work', claudeLogin(200), o)).written).toBe(true);
    const older = await writeAccountSecret('claude', 'work', claudeLogin(100), o);
    expect(older).toMatchObject({ written: false, reason: 'not newer than backup' });
    expect(await readAccountSecret('claude', 'work', o)).toBe(claudeLogin(200));
    await expect(
      writeAccountSecret(
        'claude',
        'work',
        encodePastedSecret({ kind: 'setup-token', token: 't' }),
        o,
      ),
    ).rejects.toThrow(/not a usable/);
    expect((await writeAccountSecret('claude', 'work', claudeLogin(300), o)).written).toBe(true);
  });

  it("a pasted account takes only its own kind's encoding", async () => {
    await upsertAccount(acct({ kind: 'setup-token' }), opts);
    await expect(writeAccountSecret('claude', 'work', claudeLogin(1), opts)).rejects.toThrow(
      /encoded setup-token/,
    );
    await expect(
      writeAccountSecret(
        'claude',
        'work',
        encodePastedSecret({ kind: 'api-key', token: 'k' }),
        opts,
      ),
    ).rejects.toThrow(/encoded setup-token/);
  });

  it('tightens an existing loose credentials dir (review #7)', async () => {
    mkdirSync(join(dir, 'credentials', 'claude'), { recursive: true, mode: 0o755 });
    chmodSync(join(dir, 'credentials'), 0o755);
    chmodSync(join(dir, 'credentials', 'claude'), 0o755);
    await upsertAccount(acct(), opts);
    await writeAccountSecret(
      'claude',
      'work',
      encodePastedSecret({ kind: 'setup-token', token: 't' }),
      opts,
    );
    expect(statSync(join(dir, 'credentials')).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, 'credentials', 'claude')).mode & 0o777).toBe(0o700);
  });
});

describe('writes never round-trip the view (review #1)', () => {
  it('a process that cannot validate a row passes it through untouched', async () => {
    // A newer process (or one that loaded agent `foo`) wrote these.
    const foreign = [
      { agent: 'foo', id: 'work', kind: 'login', createdAt: 't' },
      { agent: 'claude', id: 'later', kind: 'oauth-v2', createdAt: 't', extra: 1 },
    ];
    writeFileSync(opts.path!, JSON.stringify({ version: 1, accounts: foreign }));
    await upsertAccount(acct(), opts);
    await removeAccount('claude', 'work', opts);
    await upsertAccount(acct({ agent: 'codex', kind: 'api-key' }), opts);
    const onDisk = JSON.parse(readFileSync(opts.path!, 'utf8')) as { accounts: unknown[] };
    expect(onDisk.accounts).toEqual([
      ...foreign,
      expect.objectContaining({ agent: 'codex', id: 'work' }),
    ]);
    // ...while the read view leaves them out.
    expect((await readAccounts(opts)).accounts.map((a) => `${a.agent}/${a.id}`)).toEqual([
      'codex/work',
    ]);
  });

  it('defaults to the live registry, not a module-load snapshot', async () => {
    // No `specs` passed: the built-in registry answers. Paths stay in the temp dir.
    const live = { path: opts.path, stateDir: dir };
    await upsertAccount(acct(), live);
    // (The real host's legacy logins may show up as `default` too; reads only.)
    expect((await readAccounts(live)).accounts).toEqual(
      expect.arrayContaining([expect.objectContaining({ agent: 'claude', id: 'work' })]),
    );
  });
});

describe('an untrustworthy accounts.json (review #2)', () => {
  it.each([
    ['corrupt JSON', '{not json'],
    ['an array', '[]'],
    ['null', 'null'],
    ['a future version', JSON.stringify({ version: 2, accounts: [] })],
  ])('reads leniently but mutations refuse: %s', async (_name, text) => {
    writeFileSync(claudeBackup, REAL_CLAUDE);
    writeFileSync(opts.path!, text);
    expect((await readAccounts(opts)).accounts.map((a) => a.id)).toEqual(['default']);
    await expect(upsertAccount(acct(), opts)).rejects.toThrow(AccountsFileError);
    await expect(removeAccount('claude', 'work', opts)).rejects.toThrow(/Refusing to rewrite/);
    expect(readFileSync(opts.path!, 'utf8')).toBe(text);
  });
});

describe('alias rows (review #8)', () => {
  it('an alias row and its canonical row are one account', async () => {
    writeFileSync(
      opts.path!,
      JSON.stringify({
        version: 1,
        accounts: [
          { agent: 'claude-code', id: 'work', kind: 'setup-token', createdAt: 'A' },
          { agent: 'claude', id: 'work', kind: 'setup-token', createdAt: 'B' },
        ],
      }),
    );
    expect((await readAccounts(opts)).accounts).toEqual([
      expect.objectContaining({ agent: 'claude', id: 'work', createdAt: 'A' }),
    ]);
    // An upsert replaces both spellings.
    await upsertAccount(acct({ createdAt: 'C' }), opts);
    const onDisk = JSON.parse(readFileSync(opts.path!, 'utf8')) as { accounts: LlmAccount[] };
    expect(onDisk.accounts).toEqual([expect.objectContaining({ agent: 'claude', createdAt: 'C' })]);
  });
});

describe('pasted secret codec', () => {
  it('round-trips and rejects anything else', () => {
    const s = { kind: 'api-key', token: 'k' } as const;
    expect(decodePastedSecret(encodePastedSecret(s))).toEqual(s);
    expect(decodePastedSecret(REAL_CLAUDE)).toBeNull();
    expect(decodePastedSecret('{"kind":"login","token":"x"}')).toBeNull();
    expect(decodePastedSecret('{"kind":"api-key","token":""}')).toBeNull();
    expect(decodePastedSecret('nope')).toBeNull();
  });
});

describe('resolveLoginAccount (Phase 2)', () => {
  const claude = specsFor('/x')[0]!;
  const codex = specsFor('/x')[1]!;

  it('no --account is the plain default login', () => {
    expect(resolveLoginAccount(claude, {})).toBeNull();
    expect(resolveLoginAccount(claude, { account: 'default' })).toBeNull();
  });

  it('a named login', () => {
    expect(resolveLoginAccount(claude, { account: 'work' })).toEqual({ id: 'work', kind: 'login' });
  });

  it('pasted kinds need a named account and a supporting agent', () => {
    expect(resolveLoginAccount(claude, { account: 'ci', setupToken: true })).toEqual({
      id: 'ci',
      kind: 'setup-token',
    });
    expect(() => resolveLoginAccount(claude, { apiKey: true })).toThrow(
      /needs a name.*credentials add claude\/<name> --api-key/,
    );
    expect(() => resolveLoginAccount(codex, { account: 'ci', setupToken: true })).toThrow(
      /setup-token/,
    );
    expect(() =>
      resolveLoginAccount(claude, { account: 'x', apiKey: true, setupToken: true }),
    ).toThrow(/choose one/);
  });

  it('refuses a bad id and an agent with no accounts', () => {
    expect(() => resolveLoginAccount(claude, { account: 'Work' })).toThrow(/lowercase/);
    expect(() => resolveLoginAccount({ id: 'pi' } as AgentSyncSpec, { account: 'work' })).toThrow(
      /does not support named accounts/,
    );
  });
});

describe('pastedSecretProblem', () => {
  it('accepts a token and refuses empty, spaced or short input', () => {
    expect(pastedSecretProblem('sk-ant-usr-' + 'x'.repeat(20))).toBeNull();
    expect(pastedSecretProblem('')).toMatch(/empty/);
    expect(pastedSecretProblem('two words here and more')).toMatch(/whitespace/);
    expect(pastedSecretProblem('short')).toMatch(/too short/);
  });
});

describe("the default login read off the agent's own file", () => {
  const withTool = (d: string): AgentSyncSpec[] =>
    specsFor(d).map((s) =>
      s.id === 'claude'
        ? ({
            ...s,
            staticPaths: [{ hostHomeRel: ['.claude'], boxDir: '/home/vscode/.claude' }],
          } as AgentSyncSpec)
        : s,
    );

  it('lists the backup first, then the tool path', () => {
    const [claude] = withTool(dir);
    expect(defaultLoginPaths(claude!, '/h')).toEqual([
      claudeBackup,
      '/h/.claude/.credentials.json',
    ]);
    expect(defaultLoginPaths({ id: 'x' } as AgentSyncSpec, '/h')).toEqual([]);
  });

  it('a host signed in but never backed up still lists default', async () => {
    const home = join(dir, 'home');
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(join(home, '.claude', '.credentials.json'), REAL_CLAUDE);
    const prev = process.env.HOME;
    process.env.HOME = home;
    try {
      const file = await readAccounts({ ...opts, specs: withTool(dir) });
      expect(file.accounts).toEqual([
        expect.objectContaining({ agent: 'claude', id: 'default', kind: 'login' }),
      ]);
    } finally {
      process.env.HOME = prev;
    }
  });
});

describe('accountsFileProblem', () => {
  it('names the file and suggests moving it aside; null when fine or absent', async () => {
    expect(await accountsFileProblem(opts)).toBeNull();
    writeFileSync(opts.path!, JSON.stringify({ version: 1, accounts: [] }));
    expect(await accountsFileProblem(opts)).toBeNull();
    writeFileSync(opts.path!, '{nope');
    const msg = await accountsFileProblem(opts);
    expect(msg).toContain(opts.path!);
    expect(msg).toContain('not valid JSON');
    expect(msg).toContain(`mv ${opts.path!} ${opts.path!}.bak`);
  });
});

describe('purgeAgentAccounts', () => {
  it("drops an unregistered agent's rows and secrets, keeping everything else", async () => {
    await upsertAccount(acct(), opts);
    // A plugin agent's row, written while it was registered.
    const raw = JSON.parse(readFileSync(opts.path!, 'utf8')) as { accounts: unknown[] };
    raw.accounts.push({ agent: 'myagent', id: 'w', kind: 'api-key', createdAt: 'x' });
    writeFileSync(opts.path!, JSON.stringify(raw));
    mkdirSync(join(dir, 'credentials', 'myagent'), { recursive: true });
    writeFileSync(join(dir, 'credentials', 'myagent', 'w.json'), 'secret');

    expect(await storedAccountIds(['myagent'], opts)).toEqual([{ agent: 'myagent', id: 'w' }]);
    expect(await purgeAgentAccounts(['myagent'], opts)).toEqual([{ agent: 'myagent', id: 'w' }]);
    expect(existsSync(join(dir, 'credentials', 'myagent'))).toBe(false);
    const after = JSON.parse(readFileSync(opts.path!, 'utf8')) as { accounts: LlmAccount[] };
    expect(after.accounts.map((a) => `${a.agent}/${a.id}`)).toEqual(['claude/work']);
    expect(await storedAccountIds(['myagent'], opts)).toEqual([]);
  });

  it('refuses an agent id that is not path-safe', async () => {
    await expect(purgeAgentAccounts(['../x'], opts)).rejects.toThrow(/agent id/);
  });
});
