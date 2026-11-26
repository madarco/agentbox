// The default account per agent (credentials-tui Phase 1): `GET/PUT
// /api/v1/accounts/default` and the `default`/`defaults` marks on the list.
// Config paths are fixed from $HOME at import, so HOME is moved first.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const HOME = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync: mk } = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir: td } = require('node:os') as typeof import('node:os');
  const home = mk(`${td()}/agentbox-acct-defaults-`);
  process.env.HOME = home;
  return home;
});

import { AGENT_SYNC_SPECS, upsertAccount } from '@agentbox/sandbox-core';
import { createAccountBackend } from '../lib/backend/accounts';

let dir: string;
let project: string;

function backend() {
  return createAccountBackend({
    store: { path: join(dir, 'accounts.json'), stateDir: dir, specs: AGENT_SYNC_SPECS },
    boxes: () => Promise.resolve([]),
    configHome: HOME,
    machineId: () => 'm-test',
    removeVolume: () => Promise.resolve({ removed: false }),
  });
}

beforeEach(async () => {
  rmSync(join(HOME, '.agentbox'), { recursive: true, force: true });
  dir = mkdtempSync(join(tmpdir(), 'agentbox-acct-store-'));
  project = mkdtempSync(join(tmpdir(), 'agentbox-acct-project-'));
  mkdirSync(join(project, '.git'));
  const store = { path: join(dir, 'accounts.json'), stateDir: dir, specs: AGENT_SYNC_SPECS };
  await upsertAccount({ agent: 'claude', id: 'work', kind: 'login', createdAt: 't' }, store);
  await upsertAccount({ agent: 'claude', id: 'home', kind: 'login', createdAt: 't' }, store);
});
afterAll(() => rmSync(HOME, { recursive: true, force: true }));

describe('account defaults', () => {
  it('is the default login with nothing set; no named account is marked', async () => {
    const r = await backend().listAccounts();
    expect(r.defaults?.claude).toEqual({ account: 'default', source: 'default' });
    expect(r.accounts.filter((a) => a.default)).toEqual([]);
  });

  it('sets the global default, then a project one over it, and clears each', async () => {
    const b = backend();
    const g = await b.setAccountDefault({ agent: 'claude', account: 'home', scope: 'global' });
    expect(g.ok && g.value.claude).toEqual({ account: 'home', source: 'global', global: 'home' });

    const p = await b.setAccountDefault({
      agent: 'claude',
      account: 'work',
      scope: 'project',
      project,
    });
    expect(p.ok && p.value.claude).toMatchObject({ account: 'work', source: 'project' });

    const listed = await b.listAccounts({ project });
    const mark = (id: string) => listed.accounts.find((a) => a.id === id)?.default;
    expect(mark('work')).toEqual({ project: true });
    expect(mark('home')).toEqual({ global: true });
    expect(mark('default')).toBeUndefined();
    // Without the project, only the global setting counts.
    expect((await b.listAccounts()).defaults?.claude?.account).toBe('home');

    const cleared = await b.setAccountDefault({
      agent: 'claude',
      account: null,
      scope: 'project',
      project,
    });
    expect(cleared.ok && cleared.value.claude).toMatchObject({ account: 'home', source: 'global' });
    await b.setAccountDefault({ agent: 'claude', account: null, scope: 'global' });
    expect((await b.listAccounts()).defaults?.claude?.source).toBe('default');
  });

  it('drops the settings that name an account when it is removed', async () => {
    const b = backend();
    await b.setAccountDefault({ agent: 'claude', account: 'work', scope: 'global' });
    await b.setAccountDefault({ agent: 'claude', account: 'work', scope: 'project', project });
    const r = await b.removeAccount('claude', 'work');
    expect(r.ok && r.value.defaultsCleared).toHaveLength(2);
    const d = await b.getAccountDefaults({ project });
    expect(d.ok && d.value.claude).toEqual({ account: 'default', source: 'default' });
  });

  it('an unreadable config is an error, never every agent on `default`', async () => {
    const b = backend();
    await b.setAccountDefault({ agent: 'claude', account: 'work', scope: 'global' });
    writeFileSync(join(HOME, '.agentbox', 'config.yaml'), 'claude: [unclosed\n');
    const list = await b.listAccounts();
    expect(list.defaults).toBeUndefined();
    expect(list.defaultsError).toMatch(/cannot read the config/);
    expect(list.accounts.filter((a) => a.default)).toEqual([]);
    const d = await b.getAccountDefaults();
    expect(d.ok).toBe(false);
    // Removing still removes, and the settings it could not check are a warning.
    const r = await b.removeAccount('claude', 'work');
    expect(r.ok && r.value.defaultsError).toMatch(/could not check/);
  });

  it('refuses an unknown account, agent, scope or project', async () => {
    const b = backend();
    const code = async (input: unknown) => {
      const r = await b.setAccountDefault(input);
      return r.ok ? 'ok' : r.code;
    };
    expect(await code({ agent: 'claude', account: 'nope', scope: 'global' })).toBe('not_found');
    expect(await code({ agent: 'nope', account: 'work' })).toBe('invalid_request');
    expect(await code({ agent: 'claude', account: 'work', scope: 'team' })).toBe('invalid_request');
    expect(await code({ agent: 'claude', account: 'work', scope: 'project', project: 'rel' })).toBe(
      'invalid_request',
    );
    expect(await code({ agent: 'claude', account: 'Bad Id', scope: 'global' })).toBe(
      'invalid_request',
    );
    expect(await code({ agent: 'claude', account: 'default', scope: 'global' })).toBe('ok');
    // A folder that is no project of the user's.
    const bare = mkdtempSync(join(tmpdir(), 'agentbox-acct-bare-'));
    expect(await code({ agent: 'claude', account: 'work', scope: 'project', project: bare })).toBe(
      'invalid_request',
    );
  });
});
