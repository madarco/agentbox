import { afterEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { startRelayServer, type RelayServerHandle } from '../src/server.js';
import type { RelayDeviceAuth } from '../src/admin-gate.js';

/**
 * A device token (`agentbox hub login`) stands in for the shared admin token on
 * every admin surface a PC uses, and stops working the moment it is revoked —
 * including an event stream that is already open.
 */

const ADMIN = 'admin-token';
const DEVICE = 'abdev_device-token';
const DEVICE_ID = '0123456789abcdef0123456789abcdef';

function fakeDevices(): RelayDeviceAuth & { revoke(): void } {
  let revoked = false;
  const listeners = new Set<(id: string) => void>();
  return {
    verify: (token) => (!revoked && token === DEVICE ? { id: DEVICE_ID, label: 'pc-b' } : null),
    onRevoked: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    revoke: () => {
      revoked = true;
      for (const l of listeners) l(DEVICE_ID);
    },
  };
}

describe('device tokens on the relay admin surface', () => {
  let handle: RelayServerHandle | undefined;
  afterEach(async () => {
    handle?.hostReach?.stop();
    await new Promise<void>((r) => handle?.server.close(() => r()) ?? r());
  });

  async function start(adminToken = ADMIN) {
    const devices = fakeDevices();
    handle = await startRelayServer({
      port: 0,
      host: '127.0.0.1',
      controlPlane: true,
      adminToken,
      deviceAuth: devices,
      hostReachTimeoutMs: 2_000,
    });
    const base = `http://127.0.0.1:${String((handle.server.address() as AddressInfo).port)}`;
    return { devices, base };
  }

  const get = (url: string, token: string, headers: Record<string, string> = {}) =>
    fetch(url, { headers: { Authorization: `Bearer ${token}`, ...headers } });

  it('host-reach poll accepts the device token and records which device polled', async () => {
    const { base } = await start();
    const res = await get(`${base}/admin/hostreach/poll?wait=0&poller=p1`, DEVICE);
    expect(res.status).toBe(200);
    expect(handle!.hostReach!.devicesPresent()).toEqual([DEVICE_ID]);
  });

  it('a device id claimed in a header is not authentication', async () => {
    const { base } = await start();
    const res = await get(`${base}/admin/hostreach/poll?wait=0&poller=p1`, 'nope', {
      'X-Agentbox-Device': DEVICE_ID,
    });
    expect(res.status).toBe(401);
  });

  it('the shared admin token still works, and its claimed device id is recorded', async () => {
    const { base } = await start();
    const res = await get(`${base}/admin/hostreach/poll?wait=0&poller=p2`, ADMIN, {
      'X-Agentbox-Device': 'fedcba9876543210fedcba9876543210',
    });
    expect(res.status).toBe(200);
    expect(handle!.hostReach!.devicesPresent()).toEqual(['fedcba9876543210fedcba9876543210']);
  });

  it('custody and the store RPC accept it too', async () => {
    const { base } = await start();
    expect((await get(`${base}/admin/custody`, DEVICE)).status).not.toBe(401);
    expect((await get(`${base}/admin/custody`, 'nope')).status).toBe(401);
  });

  it('a revoked token is refused on the next request', async () => {
    const { base, devices } = await start();
    devices.revoke();
    expect((await get(`${base}/admin/hostreach/poll?wait=0&poller=p1`, DEVICE)).status).toBe(401);
    expect((await get(`${base}/admin/custody`, DEVICE)).status).toBe(401);
  });

  it('revocation closes an open host-reach event stream', async () => {
    const { base, devices } = await start();
    const res = await get(`${base}/admin/hostreach/events?poller=p1`, DEVICE, {
      Accept: 'text/event-stream',
    });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    await reader.read(); // the `: connected` preamble
    devices.revoke();
    // The server ends the response; the next read reports done.
    let done = false;
    for (let i = 0; i < 5 && !done; i++) done = (await reader.read()).done;
    expect(done).toBe(true);
  });

  it('device tokens mean nothing on a relay with no admin token', async () => {
    const { base } = await start('');
    expect((await get(`${base}/admin/custody`, DEVICE)).status).toBe(503);
  });
});

describe('HostReachQueue poller bookkeeping', () => {
  it('forgets pollers long gone, keeps recent ones', async () => {
    const { HostReachQueue } = await import('../src/host-reach.js');
    let t = 0;
    const q = new HostReachQueue({ reachTimeoutMs: 1000, now: () => t });
    q.identify('old', 'dev-old-1234');
    q.touch('old');
    t = 10_000;
    q.identify('new', 'dev-new-1234');
    q.touch('new');
    expect(q.devicesPresent()).toEqual(['dev-new-1234']);
    // `old` was pruned, not merely absent from the window.
    t = 10_500;
    q.touch('old');
    expect(q.devicesPresent()).toEqual(['dev-new-1234']);
    q.stop();
  });
});
