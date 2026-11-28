import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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
  isAccountLoginCancelled,
  isAccountLoginWorker,
  loginWorkerAlive,
  readAccountLoginRequest,
  writeAccountLoginRequest,
  removeAccountLoginSession,
  sameLoginIdentity,
  writeAccountLoginCode,
  readAccountLoginState,
  takeAccountLoginCode,
  upsertAccount,
  writeAccountLoginState,
} from '@agentbox/sandbox-core';
import {
  accountLoginView,
  createAccountLoginBackend,
  signinScratchSession,
} from '../lib/backend/account-login';

let dir: string;
let renews: string[];
let stops: Array<() => void>;
/** Unit tests never reach docker. */
const NO_DOCKER = { list: () => Promise.resolve([] as string[]), remove: () => Promise.resolve() };
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
    scratchVolumes: NO_DOCKER,
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
    // The fakes run in this process: any live pid is "the worker".
    isWorker: (pid) => loginWorkerAlive(pid),
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

  it('cancel stops the worker (identified by its command line)', async () => {
    let child: ReturnType<typeof spawn> | undefined;
    const b = createAccountLoginBackend({
      scratchVolumes: NO_DOCKER,
      renew: () => Promise.resolve({ ok: true, value: { pushed: 0, failed: 0, output: [] } }),
      spawnWorker: (s) => {
        child = spawn(
          process.execPath,
          ['-e', 'setInterval(() => {}, 1000)', '_account-login-worker', s],
          { stdio: 'ignore' },
        );
        stops.push(() => child!.kill('SIGKILL'));
        writeAccountLoginState(
          s,
          { phase: 'awaiting-code', url: 'https://x', pid: child.pid! },
          dir,
        );
        return child.pid;
      },
      store: { path: join(dir, 'accounts.json'), stateDir: dir, specs: AGENT_SYNC_SPECS },
      stateDir: dir,
      startWaitMs: 2_000,
      pollMs: 10,
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

describe('hub-driven sign-in: lookups, boot and cancel', () => {
  it('get/code/cancel find the session by the typed name, as start stored it', async () => {
    const b = backend();
    const start = await b.startAccountLogin('claude', 'Work Max', {});
    expect(start.ok && start.value.account).toBe('work_max');
    const g = await b.getAccountLogin('claude', 'Work Max');
    expect(g.ok && g.value.account).toBe('work_max');
    const sent = await b.submitAccountLoginCode('claude', 'Work Max', { code: 'bad' });
    expect(sent.ok && sent.value.lastError).toBeTruthy();
  });

  it('a worker that never writes its state reads starting, then an error', async () => {
    let clock = Date.parse('2026-11-28T10:00:00Z');
    const b = createAccountLoginBackend({
      scratchVolumes: NO_DOCKER,
      renew: () => Promise.resolve({ ok: true, value: { pushed: 0, failed: 0, output: [] } }),
      spawnWorker: () => undefined,
      store: { path: join(dir, 'accounts.json'), stateDir: dir, specs: AGENT_SYNC_SPECS },
      stateDir: dir,
      startWaitMs: 0,
      pollMs: 5,
      now: () => clock,
    });
    const r = await b.startAccountLogin('claude', 'work', {});
    expect(r.ok && r.value.state).toBe('starting');
    // Live while booting: a second start joins it.
    const again = await b.startAccountLogin('claude', 'work', {});
    expect(again.ok && again.ok && r.ok && again.value.session).toBe(r.ok ? r.value.session : '');
    clock += 61_000;
    const g = await b.getAccountLogin('claude', 'work');
    expect(g.ok && g.value).toMatchObject({
      state: 'error',
      error: expect.stringMatching(/never started/),
    });
  });

  it('cancel before the worker has a pid leaves a marker it reads', async () => {
    const b = backend(() => undefined);
    const r = await b.startAccountLogin('claude', 'work', {});
    expect(r.ok && r.value.state).toBe('starting');
    await b.cancelAccountLogin('claude', 'work');
    expect(isAccountLoginCancelled(r.ok ? r.value.session : '', dir)).toBe(true);
  }, 15_000);
});

describe('review #529', () => {
  it('fans out after a code submit even when the worker wrote its state late and nobody polls', async () => {
    const b = backend((s) => {
      // The first state lands after start() has returned and the watcher began.
      setTimeout(() => fakeWorker(s), 150);
      return process.pid;
    });
    // The watcher starts at spawn, while the session has no state yet.
    const r = await b.startAccountLogin('claude', 'work', {});
    // No GET from here on: only the code submit.
    await waitUntil(async () => {
      const st = readAccountLoginState(r.ok ? r.value.session : '', dir);
      return st?.phase === 'awaiting-code';
    });
    await b.submitAccountLoginCode('claude', 'work', { code: CODE });
    await waitUntil(() => Promise.resolve(renews.length > 0));
    expect(renews).toEqual(['claude/work']);
  });

  it("a pid that is not this session's worker is never signalled, and reads as stopped", async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
    });
    stops.push(() => child.kill('SIGKILL'));
    const b = createAccountLoginBackend({
      scratchVolumes: NO_DOCKER,
      renew: () => Promise.resolve({ ok: true, value: { pushed: 0, failed: 0, output: [] } }),
      spawnWorker: (s) => {
        // A stale state whose pid now belongs to an unrelated process.
        writeAccountLoginState(
          s,
          { phase: 'awaiting-code', url: 'https://x', pid: child.pid! },
          dir,
        );
        return child.pid;
      },
      store: { path: join(dir, 'accounts.json'), stateDir: dir, specs: AGENT_SYNC_SPECS },
      stateDir: dir,
      startWaitMs: 200,
      pollMs: 10,
    });
    const r = await b.startAccountLogin('claude', 'work', {});
    expect(r.ok && r.value.state).toBe('error');
    await new Promise((res) => setTimeout(res, 100));
    expect(child.exitCode).toBeNull();
    expect(child.signalCode).toBeNull();
  });

  it('isAccountLoginWorker matches only a worker for that session', () => {
    const child = spawn(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)', '_account-login-worker', 'abcdef0123456789'],
      { stdio: 'ignore' },
    );
    stops.push(() => child.kill('SIGKILL'));
    expect(isAccountLoginWorker(child.pid!, 'abcdef0123456789')).toBe(true);
    expect(isAccountLoginWorker(child.pid!, 'ffffffffffffffff')).toBe(false);
    expect(isAccountLoginWorker(process.pid, 'abcdef0123456789')).toBe(false);
  });

  it('cancel with a session leaves another session of the account alone', async () => {
    const b = backend();
    const r = await b.startAccountLogin('claude', 'work', {});
    const other = await b.cancelAccountLogin('claude', 'work', 'ffffffffffffffff');
    expect(other).toMatchObject({ ok: false, code: 'not_found' });
    expect(isAccountLoginCancelled(r.ok ? r.value.session : '', dir)).toBe(false);
    expect(await b.cancelAccountLogin('claude', 'work', 'NOT-AN-ID')).toMatchObject({
      ok: false,
      code: 'invalid_request',
    });
  });

  it('start takes replace (a boolean) into the request; a mismatch is shown on error', async () => {
    const b = backend();
    expect(await b.startAccountLogin('claude', 'work', { replace: 'yes' })).toMatchObject({
      ok: false,
      code: 'invalid_request',
    });
    const r = await b.startAccountLogin('claude', 'work', { replace: true });
    expect(readAccountLoginRequest(r.ok ? r.value.session : '', dir)?.replace).toBe(true);
    const v = accountLoginView(
      's',
      { agent: 'claude', account: 'work', mode: 'renew', createdAt: 't0' },
      {
        phase: 'error',
        error: 'this signed in b@x, but claude/work is a@x',
        mismatch: { stored: { email: 'a@x' }, signedIn: { email: 'b@x' } },
        pid: 1,
        updatedAt: 't1',
      },
      null,
    );
    expect(v.mismatch).toEqual({ stored: { email: 'a@x' }, signedIn: { email: 'b@x' } });
  });

  it('a replace start does not silently join a sign-in in flight without replace', async () => {
    const b = backend();
    const plain = await b.startAccountLogin('claude', 'work', {});
    expect(plain.ok).toBe(true);
    expect(await b.startAccountLogin('claude', 'work', { replace: true })).toMatchObject({
      ok: false,
      code: 'conflict',
      error: expect.stringMatching(/cancel it first/),
    });
  });

  it('a restarted hub resumes the fan-out of a sign-in it was not watching', async () => {
    const session = 'abcdef0123456789';
    writeAccountLoginRequest(
      session,
      { agent: 'claude', account: 'work', mode: 'renew', createdAt: new Date().toISOString() },
      dir,
    );
    writeAccountLoginState(session, { phase: 'signed-in', pid: process.pid }, dir);
    backend(); // a fresh hub process: no start, no read
    await waitUntil(() => Promise.resolve(renews.length > 0));
    expect(renews).toEqual(['claude/work']);
  });

  it("sweeps the scratch volumes of sign-ins that are over, never a live one's", async () => {
    const removed: string[] = [];
    let liveSession = '';
    const b = createAccountLoginBackend({
      renew: () => Promise.resolve({ ok: true, value: { pushed: 0, failed: 0, output: [] } }),
      spawnWorker: (s) => {
        liveSession = s;
        return fakeWorker(s);
      },
      store: { path: join(dir, 'accounts.json'), stateDir: dir, specs: AGENT_SYNC_SPECS },
      stateDir: dir,
      startWaitMs: 2_000,
      pollMs: 10,
      isWorker: (pid) => loginWorkerAlive(pid),
      scratchVolumes: {
        list: () =>
          Promise.resolve([
            'agentbox-claude-config-acct-work-signin-0123456789abcdef',
            `agentbox-claude-config-acct-work-signin-${liveSession}`,
            'unrelated-volume',
            'app-signin-postgresdata',
          ]),
        remove: (name) => {
          removed.push(name);
          return Promise.resolve();
        },
      },
    });
    await b.startAccountLogin('claude', 'work', {});
    // A second start (joining) reaps again, with the live session's volume listed.
    await b.startAccountLogin('claude', 'work', {});
    await waitUntil(() => Promise.resolve(removed.length > 0));
    expect(removed).toContain('agentbox-claude-config-acct-work-signin-0123456789abcdef');
    expect(removed).not.toContain(`agentbox-claude-config-acct-work-signin-${liveSession}`);
    expect(removed).not.toContain('unrelated-volume');
    expect(removed).not.toContain('app-signin-postgresdata');
  });

  it('the sweep only matches the scratch volumes the worker mints', () => {
    expect(signinScratchSession('agentbox-claude-config-acct-work-signin-0123456789abcdef')).toBe(
      '0123456789abcdef',
    );
    expect(signinScratchSession('agentbox-codex-config-signin-0123456789abcdef')).toBe(
      '0123456789abcdef',
    );
    // A user's own volumes that merely contain `-signin-`.
    expect(signinScratchSession('app-signin-postgresdata')).toBeNull();
    expect(signinScratchSession('myapp-signin-0123456789abcdef')).toBeNull();
    expect(signinScratchSession('agentbox-x-signin-postgresdata')).toBeNull();
    expect(signinScratchSession('agentbox-x-signin-0123456789ABCDEF')).toBeNull();
  });

  it('sameLoginIdentity: email first, then org; unknown is not a mismatch', () => {
    expect(sameLoginIdentity({ email: 'A@x.com' }, { email: 'a@x.com' })).toBe(true);
    expect(sameLoginIdentity({ email: 'a@x.com' }, { email: 'b@x.com' })).toBe(false);
    expect(sameLoginIdentity({ org: 'o1' }, { org: 'o2' })).toBe(false);
    expect(sameLoginIdentity(undefined, { email: 'b@x.com' })).toBe(true);
    expect(sameLoginIdentity({ email: 'a@x.com' }, { org: 'o1' })).toBe(true);
  });

  it('removing a session removes its worker log too', () => {
    const logs = join(dir, 'logs');
    mkdirSync(logs, { recursive: true });
    writeFileSync(join(logs, 'account-login-abcdef0123456789.log'), 'x');
    writeAccountLoginCode('abcdef0123456789', 'c', dir);
    removeAccountLoginSession('abcdef0123456789', dir);
    expect(existsSync(join(logs, 'account-login-abcdef0123456789.log'))).toBe(false);
    expect(existsSync(join(accountLoginRootDir(dir), 'abcdef0123456789'))).toBe(false);
  });
});

describe('takeAccountLoginCode', () => {
  it('consumes the code once', () => {
    writeAccountLoginCode('abcdef0123456789', 'c1', dir);
    expect(takeAccountLoginCode('abcdef0123456789', dir)).toBe('c1');
    expect(takeAccountLoginCode('abcdef0123456789', dir)).toBeNull();
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
