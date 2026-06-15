import { afterEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { startRelayServer, type RelayServerHandle } from '../src/server.js';

// Control-box mode swaps the loopback source check on /admin and /remote for a
// bearer match against the admin token. These tests bind 127.0.0.1, so every
// request is loopback — which is precisely the point: in control-box mode
// loopback is NOT trusted (the provider HTTPS proxy can present as loopback),
// so a valid bearer must still be required.
const ADMIN_TOKEN = 'admin-secret-token-1234567890';

describe('control-box admin auth', () => {
  let handle: RelayServerHandle | undefined;

  afterEach(async () => {
    await handle?.close();
    handle = undefined;
  });

  async function start(opts: { controlBox?: boolean; adminToken?: string }): Promise<void> {
    handle = await startRelayServer({ port: 0, host: '127.0.0.1', ...opts });
  }

  function req(path: string, token?: string): Promise<Response> {
    const port = (handle!.server.address() as AddressInfo).port;
    const headers: Record<string, string> = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    return fetch(`http://127.0.0.1:${String(port)}${path}`, { headers });
  }

  it('refuses to boot in control-box mode without an admin token (fail closed)', async () => {
    await expect(
      startRelayServer({ port: 0, host: '127.0.0.1', controlBox: true }),
    ).rejects.toThrow(/adminToken/);
    await expect(
      startRelayServer({ port: 0, host: '127.0.0.1', controlBox: true, adminToken: '' }),
    ).rejects.toThrow(/adminToken/);
  });

  it('rejects /admin from loopback without a valid bearer', async () => {
    await start({ controlBox: true, adminToken: ADMIN_TOKEN });
    expect((await req('/admin/registry')).status).toBe(401);
    expect((await req('/admin/registry', 'wrong-token')).status).toBe(401);
    // A token of the right length but wrong value must still fail.
    expect((await req('/admin/registry', 'x'.repeat(ADMIN_TOKEN.length))).status).toBe(401);
  });

  it('accepts /admin with the correct bearer', async () => {
    await start({ controlBox: true, adminToken: ADMIN_TOKEN });
    const res = await req('/admin/registry', ADMIN_TOKEN);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ boxes: [] });
  });

  it('gates /remote behind the admin bearer in control-box mode', async () => {
    await start({ controlBox: true, adminToken: ADMIN_TOKEN });
    // No /remote route exists yet, but the guard runs first: no token => 401
    // (proving /remote is treated as protected), valid token => 404 (auth
    // passed, route simply not found).
    expect((await req('/remote/queue/enqueue')).status).toBe(401);
    expect((await req('/remote/queue/enqueue', ADMIN_TOKEN)).status).toBe(404);
  });

  it('keeps the laptop relay loopback-gated and hides /remote when not a control box', async () => {
    await start({});
    // Loopback admin still works with no token (unchanged behavior).
    expect((await req('/admin/registry')).status).toBe(200);
    // /remote is a control-box-only surface: 404 off the control box.
    expect((await req('/remote/queue/enqueue')).status).toBe(404);
  });
});
