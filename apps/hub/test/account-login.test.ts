import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The store and the session dirs resolve from $HOME at import: move it first.
const HOME = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync: mk } = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir: td } = require('node:os') as typeof import('node:os');
  const home = mk(`${td()}/agentbox-acct-login-`);
  process.env.HOME = home;
  return home;
});
afterAll(() => rmSync(HOME, { recursive: true, force: true }));

import {
  AGENT_SYNC_SPECS,
  accountLoginRootDir,
  readAccountLoginState,
  takeAccountLoginCode,
  upsertAccount,
  writeAccountLoginState,
} from '@agentbox/sandbox-core';
import { accountLoginView, createAccountLoginBackend } from '../lib/backend/account-login';

let dir: string;
let renews: string[];
let stops: Array<() => void>;
const CODE = 'secret-code-123#abc';

/**
 * A fake worker in this process: publishes a URL, then takes the code — `bad`
 * is refused, anything else signs in.
 */
function fakeWorker(session: string): number {
  const pid = process.pid;
  writeAccountLoginState(session, { phase: 'starting', pid }, dir);
  setTimeout(() => {
    writeAccountLoginState(
      session,
      { phase: 'awaiting-code', url: 'https://claude.example/oauth', input: { kind: 'code' }, pid },
      dir,
    );
  }, 20);
  const t = setInterval(() => {
    const st = readAccountLoginState(session, dir);
    if (st?.phase !== 'awaiting-code') return;
    const code = takeAccountLoginCode(session, dir);
    if (!code) return;
    if (code === 'bad') {
      writeAccountLoginState(
        session,
        { ...st, phase: 'awaiting-code', lastError: 'the code was not accepted', pid },
        dir,
      );
    } else {
      writeAccountLoginState(
        session,
        { phase: 'signed-in', identity: { email: 'w@example.com' }, pid },
        dir,
      );
    }
  }, 10);
  stops.push(() => clearInterval(t));
  return pid;
}

function backend(spawnWorker: (s: string) => number | undefined = fakeWorker) {
  return createAccountLoginBackend({
    renew: (agent, id) => {
      renews.push(`${agent}/${id}`);
      return Promise.resolve({ ok: true, value: { pushed: 2, failed: 0, output: [] } });
    },
    spawnWorker,
    store: { path: join(dir, 'accounts.json'), stateDir: dir, specs: AGENT_SYNC_SPECS },
    stateDir: dir,
    startWaitMs: 2_000,
    codeWaitMs: 2_000,
    pollMs: 10,
  });
}

const waitUntil = async (fn: () => Promise<boolean>, ms = 2_000): Promise<void> => {
  const end = Date.now() + ms;
  while (!(await fn())) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
};

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agentbox-acct-login-'));
  renews = [];
  stops = [];
  const store = { path: join(dir, 'accounts.json'), stateDir: dir, specs: AGENT_SYNC_SPECS };
  await upsertAccount({ agent: 'claude', id: 'work', kind: 'login', createdAt: 't' }, store);
  await upsertAccount({ agent: 'claude', id: 'ci', kind: 'setup-token', createdAt: 't' }, store);
});
afterEach(() => {
  for (const s of stops) s();
  rmSync(dir, { recursive: true, force: true });
});

