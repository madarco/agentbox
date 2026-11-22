import { describe, expect, it } from 'vitest';
import {
  CODE_TTL_MS,
  DEVICE_TOKEN_PREFIX,
  MAX_PENDING,
  createDeviceService,
  createMemoryDeviceRepo,
  hashDeviceToken,
  normalizeUserCode,
} from '../lib/backend/devices';
import { openSqliteDeviceRepo } from '../lib/devices-sqlite';
import { canApproveDevices, parseActor } from '../lib/request-actor';

const ID = '0123456789abcdef0123456789abcdef';

function setup() {
  let t = 1_700_000_000_000;
  const repo = createMemoryDeviceRepo();
  const svc = createDeviceService({ repo, now: () => t });
  return { svc, repo, advance: (ms: number) => (t += ms) };
}

function enroll(svc: ReturnType<typeof setup>['svc'], id = ID, label = 'pc-a') {
  const started = svc.startCode({ deviceId: id, label });
  if (!started.ok) throw new Error(started.message);
  const approved = svc.approve(started.userCode);
  if (!approved.ok) throw new Error(approved.error);
  const claimed = svc.claim(started.deviceCode);
  if (claimed.status !== 'approved') throw new Error(claimed.status);
  return claimed.token;
}

describe('device enrollment', () => {
  it('hands the token out only after approval, and only once', () => {
    const { svc } = setup();
    const s = svc.startCode({ deviceId: ID, label: 'pc-a' });
    expect(s.ok).toBe(true);
    if (!s.ok) return;
    expect(s.userCode).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(svc.claim(s.deviceCode)).toEqual({ status: 'authorization_pending' });
    expect(svc.listPending().map((p) => p.userCode)).toEqual([s.userCode]);

    expect(svc.approve(s.userCode.toLowerCase().replace('-', ''))).toMatchObject({ ok: true });
    const first = svc.claim(s.deviceCode);
    expect(first.status).toBe('approved');
    if (first.status !== 'approved') return;
    expect(first.token.startsWith(DEVICE_TOKEN_PREFIX)).toBe(true);
    expect(first.device).toMatchObject({ id: ID, label: 'pc-a', revokedAt: null, userId: null });
    // A second poll on the same code gets nothing.
    expect(svc.claim(s.deviceCode)).toEqual({ status: 'expired_token' });
    expect(svc.listPending()).toEqual([]);
  });

  it('a denied code ends the poll with access_denied', () => {
    const { svc } = setup();
    const s = svc.startCode({ deviceId: ID, label: 'x' });
    if (!s.ok) throw new Error('start');
    expect(svc.deny(s.userCode)).toBe(true);
    expect(svc.claim(s.deviceCode)).toEqual({ status: 'access_denied' });
    expect(svc.list()).toEqual([]);
  });

  it('codes expire', () => {
    const { svc, advance } = setup();
    const s = svc.startCode({ deviceId: ID, label: 'x' });
    if (!s.ok) throw new Error('start');
    advance(CODE_TTL_MS + 1);
    expect(svc.approve(s.userCode)).toMatchObject({ ok: false });
    expect(svc.claim(s.deviceCode)).toEqual({ status: 'expired_token' });
  });

  it('bounds the codes an unauthenticated caller can open', () => {
    const { svc } = setup();
    for (let i = 0; i < MAX_PENDING; i++) {
      expect(
        svc.startCode({ deviceId: `${ID.slice(0, 30)}${String(i).padStart(2, '0')}`, label: 'x' })
          .ok,
      ).toBe(true);
    }
    expect(svc.startCode({ deviceId: ID, label: 'x' })).toMatchObject({
      ok: false,
      code: 'rate_limited',
    });
  });

  it('rejects a deviceId that is not a machine id, and cleans the label', () => {
    const { svc } = setup();
    expect(svc.startCode({ deviceId: '../etc', label: 'x' })).toMatchObject({ ok: false });
    expect(svc.startCode({ deviceId: 42, label: 'x' })).toMatchObject({ ok: false });
    const s = svc.startCode({ deviceId: ID, label: 'evil\u001b[31mname' });
    expect(s.ok && svc.listPending()[0]!.label).toBe('evil[31mname');
  });

  it('normalizes typed codes', () => {
    expect(normalizeUserCode('abcd efgh')).toBe('ABCD-EFGH');
    expect(normalizeUserCode('ABCD-EFGH')).toBe('ABCD-EFGH');
  });
});

