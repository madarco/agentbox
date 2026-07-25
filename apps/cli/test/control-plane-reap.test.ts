import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoxRecord } from '@agentbox/core';

// `apps/cli` has no vitest setup file, so nothing isolates $HOME for us — and
// reap.ts reads the layered config + ~/.agentbox/control-plane/control-plane.env.
// Redirect HOME per test or this reads (and trusts) the real one.

/** A control box that records reaps and answers a fixed registry. */
function fakeControlBox(opts: {
  reap?: (boxId: string) => { removed: boolean; custodyRemoved: number } | null;
  registrations?: Array<{ boxId: string; sandboxId?: string }>;
  token?: string;
}): Promise<{ url: string; close: () => Promise<void>; reaped: string[]; unauthorized: number }> {
  const reaped: string[] = [];
  const state = { unauthorized: 0 };
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const bearer = (req.headers.authorization ?? '').replace(/^Bearer /, '');
    if (opts.token !== undefined && bearer !== opts.token) {
      state.unauthorized += 1;
      res.writeHead(401).end();
      return;
    }
    if (url.pathname === '/admin/store') {
      let body = '';
      req.on('data', (c) => (body += String(c)));
      req.on('end', () => {
        const parsed = JSON.parse(body || '{}') as { method?: string };
        const result =
          parsed.method === 'listBoxes'
            ? (opts.registrations ?? []).map((r) => ({ name: r.boxId, registeredAt: '', ...r }))
            : null;
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ result }));
      });
      return;
    }
    if (url.pathname.startsWith('/remote/boxes/') && req.method === 'DELETE') {
      const boxId = decodeURIComponent(url.pathname.slice('/remote/boxes/'.length));
      const r = opts.reap?.(boxId);
      if (!r) {
        res.writeHead(404).end();
        return;
      }
      reaped.push(boxId);
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ boxId, ...r }));
      return;
    }
    res.writeHead(404).end();
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${String(port)}`,
        reaped,
        get unauthorized() {
          return state.unauthorized;
        },
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

const cloudBox = (id: string, controlPlaneUrl?: string): BoxRecord =>
  ({
    id,
    name: id,
    provider: 'e2b',
    container: `cloud:sbx_${id}`,
    image: 'tmpl',
    workspacePath: '/workspace',
    relayToken: 't',
    createdAt: '2026-07-20T00:00:00.000Z',
    cloud: { backend: 'e2b', sandboxId: `sbx_${id}`, controlPlaneUrl },
  }) as unknown as BoxRecord;

describe('reapOnControlBox', () => {
  let home: string;
  const originalHome = process.env['HOME'];
  const originalToken = process.env['AGENTBOX_RELAY_ADMIN_TOKEN'];

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'agentbox-reap-test-'));
    process.env['HOME'] = home;
    delete process.env['AGENTBOX_RELAY_ADMIN_TOKEN'];
    vi.resetModules();
  });

  afterEach(async () => {
    process.env['HOME'] = originalHome;
    if (originalToken === undefined) delete process.env['AGENTBOX_RELAY_ADMIN_TOKEN'];
    else process.env['AGENTBOX_RELAY_ADMIN_TOKEN'] = originalToken;
    await rm(home, { recursive: true, force: true });
  });

  it('skips a docker box — it never registers on a control box', async () => {
    process.env['AGENTBOX_RELAY_ADMIN_TOKEN'] = 'tok';
    const { reapOnControlBox } = await import('../src/control-plane/reap.js');
    const docker = { ...cloudBox('d1'), provider: 'docker', cloud: undefined } as BoxRecord;
    expect(await reapOnControlBox(docker)).toBe('skipped');
  });

  it('skips when no control box is configured and the record names none', async () => {
    process.env['AGENTBOX_RELAY_ADMIN_TOKEN'] = 'tok';
    const { reapOnControlBox } = await import('../src/control-plane/reap.js');
    expect(await reapOnControlBox(cloudBox('c1'))).toBe('skipped');
  });

  it('reaps against the plane named on the box record', async () => {
    const box = await fakeControlBox({
      token: 'tok',
      reap: (id) => (id === 'c2' ? { removed: true, custodyRemoved: 2 } : null),
    });
    process.env['AGENTBOX_RELAY_ADMIN_TOKEN'] = 'tok';
    const { reapOnControlBox } = await import('../src/control-plane/reap.js');

    expect(await reapOnControlBox(cloudBox('c2', box.url))).toBe('reaped');
    expect(box.reaped).toEqual(['c2']);
    await box.close();
  });

  it('reports absent when the control box has nothing under that id', async () => {
    const box = await fakeControlBox({ token: 'tok', reap: () => null });
    process.env['AGENTBOX_RELAY_ADMIN_TOKEN'] = 'tok';
    const { reapOnControlBox } = await import('../src/control-plane/reap.js');

    expect(await reapOnControlBox(cloudBox('ghost', box.url))).toBe('absent');
    await box.close();
  });

  it('reports unreachable — never throws — when the control box is down', async () => {
    const box = await fakeControlBox({ token: 'tok', reap: () => null });
    const url = box.url;
    await box.close(); // nothing is listening on that port now
    process.env['AGENTBOX_RELAY_ADMIN_TOKEN'] = 'tok';
    const { reapOnControlBox } = await import('../src/control-plane/reap.js');

    expect(await reapOnControlBox(cloudBox('c3', url))).toBe('unreachable');
  });

  it('reports unreachable, not absent, when we have a plane but no token', async () => {
    const box = await fakeControlBox({ reap: () => ({ removed: true, custodyRemoved: 0 }) });
    const { reapOnControlBox } = await import('../src/control-plane/reap.js');

    expect(await reapOnControlBox(cloudBox('c4', box.url))).toBe('unreachable');
    expect(box.reaped).toEqual([]);
    await box.close();
  });
});