describe('hub-driven sign-in (POST/GET …/login, …/login/code)', () => {
  it('adds a new account: normalized name, URL, code, then the fan-out', async () => {
    const b = backend();
    const start = await b.startAccountLogin('claude', 'Work Max', {});
    expect(start.ok).toBe(true);
    if (!start.ok) return;
    expect(start.value).toMatchObject({
      agent: 'claude',
      account: 'work_max',
      mode: 'add',
      state: 'awaiting-code',
      url: 'https://claude.example/oauth',
      input: { kind: 'code' },
    });

    const refused = await b.submitAccountLoginCode('claude', 'work_max', { code: 'bad' });
    expect(refused.ok && refused.value).toMatchObject({
      state: 'awaiting-code',
      lastError: 'the code was not accepted',
    });

    const sent = await b.submitAccountLoginCode('claude', 'work_max', { code: CODE });
    expect(sent.ok).toBe(true);
    await waitUntil(async () => {
      const g = await b.getAccountLogin('claude', 'work_max');
      return g.ok && g.value.state === 'done';
    });
    const done = await b.getAccountLogin('claude', 'work_max');
    expect(done.ok && done.value).toMatchObject({
      state: 'done',
      identity: { email: 'w@example.com' },
      renew: { pushed: 2, failed: 0 },
    });
    expect(renews).toEqual(['claude/work_max']);
    // The code never comes back, and never stays on disk.
    expect(JSON.stringify([start, refused, sent, done])).not.toContain(CODE);
    const session = start.value.session;
    expect(readdirSync(join(accountLoginRootDir(dir), session))).not.toContain('code');
    for (const f of readdirSync(join(accountLoginRootDir(dir), session))) {
      expect(readFileSync(join(accountLoginRootDir(dir), session, f), 'utf8')).not.toContain(CODE);
    }
  });

  it('renews an existing login; a second start joins the sign-in in flight', async () => {
    let spawned = 0;
    const b = backend((s) => {
      spawned++;
      return fakeWorker(s);
    });
    const one = await b.startAccountLogin('claude', 'work', {});
    const two = await b.startAccountLogin('claude', 'work', {});
    expect(one.ok && one.value.mode).toBe('renew');
    expect(one.ok && two.ok && two.value.session).toBe(one.ok ? one.value.session : '');
    expect(spawned).toBe(1);
  });

  it('refuses a pasted kind, an unknown agent, and a mode that does not match', async () => {
    const b = backend();
    expect(await b.startAccountLogin('claude', 'ci', {})).toMatchObject({
      ok: false,
      code: 'invalid_request',
    });
    expect(await b.startAccountLogin('nope', 'x', {})).toMatchObject({
      ok: false,
      code: 'not_found',
    });
    expect(await b.startAccountLogin('claude', 'work', { mode: 'add' })).toMatchObject({
      ok: false,
      code: 'conflict',
    });
    expect(await b.startAccountLogin('claude', 'fresh', { mode: 'renew' })).toMatchObject({
      ok: false,
      code: 'not_found',
    });
    expect(await b.startAccountLogin('claude', 'bad name!', {})).toMatchObject({
      ok: false,
      code: 'invalid_request',
    });
  });

  it('a code is refused while nothing waits for one, and must be one line', async () => {
    const b = backend();
    expect(await b.submitAccountLoginCode('claude', 'work', { code: 'x' })).toMatchObject({
      ok: false,
      code: 'not_found',
    });
    await b.startAccountLogin('claude', 'work', {});
    expect(await b.submitAccountLoginCode('claude', 'work', { code: 'a\nb' })).toMatchObject({
      ok: false,
      code: 'invalid_request',
    });
    expect(await b.submitAccountLoginCode('claude', 'work', {})).toMatchObject({
      ok: false,
      code: 'invalid_request',
    });
  });

  it('a worker that died mid-flow reads as an error', async () => {
    const b = backend((s) => {
      writeAccountLoginState(
        s,
        { phase: 'awaiting-code', url: 'https://x', pid: 2 ** 22 + 7 },
        dir,
      );
      return 2 ** 22 + 7;
    });
    const r = await b.startAccountLogin('claude', 'work', {});
    expect(r.ok && r.value).toMatchObject({ state: 'error' });
    expect(renews).toEqual([]);
  });

  it('cancel stops the worker', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
    });
    stops.push(() => child.kill('SIGKILL'));
    const b = backend((s) => {
      writeAccountLoginState(s, { phase: 'awaiting-code', url: 'https://x', pid: child.pid! }, dir);
      return child.pid;
    });
    await b.startAccountLogin('claude', 'work', {});
    const r = await b.cancelAccountLogin('claude', 'work');
    expect(r.ok && r.value.state).toBe('error');
  });

  it('a hub that could not start the worker answers why and keeps no session', async () => {
    const b = backend(() => {
      throw new Error('hub is missing AGENTBOX_CLI_ENTRY; cannot start a sign-in');
    });
    expect(await b.startAccountLogin('claude', 'work', {})).toMatchObject({
      ok: false,
      code: 'conflict',
      error: expect.stringMatching(/AGENTBOX_CLI_ENTRY/),
    });
    expect(await b.getAccountLogin('claude', 'work')).toMatchObject({ ok: false });
  });
});

describe('accountLoginView', () => {
  const req = { agent: 'codex', account: 'default', mode: 'renew' as const, createdAt: 't0' };
  it('signed-in without the fan-out reads pushing; with it, done', () => {
    const st = { phase: 'signed-in' as const, pid: 1, updatedAt: 't1' };
    expect(accountLoginView('s', req, st, null).state).toBe('pushing');
    expect(
      accountLoginView('s', req, st, { pushed: 1, failed: 0, output: [], at: 't2' }).state,
    ).toBe('done');
  });
  it('carries the device code for an approval-only flow', () => {
    const v = accountLoginView(
      's',
      req,
      {
        phase: 'awaiting-approval',
        url: 'https://auth.openai.com/device',
        userCode: 'ABCD-1234',
        pid: 1,
        updatedAt: 't1',
      },
      null,
    );
    expect(v).toMatchObject({ state: 'awaiting-approval', userCode: 'ABCD-1234' });
    expect(v.input).toBeUndefined();
  });
});
