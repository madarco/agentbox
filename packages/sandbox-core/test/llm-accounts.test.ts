import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentSyncSpec, LlmAccount } from '@agentbox/core';
import {
  accountProblem,
  decodePastedSecret,
  encodePastedSecret,
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
    await upsertAccount(acct({ id: 'default', kind: 'login', label: 'Personal' }), opts);
    rmSync(claudeBackup);
    expect((await readAccounts(opts)).accounts).toEqual([]);
    writeFileSync(claudeBackup, REAL_CLAUDE);
    expect((await readAccounts(opts)).accounts).toEqual([
      expect.objectContaining({ id: 'default', label: 'Personal' }),
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
    await upsertAccount(acct({ label: 'Work' }), opts);
    const file = await readAccounts(opts);
    expect(file.accounts).toHaveLength(2);
    expect(file.accounts.find((a) => a.agent === 'claude')?.label).toBe('Work');
  });

  it('named secrets live under credentials/<agent>/<id>.json at 0600', async () => {
    const secret = encodePastedSecret({ kind: 'setup-token', token: 'tok' });
    const path = await writeAccountSecret('claude', 'work', secret, opts);
    expect(path).toBe(join(dir, 'credentials', 'claude', 'work.json'));
    expect(statSync(path).mode & 0o777).toBe(0o600);
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
    const path = await writeAccountSecret('claude', 'work', 'x', opts);
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
