import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

// apps/cli tests share the real ~/.agentbox: point HOME away before any module
// resolves a default path from it. Every call below also passes its own paths.
const home = await vi.hoisted(async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentbox-enroll-op-'));
  process.env.HOME = dir;
  return dir;
});

import { readDeviceCredential, writeDeviceCredential } from '@agentbox/sandbox-core';
import {
  decideOperatorEnrollment,
  enrollOperatorDevice,
} from '../src/control-plane/enroll-operator.js';
import {
  ownerCredentialsFor,
  readOwnerCredentials,
} from '../src/control-plane/owner-credentials.js';

const URL = 'https://hub.example.test';
const OWNER = { apiKey: 'api-key-1', adminToken: 'admin-token-1' };
const ID = 'machine-0001';

describe('decideOperatorEnrollment', () => {
  const base = {
    controlBoxIsThisMachine: false,
    hasOwnerCredentials: true,
    listed: undefined,
    localTokenValid: false,
  };

  it('skips when the control box is this machine', () => {
    expect(decideOperatorEnrollment({ ...base, controlBoxIsThisMachine: true })).toEqual({
      action: 'skip',
      reason: 'this-machine',
    });
  });

  it('skips without the API key and admin token', () => {
    expect(decideOperatorEnrollment({ ...base, hasOwnerCredentials: false })).toEqual({
      action: 'skip',
      reason: 'no-owner-credentials',
    });
  });

  it('enrolls a machine the hub does not list', () => {
    expect(decideOperatorEnrollment(base)).toEqual({ action: 'enroll', rotate: false });
  });

  it('leaves an enrolled machine with a working token alone', () => {
    expect(
      decideOperatorEnrollment({
        ...base,
        listed: { id: ID, label: 'mac', revokedAt: null },
        localTokenValid: true,
      }),
    ).toEqual({ action: 'skip', reason: 'enrolled' });
  });

  it('never re-enrolls a revoked machine, even with a local token', () => {
    expect(
      decideOperatorEnrollment({
        ...base,
        listed: { id: ID, label: 'mac', revokedAt: '2026-11-01T00:00:00.000Z' },
        localTokenValid: true,
      }),
    ).toEqual({ action: 'revoked', label: 'mac' });
  });

  it('rotates when the hub lists the machine but the local token is gone', () => {
    expect(
      decideOperatorEnrollment({ ...base, listed: { id: ID, label: 'mac', revokedAt: null } }),
    ).toEqual({ action: 'enroll', rotate: true });
  });
});

describe('readOwnerCredentials', () => {
  const envFile = (body: string): string => {
    const p = join(mkdtempSync(join(tmpdir(), 'agentbox-owner-')), 'control-plane.env');
    writeFileSync(p, body);
    return p;
  };

  it('reads both keys from the file', () => {
    const p = envFile('AGENTBOX_HUB_API_KEY=k\nAGENTBOX_RELAY_ADMIN_TOKEN=t\n');
    expect(readOwnerCredentials({}, p)).toEqual({ apiKey: 'k', adminToken: 't' });
  });

  it('ignores a device token the env carries in place of the shared keys', () => {
    const p = envFile('AGENTBOX_HUB_API_KEY=k\nAGENTBOX_RELAY_ADMIN_TOKEN=t\n');
    const env = { AGENTBOX_HUB_API_KEY: 'abdev_x', AGENTBOX_RELAY_ADMIN_TOKEN: 'abdev_x' };
    expect(readOwnerCredentials(env, p)).toEqual({ apiKey: 'k', adminToken: 't' });
  });

  it('lets an exported pair win, but never mixes one exported key with the file', () => {
    const p = envFile('AGENTBOX_HUB_API_KEY=k\nAGENTBOX_RELAY_ADMIN_TOKEN=t\n');
    expect(
      readOwnerCredentials({ AGENTBOX_HUB_API_KEY: 'k2', AGENTBOX_RELAY_ADMIN_TOKEN: 't2' }, p),
    ).toEqual({ apiKey: 'k2', adminToken: 't2' });
    expect(readOwnerCredentials({ AGENTBOX_HUB_API_KEY: 'k2' }, p)).toEqual({
      apiKey: 'k',
      adminToken: 't',
    });
  });

  it('is null when either key is missing', () => {
    expect(readOwnerCredentials({}, envFile('AGENTBOX_HUB_API_KEY=k\n'))).toBeNull();
    expect(readOwnerCredentials({}, join(home, 'nope.env'))).toBeNull();
  });
});

