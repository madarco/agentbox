import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentSyncSpec } from '@agentbox/core';
import { readAccounts, upsertAccount, type AccountStoreOptions } from '@agentbox/sandbox-core';
import { captureVolumeLogin, type VolumeFileReader } from '../src/sync/account-login.js';

let dir: string;
let store: AccountStoreOptions;
let spec: AgentSyncSpec;

const login = (expiresAt: number): string =>
  JSON.stringify({ claudeAiOauth: { accessToken: 'a', refreshToken: 'r', expiresAt } });

const reader =
  (files: Record<string, string>): VolumeFileReader =>
  (rel) =>
    Promise.resolve(files[rel] ?? null);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agentbox-acct-login-'));
  spec = {
    id: 'claude',
    aliases: [],
    credential: {
      boxRelPath: '.credentials.json',
      boxAbsPath: '/home/vscode/.claude/.credentials.json',
      hostBackup: join(dir, 'claude-credentials.json'),
      cloudMountPath: '/home/vscode/.agentbox-creds/claude',
      cloudSubpath: 'claude/',
      realShape: 'claude-oauth',
      freshness: { jsonPath: ['claudeAiOauth', 'expiresAt'] },
    },
    accountKinds: ['login', 'setup-token', 'api-key'],
  } as unknown as AgentSyncSpec;
  store = { path: join(dir, 'accounts.json'), stateDir: dir, specs: [spec] };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('captureVolumeLogin', () => {
  it("stores the volume's login as the named account, never the legacy backup", async () => {
    const legacy = join(dir, 'claude-credentials.json');
    writeFileSync(legacy, login(999));
    const res = await captureVolumeLogin({
      spec,
      account: { id: 'work', label: 'Work' },
      read: reader({ '.credentials.json': login(100), '_claude.json': '{}' }),
      identity: { files: ['.credentials.json', '_claude.json'], parse: () => ({ email: 'b@x' }) },
      store,
    });
    expect(res).toMatchObject({ written: true, identity: { email: 'b@x' } });
    expect(readFileSync(join(dir, 'credentials', 'claude', 'work.json'), 'utf8')).toBe(login(100));
    expect(readFileSync(legacy, 'utf8')).toBe(login(999));
    const acct = (await readAccounts(store)).accounts.find((a) => a.id === 'work');
    expect(acct).toMatchObject({ kind: 'login', label: 'Work', identity: { email: 'b@x' } });
  });

  it('a re-login keeps the row and refuses an older blob', async () => {
    await captureVolumeLogin({
      spec,
      account: { id: 'work', label: 'Work' },
      read: reader({ '.credentials.json': login(200) }),
      store,
    });
    const older = await captureVolumeLogin({
      spec,
      account: { id: 'work' },
      read: reader({ '.credentials.json': login(100) }),
      store,
    });
    expect(older).toMatchObject({ written: false, reason: 'not newer than backup' });
    expect((await readAccounts(store)).accounts[0]).toMatchObject({ label: 'Work' });
  });

  it('a brand-new account whose login is unusable leaves nothing behind', async () => {
    const placeholder = JSON.stringify({ claudeAiOauth: { accessToken: 'a' } });
    await expect(
      captureVolumeLogin({
        spec,
        account: { id: 'work' },
        read: reader({ '.credentials.json': placeholder }),
        store,
      }),
    ).rejects.toThrow(/not a usable/);
    expect((await readAccounts(store)).accounts).toEqual([]);
    expect(existsSync(join(dir, 'credentials', 'claude', 'work.json'))).toBe(false);
  });

  it('an empty volume is an error, not an account', async () => {
    await expect(
      captureVolumeLogin({ spec, account: { id: 'work' }, read: reader({}), store }),
    ).rejects.toThrow(/did not leave a credential/);
    expect((await readAccounts(store)).accounts).toEqual([]);
  });

  it('a refused re-login keeps the stored identity (review)', async () => {
    await captureVolumeLogin({
      spec,
      account: { id: 'work' },
      read: reader({ '.credentials.json': login(200) }),
      identity: { files: [], parse: () => ({ email: 'alice@x' }) },
      store,
    });
    const res = await captureVolumeLogin({
      spec,
      account: { id: 'work' },
      read: reader({ '.credentials.json': login(100) }),
      identity: { files: [], parse: () => ({ email: 'bob@x' }) },
      store,
    });
    expect(res).toMatchObject({ written: false, identity: { email: 'alice@x' } });
    expect((await readAccounts(store)).accounts[0]!.identity).toEqual({ email: 'alice@x' });
    // An accepted re-login moves the identity.
    await captureVolumeLogin({
      spec,
      account: { id: 'work' },
      read: reader({ '.credentials.json': login(300) }),
      identity: { files: [], parse: () => ({ email: 'bob@x' }) },
      store,
    });
    expect((await readAccounts(store)).accounts[0]!.identity).toEqual({ email: 'bob@x' });
  });

  it('never turns a pasted-kind account into a login (review)', async () => {
    await upsertAccount({ agent: 'claude', id: 'ci', kind: 'setup-token', createdAt: 't' }, store);
    await expect(
      captureVolumeLogin({
        spec,
        account: { id: 'ci' },
        read: reader({ '.credentials.json': login(1) }),
        store,
      }),
    ).rejects.toThrow(/setup-token account/);
    expect((await readAccounts(store)).accounts[0]!.kind).toBe('setup-token');
  });
});
