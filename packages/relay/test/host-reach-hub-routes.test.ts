import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { startRelayServer, type RelayServerHandle } from '../src/server.js';
import { applyCheckoutReport } from '../src/checkouts/store.js';

/**
 * Multi-PC Phase 4 over HTTP on the control box: a routed `cp` goes to the
 * box's origin PC, then to another PC with the repo; a PC cannot use another
 * PC's poller id; and the serving PC's confirm shows in the hub's approvals.
 */

const ADMIN = 'admin-token';
const KEY = 'github.com/acme/app';
const PC_A = '0b9d6c3e-5f0a-4c1e-9d2b-7a8e6f4c3b21';
const PC_B = '1c8e7d4f-6a1b-4d2f-8e3c-9b0f7a5d4c32';

interface Reply {
  actions?: { id: string; route?: { folder?: string; repoKey?: string } }[];
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  id?: string;
  status?: string;
  answer?: string;
}

async function req(
  handle: RelayServerHandle,
  method: string,
  path: string,
  init: { token?: string; device?: string; body?: unknown } = {},
): Promise<{ status: number; body: Reply }> {
  const port = (handle.server.address() as AddressInfo).port;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (init.token) headers.Authorization = `Bearer ${init.token}`;
  if (init.device) headers['X-Agentbox-Device'] = init.device;
  const res = await fetch(`http://127.0.0.1:${String(port)}${path}`, {
    method,
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text.length > 0 ? (JSON.parse(text) as Reply) : {} };
}

const poll = (h: RelayServerHandle, poller: string, device: string, wait = 1500) =>
  req(h, 'GET', `/admin/hostreach/poll?wait=${String(wait)}&poller=${poller}`, {
    token: ADMIN,
    device,
  });

describe('host-reach routing on the control box', () => {
  let handle: RelayServerHandle;

  beforeEach(async () => {
    handle = await startRelayServer({
      port: 0,
      host: '127.0.0.1',
      controlPlane: true,
      adminToken: ADMIN,
      hostReachTimeoutMs: 400,
    });
    await req(handle, 'POST', '/admin/register-box', {
      body: {
        boxId: 'b1',
        token: 't1',
        name: 'cpbox',
        kind: 'cloud',
        backend: 'hetzner',
        originUrl: 'git@github.com:acme/app.git',
        repoKey: KEY,
        originMachineId: PC_A,
        originMachineLabel: 'laptop',
      },
    });
    await applyCheckoutReport({
      machineId: PC_A,
      label: 'laptop',
      entries: [{ repoKey: KEY, folder: '/Users/a/app' }],
    });
    await applyCheckoutReport({
      machineId: PC_B,
      label: 'desk',
      entries: [{ repoKey: KEY, folder: '/home/b/app' }],
    });
  });

  afterEach(async () => {
    await handle.close();
  });

  it('serves from the other PC with the repo when the origin declines, with its own folder', async () => {
    // Both PCs present before the box asks.
    const warmA = poll(handle, 'pa', PC_A, 50);
    const warmB = poll(handle, 'pb', PC_B, 50);
    await Promise.all([warmA, warmB]);
    const rpc = req(handle, 'POST', '/rpc', {
      token: 't1',
      body: { method: 'cp.fromHost', params: { sources: ['data.csv'], dest: '/workspace' } },
    });
    const a = await poll(handle, 'pa', PC_A);
    expect(a.body.actions?.[0]?.route).toEqual({
      repoKey: KEY,
      folder: '/Users/a/app',
      role: 'origin',
      box: { name: 'cpbox', backend: 'hetzner', originMachineId: PC_A },
    });
    const id = a.body.actions![0]!.id;
    // PC B cannot settle (or decline) PC A's copy by quoting PC A's poller id.
    const forged = await req(handle, 'POST', '/admin/hostreach/result', {
      token: ADMIN,
      device: PC_B,
      body: { id, poller: 'pa', exitCode: 0, stdout: 'forged', stderr: '' },
    });
    expect(forged.status).toBe(403);
    await req(handle, 'POST', '/admin/hostreach/decline', {
      token: ADMIN,
      device: PC_A,
      body: { id, poller: 'pa', reason: 'checkout is mid-rebase' },
    });
    const b = await poll(handle, 'pb', PC_B);
    expect(b.body.actions?.[0]?.route?.folder).toBe('/home/b/app');
    await req(handle, 'POST', '/admin/hostreach/result', {
      token: ADMIN,
      device: PC_B,
      body: { id, poller: 'pb', exitCode: 0, stdout: 'from desk', stderr: '' },
    });
    expect((await rpc).body).toMatchObject({ exitCode: 0, stdout: 'from desk' });
  });

  it('checks the id in the query before the body, and fails an oversize result instead of dropping it', async () => {
    await poll(handle, 'pa', PC_A, 50);
    const rpc = req(handle, 'POST', '/rpc', {
      token: 't1',
      body: { method: 'cp.fromHost', params: { sources: ['data.csv'], dest: '/workspace' } },
    });
    const a = await poll(handle, 'pa', PC_A);
    const id = a.body.actions![0]!.id;
    const unknown = await req(handle, 'POST', '/admin/hostreach/result?id=nope&poller=pa', {
      token: ADMIN,
      device: PC_A,
      body: { id: 'nope', poller: 'pa', exitCode: 0, stdout: '', stderr: '' },
    });
    expect(unknown.status).toBe(404);
    // A `cp` result keeps the default cap: 2 MiB is refused, and the box hears
    // that it failed rather than waiting on an answer that was sent.
    await req(handle, 'POST', `/admin/hostreach/result?id=${id}&poller=pa`, {
      token: ADMIN,
      device: PC_A,
      body: { id, poller: 'pa', exitCode: 0, stdout: 'x'.repeat(2 * 1024 * 1024), stderr: '' },
    }).catch(() => undefined);
    expect((await rpc).body).toMatchObject({
      exitCode: 1,
      stderr: expect.stringMatching(/larger than this hub accepts/) as unknown,
    });
  });

  it('tells the box which machines it tried and why', async () => {
    await poll(handle, 'pa', PC_A, 50);
    const rpc = req(handle, 'POST', '/rpc', {
      token: 't1',
      body: { method: 'cp.fromHost', params: { sources: ['data.csv'], dest: '/workspace' } },
    });
    const a = await poll(handle, 'pa', PC_A);
    await req(handle, 'POST', '/admin/hostreach/decline', {
      token: ADMIN,
      device: PC_A,
      body: {
        id: a.body.actions![0]!.id,
        poller: 'pa',
        reason: 'its checkout /Users/a/app is gone',
      },
    });
    const answer = await rpc;
    expect(answer.status).toBe(500);
    // One machine declined, the other was offline: the lead says a machine
    // declined, and does not send the user to start AgentBox.
    expect((answer.body.stderr ?? '').split('\n')[0]).toMatch(/at least one declined/);
    expect(answer.body.stderr).not.toMatch(/agentbox relay start/);
    expect(answer.body.stderr).toMatch(/Machines tried, in order:/);
    // fromHost copies host -> box: the hint says so (it used to be reversed).
    expect(answer.body.stderr).toContain('agentbox cp <src> cpbox:<dst>');
    expect(answer.body.stderr).toMatch(
      /laptop \(0b9d6c3e\): declined: its checkout \/Users\/a\/app is gone/,
    );
    expect(answer.body.stderr).toMatch(/desk \(1c8e7d4f\): not connected/);
  });

  it('never offers a routed copy to a PC without the repo', async () => {
    const other = '2d9f8e5a-7b2c-4e3a-9f4d-0c1a8b6e5d43';
    await poll(handle, 'pz', other, 50);
    const rpc = req(handle, 'POST', '/rpc', {
      token: 't1',
      body: { method: 'cp.fromHost', params: { sources: ['data.csv'], dest: '/workspace' } },
    });
    expect((await poll(handle, 'pz', other, 300)).body.actions).toEqual([]);
    expect((await rpc).status).toBe(500);
  });

  it('refuses a poller id another machine already uses', async () => {
    await poll(handle, 'shared', PC_A, 50);
    const stolen = await poll(handle, 'shared', PC_B, 50);
    expect(stolen.status).toBe(403);
  });

  it("shows the serving PC's confirm in the hub approvals and returns the answer", async () => {
    await poll(handle, 'pa', PC_A, 50);
    const rpc = req(handle, 'POST', '/rpc', {
      token: 't1',
      body: { method: 'cp.fromHost', params: { sources: ['data.csv'], dest: '/workspace' } },
    });
    const a = await poll(handle, 'pa', PC_A);
    const id = a.body.actions![0]!.id;
    const raised = await req(handle, 'POST', '/admin/hostreach/prompt', {
      token: ADMIN,
      device: PC_A,
      body: {
        id,
        poller: 'pa',
        prompt: { message: 'Allow cp (host -> box) on cpbox?', detail: 'data.csv' },
      },
    });
    expect(raised.status).toBe(200);
    const promptId = raised.body.id!;
    // It is a pending approval on the HUB now, answerable by any client.
    expect(handle.prompts.all().map((p) => p.ev.message)).toEqual([
      'Allow cp (host -> box) on cpbox?',
    ]);
    expect(handle.prompts.boxFor(promptId)).toBe('b1');
    // PC B cannot read or cancel PC A's prompt.
    const peek = await req(handle, 'GET', `/admin/hostreach/prompt/${promptId}?wait=10`, {
      token: ADMIN,
      device: PC_B,
    });
    expect(peek.status).toBe(404);
    const waiting = req(handle, 'GET', `/admin/hostreach/prompt/${promptId}?wait=2000`, {
      token: ADMIN,
      device: PC_A,
    });
    handle.prompts.resolve(promptId, 'y');
    expect((await waiting).body).toEqual({ status: 'answered', answer: 'y' });
    await req(handle, 'POST', '/admin/hostreach/result', {
      token: ADMIN,
      device: PC_A,
      body: { id, poller: 'pa', exitCode: 0, stdout: 'ok', stderr: '' },
    });
    expect((await rpc).body.exitCode).toBe(0);
  });

  it('withdraws a mirrored confirm when its action ends', async () => {
    await poll(handle, 'pa', PC_A, 50);
    const rpc = req(handle, 'POST', '/rpc', {
      token: 't1',
      body: { method: 'cp.fromHost', params: { sources: ['data.csv'], dest: '/workspace' } },
    });
    const a = await poll(handle, 'pa', PC_A);
    const id = a.body.actions![0]!.id;
    await req(handle, 'POST', '/admin/hostreach/prompt', {
      token: ADMIN,
      device: PC_A,
      body: { id, poller: 'pa', prompt: { message: 'Allow?', defaultAnswer: 'y' } },
    });
    expect(handle.prompts.size()).toBe(1);
    // Whatever the PC sent, Enter never approves a copy on the hub (review 426 item 8).
    expect(handle.prompts.all()[0]!.ev.defaultAnswer).toBe('n');
    await req(handle, 'POST', '/admin/hostreach/result', {
      token: ADMIN,
      device: PC_A,
      body: { id, poller: 'pa', exitCode: 10, stdout: '', stderr: 'denied by user\n' },
    });
    await rpc;
    expect(handle.prompts.size()).toBe(0);
  });

  it('parks a download for the ORIGIN only, and says so when it is offline', async () => {
    // PC B has the repo and is online; the origin (PC A) is not.
    await poll(handle, 'pb', PC_B, 50);
    const rpc = req(handle, 'POST', '/rpc', {
      token: 't1',
      body: { method: 'download.workspace', params: { kind: 'workspace' } },
    });
    expect((await poll(handle, 'pb', PC_B, 600)).body.actions).toEqual([]);
    const answer = await rpc;
    expect(answer.status).toBe(500);
    expect(answer.body.stderr).toMatch(
      /download could not run: the computer it was created from \(laptop\)/,
    );
    expect(answer.body.stderr).toMatch(/working\ntree overwritten|working tree overwritten/);
  });

  it('hands a download to the origin with its own folder', async () => {
    await poll(handle, 'pa', PC_A, 50);
    const rpc = req(handle, 'POST', '/rpc', {
      token: 't1',
      body: { method: 'download.workspace', params: { kind: 'workspace' } },
    });
    const a = await poll(handle, 'pa', PC_A);
    // Routed to the origin (this registration names no origin folder, so the
    // origin PC serves from its own record of the box).
    expect(a.body.actions?.[0]?.route).toMatchObject({ role: 'origin' });
    await req(handle, 'POST', '/admin/hostreach/result', {
      token: ADMIN,
      device: PC_A,
      body: {
        id: a.body.actions![0]!.id,
        poller: 'pa',
        exitCode: 0,
        stdout: '/Users/a/app\n',
        stderr: '',
      },
    });
    expect((await rpc).body.exitCode).toBe(0);
  });

  it('does not broker the download kinds a cloud box cannot do (they fail at once, as before)', async () => {
    await poll(handle, 'pa', PC_A, 50);
    const rpc = req(handle, 'POST', '/rpc', {
      token: 't1',
      body: { method: 'download.env', params: { kind: 'env' } },
    });
    expect((await poll(handle, 'pa', PC_A, 300)).body.actions).toEqual([]);
    // Handled on the hub as before (it asks there); deny it so the call ends.
    for (let i = 0; i < 50 && handle.prompts.size() === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    for (const p of handle.prompts.all()) handle.prompts.resolve(p.id, 'n');
    await rpc;
  });
});
