import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDeviceService, createMemoryDeviceRepo } from '../lib/backend/devices';
import { adminTokenMatches } from '../lib/admin-token';
import { skillContentReadAuthorized } from '../lib/skill-auth';
import { custodyByteReadAuthorized } from '../lib/custody-auth';

const ADMIN = 'admin-token-0123456789abcdef';
const ID = '0123456789abcdef0123456789abcdef';
const OTHER = 'ffffffffffffffffffffffffffffffff';

const { POST: approve } = await import('../app/(dashboard)/api/v1/devices/approve/route');
const { POST: revoke } = await import('../app/(dashboard)/api/v1/devices/[id]/revoke/route');

function req(actor: string, opts: { admin?: string; body?: unknown } = {}): Request {
  return new Request('http://hub/api/v1/devices/x', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-agentbox-actor': actor,
      ...(opts.admin ? { 'x-agentbox-admin-token': opts.admin } : {}),
    },
    body: JSON.stringify(opts.body ?? {}),
  });
}

let svc: ReturnType<typeof createDeviceService>;
let prevAdmin: string | undefined;

beforeEach(() => {
  svc = createDeviceService({ repo: createMemoryDeviceRepo() });
  globalThis.__AGENTBOX_HUB_DEVICES = svc;
  prevAdmin = process.env.AGENTBOX_RELAY_ADMIN_TOKEN;
  process.env.AGENTBOX_RELAY_ADMIN_TOKEN = ADMIN;
});
afterEach(() => {
  globalThis.__AGENTBOX_HUB_DEVICES = undefined;
  if (prevAdmin === undefined) delete process.env.AGENTBOX_RELAY_ADMIN_TOKEN;
  else process.env.AGENTBOX_RELAY_ADMIN_TOKEN = prevAdmin;
});

function code(id = OTHER): string {
  const s = svc.startCode({ deviceId: id, label: 'pc-b' });
  if (!s.ok) throw new Error(s.message);
  return s.userCode;
}

function enrolled(id: string): void {
  const s = svc.startCode({ deviceId: id, label: 'pc' });
  if (!s.ok) throw new Error(s.message);
  svc.approve(s.userCode);
  svc.claim(s.deviceCode);
}

describe('POST /devices/approve (#422 hole)', () => {
  it('refuses the API key alone', async () => {
    const res = await approve(req('api-key', { body: { userCode: code() } }));
    expect(res.status).toBe(403);
  });
  it('refuses the API key with a wrong admin token', async () => {
    const res = await approve(req('api-key', { admin: 'nope', body: { userCode: code() } }));
    expect(res.status).toBe(403);
  });
  it('refuses the API key plus a token when the hub has no admin token', async () => {
    process.env.AGENTBOX_RELAY_ADMIN_TOKEN = '';
    const res = await approve(req('api-key', { admin: ADMIN, body: { userCode: code() } }));
    expect(res.status).toBe(403);
  });
  it('accepts the API key plus the admin token', async () => {
    const res = await approve(req('api-key', { admin: ADMIN, body: { userCode: code() } }));
    expect(res.status).toBe(200);
  });
  it('accepts a signed-in session', async () => {
    const res = await approve(req('session', { body: { userCode: code() } }));
    expect(res.status).toBe(200);
  });
  it('refuses a device token, even with the admin token header', async () => {
    const res = await approve(req(`device:${ID}`, { admin: ADMIN, body: { userCode: code() } }));
    expect(res.status).toBe(403);
  });
});

describe('POST /devices/{id}/revoke', () => {
  const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
  it('a device still revokes itself', async () => {
    enrolled(ID);
    expect((await revoke(req(`device:${ID}`), ctx(ID))).status).toBe(200);
  });
  it('the API key alone cannot revoke another device; with the admin token it can', async () => {
    enrolled(ID);
    expect((await revoke(req('api-key'), ctx(ID))).status).toBe(403);
    expect((await revoke(req('api-key', { admin: ADMIN }), ctx(ID))).status).toBe(200);
  });
});

describe('skill content read', () => {
  const base = {
    mode: 'password' as const,
    adminToken: ADMIN,
    providedToken: '',
    isLoopback: false,
  };
  it('a signed-in session may read skill content on a password hub', () => {
    expect(skillContentReadAuthorized({ ...base, actor: { kind: 'session' } })).toBe(true);
  });
  it('the API key alone still may not', () => {
    expect(skillContentReadAuthorized({ ...base, actor: { kind: 'api-key' } })).toBe(false);
    expect(
      skillContentReadAuthorized({ ...base, isLoopback: true, actor: { kind: 'api-key' } }),
    ).toBe(false);
  });
  it('the admin token still may', () => {
    expect(
      skillContentReadAuthorized({ ...base, providedToken: ADMIN, actor: { kind: 'api-key' } }),
    ).toBe(true);
  });
  it('custody byte reads are unchanged: there is no session exception', () => {
    // custodyByteReadAuthorized takes no actor at all; a session gets nothing from it.
    expect(custodyByteReadAuthorized(base)).toBe(false);
  });
});

describe('adminTokenMatches', () => {
  it('needs a configured token and an exact match', () => {
    expect(adminTokenMatches(ADMIN, ADMIN)).toBe(true);
    expect(adminTokenMatches(ADMIN, '')).toBe(false);
    expect(adminTokenMatches('', '')).toBe(false);
    expect(adminTokenMatches(`${ADMIN}x`, ADMIN)).toBe(false);
  });
});

describe('skillBytesReadAllowed on a password hub (the route gate)', () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of ['AGENTBOX_HUB_PROFILE', 'BETTER_AUTH_SECRET', 'AGENTBOX_HUB_AUTH']) {
      saved[k] = process.env[k];
    }
    process.env.AGENTBOX_HUB_PROFILE = 'hetzner';
    process.env.BETTER_AUTH_SECRET = 'test-secret';
    delete process.env.AGENTBOX_HUB_AUTH;
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
  const read = (actor: string, admin?: string) =>
    new Request('http://hub/api/v1/skills/x/diff', {
      headers: { 'x-agentbox-actor': actor, ...(admin ? { 'x-agentbox-admin-token': admin } : {}) },
    });

  it('lets a session read and refuses the API key alone', async () => {
    const { skillBytesReadAllowed } = await import('../app/(dashboard)/api/v1/skills/_service');
    expect(skillBytesReadAllowed(read('session'))).toBe(true);
    expect(skillBytesReadAllowed(read('api-key'))).toBe(false);
    expect(skillBytesReadAllowed(read('api-key', ADMIN))).toBe(true);
  });
});
