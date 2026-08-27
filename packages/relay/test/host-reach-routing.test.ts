import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { startRelayServer, type RelayServerHandle } from '../src/server.js';

/**
 * The control box's side of the host-reach channel, end to end over HTTP:
 * a cloud box's `cp` must PARK for the user's machine rather than run here.
 *
 * This is the regression that matters most. Running it here is what produced
 * `spawn /usr/local/bin/node ENOENT` on a live control box — the CLI spawned
 * with its cwd set to the create job's temp clone, which the worker had already
 * deleted — after the gate had cheerfully auto-approved the copy as "contained"
 * against that same phantom directory.
 */

const ADMIN = 'admin-token';

async function req(
  handle: RelayServerHandle,
  method: string,
  path: string,
  init: { token?: string; body?: unknown } = {},
): Promise<{ status: number; body: any }> {
  const port = (handle.server.address() as AddressInfo).port;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (init.token) headers.Authorization = `Bearer ${init.token}`;
  const res = await fetch(`http://127.0.0.1:${String(port)}${path}`, {
    method,
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text.length > 0 ? JSON.parse(text) : null };
}

describe('control box host-reach routing', () => {
  let handle: RelayServerHandle;

  beforeEach(async () => {
    handle = await startRelayServer({
      port: 0,
      host: '127.0.0.1',
      controlPlane: true,
      adminToken: ADMIN,
      // Short, so the "nobody is there" case doesn't hold the suite open.
      hostReachTimeoutMs: 300,
    });
    await req(handle, 'POST', '/admin/register-box', {
      body: { boxId: 'b1', token: 't1', name: 'cpbox', kind: 'cloud', backend: 'e2b' },
    });
  });

  afterEach(async () => {
    await handle.close();
  });

  it('parks a cloud box cp for the user machine and returns its result', async () => {
    const rpc = req(handle, 'POST', '/rpc', {
      token: 't1',
      body: { method: 'cp.fromHost', params: { sources: ['./data.csv'], dest: '/workspace/' } },
    });

    const polled = await req(handle, 'GET', '/admin/hostreach/poll?wait=2000', { token: ADMIN });
    expect(polled.status).toBe(200);
    expect(polled.body.actions).toHaveLength(1);
    const action = polled.body.actions[0];
    expect(action.method).toBe('cp.fromHost');
    expect(action.boxId).toBe('b1');
    // The params reach the machine untouched — it, not the broker, resolves them.
    expect(action.params).toEqual({ sources: ['./data.csv'], dest: '/workspace/' });

    const posted = await req(handle, 'POST', '/admin/hostreach/result', {
      token: ADMIN,
      body: { id: action.id, exitCode: 0, stdout: 'copied to cpbox:/workspace/data.csv', stderr: '' },
    });
    expect(posted.status).toBe(204);

    const answer = await rpc;
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ exitCode: 0, stdout: 'copied to cpbox:/workspace/data.csv' });
  });

  it('tells the box how to fix it when no machine is connected', async () => {
    const answer = await req(handle, 'POST', '/rpc', {
      token: 't1',
      body: { method: 'cp.toHost', params: { sources: ['/workspace/out.txt'], dest: './' } },
    });
    expect(answer.status).toBe(500);
    expect(answer.body.exitCode).toBe(69);
    // Actionable, and honest about what this hub is: a broker, not the files.
    expect(answer.body.stderr).toMatch(/not connected to this hub/);
    expect(answer.body.stderr).toMatch(/agentbox relay start/);
    expect(answer.body.stderr).toMatch(/agentbox cp cpbox:/);
  });

  it('does not park a docker box cp — that relay has the files itself', async () => {
    // Without this the local path opens a confirm nobody answers and the test
    // hangs — which is the correct production behavior, so bypass rather than
    // change it.
    const prev = process.env.AGENTBOX_PROMPT;
    process.env.AGENTBOX_PROMPT = 'off';
    try {
      await req(handle, 'POST', '/admin/register-box', {
        body: { boxId: 'b2', token: 't2', name: 'dockerbox' },
      });
      const rpc = req(handle, 'POST', '/rpc', {
        token: 't2',
        body: { method: 'cp.toHost', params: { sources: ['/workspace/x'], dest: './' } },
      });
      const polled = await req(handle, 'GET', '/admin/hostreach/poll?wait=200', { token: ADMIN });
      expect(polled.body.actions).toHaveLength(0);
      // It took the local path instead (which fails here for lack of a CLI
      // entry, not for lack of a machine) — the point is only that it never parked.
      const answer = await rpc;
      expect(answer.body.stderr ?? '').not.toMatch(/not connected to this hub/);
    } finally {
      if (prev === undefined) delete process.env.AGENTBOX_PROMPT;
      else process.env.AGENTBOX_PROMPT = prev;
    }
  });

  it('refuses the host-reach surface without the admin bearer', async () => {
    const port = (handle.server.address() as AddressInfo).port;
    // A box token is not an admin token, and being on loopback proves nothing on
    // a control box, where every request arrives through its own reverse proxy.
    // Without this the surface would let one box read another's parked actions
    // and forge their results.
    const withBoxToken = await fetch(
      `http://127.0.0.1:${String(port)}/admin/hostreach/poll?wait=0`,
      { headers: { Authorization: 'Bearer t1' } },
    );
    expect(withBoxToken.status).toBe(401);
    const bare = await fetch(`http://127.0.0.1:${String(port)}/admin/hostreach/poll?wait=0`);
    expect(bare.status).toBe(401);
  });
});

describe('a plain relay (no control box)', () => {
  it('does not serve the host-reach surface at all', async () => {
    const handle = await startRelayServer({ port: 0, host: '127.0.0.1' });
    try {
      const r = await req(handle, 'GET', '/admin/hostreach/poll?wait=0');
      expect(r.status).toBe(404);
    } finally {
      await handle.close();
    }
  });
});