describe('device tokens', () => {
  it('verify, store only a hash, and touch lastSeen', () => {
    const { svc, repo } = setup();
    const token = enroll(svc);
    expect(svc.verifyToken(token)?.id).toBe(ID);
    expect(repo.findByTokenHash(hashDeviceToken(token))?.id).toBe(ID);
    expect(repo.get(ID)?.lastSeenAt).not.toBeNull();
    expect(svc.verifyToken('abdev_wrong')).toBeNull();
    expect(svc.verifyToken('not-a-device-token')).toBeNull();
  });

  it('revocation is immediate, idempotent, and notifies listeners once', () => {
    const { svc } = setup();
    const token = enroll(svc);
    const seen: string[] = [];
    svc.onRevoked((id) => seen.push(id));
    expect(svc.revoke(ID)).toBe(true);
    expect(svc.verifyToken(token)).toBeNull();
    expect(svc.revoke(ID)).toBe(true);
    expect(seen).toEqual([ID]);
    expect(svc.revoke('ffffffffffffffffffffffffffffffff')).toBe(false);
    expect(svc.list()[0]!.revokedAt).not.toBeNull();
  });

  it('re-enrolling a device replaces its token and closes what the old one holds open', () => {
    const { svc } = setup();
    const old = enroll(svc);
    const seen: string[] = [];
    svc.onRevoked((id) => seen.push(id));
    const s = svc.startCode({ deviceId: ID, label: 'pc-a' });
    if (!s.ok) throw new Error('start');
    expect(svc.listPending()[0]!.reenroll).toBe(true);
    svc.approve(s.userCode);
    const claimed = svc.claim(s.deviceCode);
    expect(claimed.status).toBe('approved');
    expect(svc.verifyToken(old)).toBeNull();
    expect(seen).toEqual([ID]);
  });

  it('a revoked device can be enrolled again', () => {
    const { svc } = setup();
    enroll(svc);
    svc.revoke(ID);
    const token = enroll(svc);
    expect(svc.verifyToken(token)?.revokedAt).toBeNull();
    expect(svc.list()).toHaveLength(1);
  });

  it('renames', () => {
    const { svc } = setup();
    enroll(svc);
    expect(svc.rename(ID, '  laptop  ')).toEqual({ ok: true });
    expect(svc.list()[0]!.label).toBe('laptop');
    expect(svc.rename(ID, '   ')).toMatchObject({ ok: false });
    expect(svc.rename('nope-nope-nope', 'x')).toMatchObject({ ok: false });
  });
});

describe('sqlite device repo', () => {
  it('round-trips enroll / verify / revoke', async () => {
    const repo = await openSqliteDeviceRepo(':memory:');
    const svc = createDeviceService({ repo });
    const token = enroll(svc);
    expect(svc.verifyToken(token)?.label).toBe('pc-a');
    expect(repo.list()).toHaveLength(1);
    expect(repo.revoke(ID, Date.now())).toBe('revoked');
    expect(repo.revoke(ID, Date.now())).toBe('already');
    expect(repo.revoke('missing-device-id', Date.now())).toBe('missing');
    expect(svc.verifyToken(token)).toBeNull();
    const again = enroll(svc);
    expect(svc.verifyToken(again)?.id).toBe(ID);
  });
});

describe('request actor', () => {
  it('parses the gate stamp and refuses anything unknown', () => {
    expect(parseActor(`device:${ID}`)).toEqual({ kind: 'device', deviceId: ID });
    expect(parseActor('api-key')).toEqual({ kind: 'api-key' });
    expect(parseActor('device:')).toEqual({ kind: 'anonymous' });
    expect(parseActor('root')).toEqual({ kind: 'anonymous' });
    expect(parseActor(null)).toEqual({ kind: 'anonymous' });
  });

  it('a device can never approve another device', () => {
    expect(canApproveDevices({ kind: 'device', deviceId: ID })).toBe(false);
    expect(canApproveDevices({ kind: 'anonymous' })).toBe(false);
    expect(canApproveDevices({ kind: 'hub-token' })).toBe(false);
    expect(canApproveDevices({ kind: 'session' })).toBe(true);
    expect(canApproveDevices({ kind: 'api-key' })).toBe(true);
  });
});