describe('ownerCredentialsFor', () => {
  const dir = (): string => mkdtempSync(join(tmpdir(), 'agentbox-owner-for-'));
  const setup = (deployUrl: string | null) => {
    const d = dir();
    const envPath = join(d, 'control-plane.env');
    writeFileSync(envPath, 'AGENTBOX_HUB_API_KEY=k\nAGENTBOX_RELAY_ADMIN_TOKEN=t\n');
    const deployPath = join(d, 'deploy.json');
    if (deployUrl)
      writeFileSync(deployPath, JSON.stringify({ provider: 'hetzner', url: deployUrl }));
    return { env: {}, envPath, deployPath };
  };

  it('gives the keys to the hub the deploy record names', () => {
    expect(ownerCredentialsFor(`${URL}/`, { onThisMachine: false, ...setup(URL) })).toEqual({
      apiKey: 'k',
      adminToken: 't',
    });
  });

  it('never sends them to another hub', () => {
    expect(
      ownerCredentialsFor('https://other.example.test', { onThisMachine: false, ...setup(URL) }),
    ).toBeNull();
  });

  it('gives them to a hub on this machine, and to the configured hub with no record', () => {
    expect(
      ownerCredentialsFor('http://127.0.0.1:8787', { onThisMachine: true, ...setup(URL) }),
    ).not.toBeNull();
    expect(ownerCredentialsFor(URL, { onThisMachine: false, ...setup(null) })).not.toBeNull();
  });
});

/** A fake hub: the four device routes, with the owner gate the real one applies. */
function fakeHub(
  initial: { id: string; label: string; revokedAt: string | null }[] = [],
  opts: { deviceProbeStatus?: number; approveStatus?: number } = {},
) {
  const devices = new Map(initial.map((d) => [d.id, { ...d, token: '' }]));
  const pending = new Map<string, { deviceId: string; label: string; approved: boolean }>();
  const calls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input).slice(URL.length);
    const method = init?.method ?? 'GET';
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const bearer = (headers.authorization ?? '').replace(/^Bearer /, '');
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, string>) : {};
    calls.push(`${method} ${path}`);
    const json = (status: number, b: unknown): Response =>
      new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
    const byToken = [...devices.values()].find((d) => d.token && d.token === bearer);
    if (path === '/api/v1/devices' && method === 'GET') {
      if (bearer !== OWNER.apiKey && opts.deviceProbeStatus) {
        return json(opts.deviceProbeStatus, { error: { code: 'unavailable' } });
      }
      if (bearer !== OWNER.apiKey && !byToken)
        return json(401, { error: { code: 'unauthorized' } });
      return json(200, {
        devices: [...devices.values()].map((d) => ({
          id: d.id,
          label: d.label,
          revokedAt: d.revokedAt,
        })),
        current: byToken?.id ?? null,
      });
    }
    if (path === '/api/v1/devices/code') {
      const userCode = `CODE-${String(pending.size + 1)}`;
      pending.set(userCode, { deviceId: body.deviceId!, label: body.label!, approved: false });
      return json(201, { deviceCode: `dc-${userCode}`, userCode });
    }
    if (path === '/api/v1/devices/approve') {
      if (opts.approveStatus) return json(opts.approveStatus, { error: { code: 'internal' } });
      if (bearer !== OWNER.apiKey || headers['x-agentbox-admin-token'] !== OWNER.adminToken) {
        return json(403, { error: { code: 'forbidden' } });
      }
      const p = pending.get(body.userCode!);
      if (!p) return json(404, { error: { code: 'not_found' } });
      p.approved = true;
      return json(200, { device: { id: p.deviceId, label: p.label, revokedAt: null } });
    }
    if (path === '/api/v1/devices/deny') {
      if (bearer !== OWNER.apiKey || headers['x-agentbox-admin-token'] !== OWNER.adminToken) {
        return json(403, { error: { code: 'forbidden' } });
      }
      return json(pending.delete(body.userCode!) ? 200 : 404, {});
    }
    if (path === '/api/v1/devices/token') {
      const p = pending.get(body.deviceCode!.replace(/^dc-/, ''));
      if (!p?.approved) return json(400, { error: { code: 'authorization_pending' } });
      const token = `abdev_${p.deviceId}_${String(calls.length)}`;
      devices.set(p.deviceId, { id: p.deviceId, label: p.label, revokedAt: null, token });
      return json(200, { token, device: { id: p.deviceId, label: p.label, revokedAt: null } });
    }
    return json(404, {});
  }) as typeof fetch;
  return { fetchImpl, calls, devices, pending };
}

