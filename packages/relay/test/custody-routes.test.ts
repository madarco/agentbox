import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { handleRelayRequest, type ControlPlaneDeps } from '../src/core/handler.js';
import { MemoryStore } from '../src/store/memory-store.js';
import { FsCustodyStore } from '../src/custody/fs-store.js';
import { startRelayServer, type RelayServerHandle } from '../src/server.js';

const ADMIN = 'admin-secret';

function req(
  method: string,
  path: string,
  init: { bearer?: string; body?: unknown; query?: string } = {},
) {
  return {
    method,
    path,
    query: new URLSearchParams(init.query ?? ''),
    bearer: init.bearer ?? '',
    bodyText: init.body !== undefined ? JSON.stringify(init.body) : '',
  };
}

describe('custody via the hosted-plane handler', () => {
  let root: string;
  let deps: ControlPlaneDeps;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'custody-h-'));
    deps = { store: new MemoryStore(), leaser: null, adminToken: ADMIN, custody: new FsCustodyStore({ root }) };
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('401s without the admin bearer', async () => {
    const r = await handleRelayRequest(req('GET', '/admin/custody'), deps);
    expect(r.status).toBe(401);
  });

  it('503s when no custody store is wired', async () => {
    const r = await handleRelayRequest(req('GET', '/admin/custody', { bearer: ADMIN }), {
      ...deps,
      custody: null,
    });
    expect(r.status).toBe(503);
  });

  it('put/get/list/delete round-trips base64', async () => {
    const value = Buffer.from('{"claudeAiOauth":{"refreshToken":"r"}}');
    const put = await handleRelayRequest(
      req('PUT', '/admin/custody/agents/claude/.credentials.json', {
        bearer: ADMIN,
        body: { data: value.toString('base64') },
      }),
      deps,
    );
    expect(put.status).toBe(200);
    expect(put.body).toMatchObject({ changed: true });

    const get = await handleRelayRequest(
      req('GET', '/admin/custody/agents/claude/.credentials.json', { bearer: ADMIN }),
      deps,
    );
    expect(get.status).toBe(200);
    const body = get.body as { data: string };
    expect(Buffer.from(body.data, 'base64').equals(value)).toBe(true);

    const list = await handleRelayRequest(
      req('GET', '/admin/custody', { bearer: ADMIN, query: 'prefix=agents' }),
      deps,
    );
    expect((list.body as { entries: unknown[] }).entries).toHaveLength(1);

    const del = await handleRelayRequest(
      req('DELETE', '/admin/custody/agents/claude/.credentials.json', { bearer: ADMIN }),
      deps,
    );
    expect(del.status).toBe(204);
  });

  it('re-put of identical bytes reports changed:false', async () => {
    const b = Buffer.from('same').toString('base64');
    const path = '/admin/custody/projects/p/.env';
    await handleRelayRequest(req('PUT', path, { bearer: ADMIN, body: { data: b } }), deps);
    const second = await handleRelayRequest(req('PUT', path, { bearer: ADMIN, body: { data: b } }), deps);
    expect(second.body).toMatchObject({ changed: false });
  });

  it('400s a bad path or non-base64 body', async () => {
    const bad = await handleRelayRequest(
      req('PUT', '/admin/custody/secrets/x', { bearer: ADMIN, body: { data: 'AA==' } }),
      deps,
    );
    expect(bad.status).toBe(400);
    const notB64 = await handleRelayRequest(
      req('PUT', '/admin/custody/projects/p/.env', { bearer: ADMIN, body: { data: '!!!not base64!!!' } }),
      deps,
    );
    expect(notB64.status).toBe(400);
  });
});

describe('custody over in-process HTTP (server.ts, non-loopback gate)', () => {
  let root: string;
  let handle: RelayServerHandle;
  let base: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'custody-s-'));
    handle = await startRelayServer({
      port: 0,
      host: '127.0.0.1',
      custody: new FsCustodyStore({ root }),
      adminToken: ADMIN,
      githubApp: null,
    });
    const { port } = handle.server.address() as AddressInfo;
    base = `http://127.0.0.1:${String(port)}`;
  });
  afterEach(async () => {
    await handle.close();
    await rm(root, { recursive: true, force: true });
  });

  async function call(method: string, path: string, init: { bearer?: string; body?: unknown } = {}) {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (init.bearer) headers.Authorization = `Bearer ${init.bearer}`;
    const res = await fetch(`${base}${path}`, {
      method,
      headers,
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, body: text.length ? JSON.parse(text) : null };
  }

  it('401s loopback requests without the admin bearer (loopback is NOT proof for custody)', async () => {
    const r = await call('GET', '/admin/custody');
    expect(r.status).toBe(401);
  });

  it('round-trips a value with the admin bearer', async () => {
    const value = Buffer.from('KEYMATERIAL');
    const put = await call('PUT', '/admin/custody/boxes/box-1/ssh/id_ed25519', {
      bearer: ADMIN,
      body: { data: value.toString('base64') },
    });
    expect(put.status).toBe(200);
    const get = await call('GET', '/admin/custody/boxes/box-1/ssh/id_ed25519', { bearer: ADMIN });
    expect(Buffer.from((get.body as { data: string }).data, 'base64').equals(value)).toBe(true);
  });

  it('503s when no admin token is configured', async () => {
    const bare = await startRelayServer({ port: 0, host: '127.0.0.1', custody: new FsCustodyStore({ root }), githubApp: null });
    try {
      const { port } = bare.server.address() as AddressInfo;
      const res = await fetch(`http://127.0.0.1:${String(port)}/admin/custody`, {
        headers: { Authorization: 'Bearer anything' },
      });
      expect(res.status).toBe(503);
    } finally {
      await bare.close();
    }
  });
});