describe('enrollOperatorDevice', () => {
  const freshHome = (): string => mkdtempSync(join(tmpdir(), 'agentbox-enroll-home-'));
  const deps = (h: string, f: typeof fetch) => ({
    url: `${URL}/`,
    owner: OWNER,
    controlBoxIsThisMachine: false,
    fetch: f,
    home: h,
    deviceId: ID,
    label: 'operator-mac',
  });

  it('enrolls, approving with the API key and admin token, then a rerun changes nothing', async () => {
    const h = freshHome();
    const hub = fakeHub();
    const first = await enrollOperatorDevice(deps(h, hub.fetchImpl));
    expect(first.decision).toEqual({ action: 'enroll', rotate: false });
    const cred = readDeviceCredential(h);
    expect(cred?.hubUrl).toBe(URL);
    expect(cred?.deviceId).toBe(ID);
    expect(cred?.token).toMatch(/^abdev_/);

    hub.calls.length = 0;
    const second = await enrollOperatorDevice(deps(h, hub.fetchImpl));
    expect(second).toEqual({ decision: { action: 'skip', reason: 'enrolled' } });
    expect(hub.calls).toEqual(['GET /api/v1/devices', 'GET /api/v1/devices']);
    expect(readDeviceCredential(h)?.token).toBe(cred?.token);
  });

  it('leaves a revoked machine revoked and keeps the local file', async () => {
    const h = freshHome();
    writeDeviceCredential(
      { hubUrl: URL, deviceId: ID, label: 'mac', token: 'abdev_old', enrolledAt: '' },
      h,
    );
    const hub = fakeHub([{ id: ID, label: 'mac', revokedAt: '2026-11-01T00:00:00.000Z' }]);
    const res = await enrollOperatorDevice(deps(h, hub.fetchImpl));
    expect(res.decision).toEqual({ action: 'revoked', label: 'mac' });
    expect(hub.calls).toEqual(['GET /api/v1/devices']);
    expect(readDeviceCredential(h)?.token).toBe('abdev_old');
  });

  it('re-enrolls when the hub lists the machine but no longer takes the local token', async () => {
    const h = freshHome();
    writeDeviceCredential(
      { hubUrl: URL, deviceId: ID, label: 'mac', token: 'abdev_stale', enrolledAt: '' },
      h,
    );
    const hub = fakeHub([{ id: ID, label: 'mac', revokedAt: null }]);
    const res = await enrollOperatorDevice(deps(h, hub.fetchImpl));
    expect(res.decision).toEqual({ action: 'enroll', rotate: true });
    expect(readDeviceCredential(h)?.token).not.toBe('abdev_stale');
  });

  it('calls nothing when the control box is this machine or the keys are missing', async () => {
    const hub = fakeHub();
    const h = freshHome();
    const exposed = await enrollOperatorDevice({
      ...deps(h, hub.fetchImpl),
      controlBoxIsThisMachine: true,
    });
    expect(exposed.decision).toEqual({ action: 'skip', reason: 'this-machine' });
    const keyless = await enrollOperatorDevice({ ...deps(h, hub.fetchImpl), owner: null });
    expect(keyless.decision).toEqual({ action: 'skip', reason: 'no-owner-credentials' });
    expect(hub.calls).toEqual([]);
    expect(readDeviceCredential(h)).toBeNull();
  });

  it('throws on a refused approval, writing no credential', async () => {
    const h = freshHome();
    const hub = fakeHub();
    await expect(
      enrollOperatorDevice({
        ...deps(h, hub.fetchImpl),
        owner: { apiKey: OWNER.apiKey, adminToken: 'wrong' },
      }),
    ).rejects.toThrow(/approve answered 403/);
    expect(readDeviceCredential(h)).toBeNull();
  });
  it('withdraws the code when approve fails', async () => {
    const h = freshHome();
    const hub = fakeHub([], { approveStatus: 500 });
    await expect(enrollOperatorDevice(deps(h, hub.fetchImpl))).rejects.toThrow(
      /approve answered 500/,
    );
    expect(hub.calls).toContain('POST /api/v1/devices/deny');
    expect(hub.pending.size).toBe(0);
    expect(readDeviceCredential(h)).toBeNull();
  });

  it('does not rotate a token when the hub only fails to answer the probe', async () => {
    const h = freshHome();
    writeDeviceCredential(
      { hubUrl: URL, deviceId: ID, label: 'mac', token: 'abdev_live', enrolledAt: '' },
      h,
    );
    const hub = fakeHub([{ id: ID, label: 'mac', revokedAt: null }], { deviceProbeStatus: 503 });
    await expect(enrollOperatorDevice(deps(h, hub.fetchImpl))).rejects.toThrow(/answered 503/);
    expect(hub.calls).not.toContain('POST /api/v1/devices/code');
    expect(readDeviceCredential(h)?.token).toBe('abdev_live');
  });
});
