// Devices: the PCs enrolled on this hub, each with its own revocable token
// (multi-PC Phase 1b). A device's id is the PC's `getMachineId()` — never a
// second identity — and its label is the hostname it reported.
//
// Enrollment is a device-code flow: the CLI asks for a code, the owner approves
// it in the web UI, the CLI's poll receives the token once. Pending codes live in
// memory only (a hub restart drops them and the CLI says to re-run `hub login`);
// approved devices live in the repo, with the token stored as a sha256 hash.
import { createHash, randomBytes, randomInt } from 'node:crypto';

export interface DeviceRecord {
  /** The PC's machine id (`~/.agentbox/machine-id`). */
  id: string;
  label: string;
  createdAt: number;
  lastSeenAt: number | null;
  revokedAt: number | null;
  /** Reserved for Stage 2 (users). Always null today. */
  userId: string | null;
}

/** Storage for approved devices. `apps/hub/lib/devices-sqlite.ts` in production. */
export interface DeviceRepo {
  get(id: string): DeviceRecord | null;
  list(): DeviceRecord[];
  findByTokenHash(hash: string): DeviceRecord | null;
  /** Insert, or re-enroll an existing id: new token, label, `revokedAt` cleared. */
  enroll(rec: { id: string; label: string; tokenHash: string; now: number }): DeviceRecord;
  setLabel(id: string, label: string): boolean;
  /** Sets `revokedAt` and drops the token hash, so the old token can never match again. */
  revoke(id: string, now: number): 'revoked' | 'already' | 'missing';
  touch(id: string, now: number): void;
}

export interface PendingCode {
  userCode: string;
  deviceId: string;
  label: string;
  createdAt: number;
  expiresAt: number;
  /** True when approving would replace the token of an already-enrolled device. */
  reenroll: boolean;
}

export type ClaimResult =
  | { status: 'approved'; token: string; device: DeviceRecord }
  | { status: 'authorization_pending' | 'access_denied' | 'expired_token' };

export type StartCodeResult =
  | {
      ok: true;
      deviceCode: string;
      userCode: string;
      expiresIn: number;
      interval: number;
    }
  | { ok: false; code: 'invalid_request' | 'rate_limited'; message: string };

export interface DeviceService {
  startCode(input: { deviceId: unknown; label: unknown }): StartCodeResult;
  claim(deviceCode: string): ClaimResult;
  listPending(): PendingCode[];
  approve(userCode: string): { ok: true; device: DeviceRecord } | { ok: false; error: string };
  deny(userCode: string): boolean;
  list(): DeviceRecord[];
  rename(id: string, label: unknown): { ok: true } | { ok: false; error: string };
  /** Idempotent: false only when no such device exists. */
  revoke(id: string): boolean;
  /** The device a token belongs to, or null (unknown, revoked, malformed). Sync and cheap. */
  verifyToken(token: string): DeviceRecord | null;
  /** Called with the device id the moment it is revoked. Returns an unsubscribe. */
  onRevoked(listener: (deviceId: string) => void): () => void;
}

export const DEVICE_TOKEN_PREFIX = 'abdev_';
export const CODE_TTL_MS = 10 * 60_000;
export const POLL_INTERVAL_S = 3;
/** Unauthenticated callers can open codes, so the set is bounded. */
export const MAX_PENDING = 20;
/** `lastSeenAt` is written at most this often per device. */
const TOUCH_EVERY_MS = 60_000;
// No vowels or look-alikes (0/O, 1/I/L), so a code can be read aloud and never spells a word.
const USER_CODE_ALPHABET = 'BCDFGHJKMNPQRSTVWXZ23456789';
const DEVICE_ID_RE = /^[A-Za-z0-9-]{8,64}$/;
const MAX_LABEL = 64;

export function hashDeviceToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Trim, drop control characters, cap the length. Empty -> null. */
export function cleanLabel(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, MAX_LABEL);
  return s.length > 0 ? s : null;
}

/** `XXXX-XXXX`, case- and dash-insensitive on input. */
export function normalizeUserCode(raw: string): string {
  const s = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return s.length === 8 ? `${s.slice(0, 4)}-${s.slice(4)}` : s;
}

function mintUserCode(): string {
  let s = '';
  for (let i = 0; i < 8; i++) s += USER_CODE_ALPHABET[randomInt(USER_CODE_ALPHABET.length)];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

interface PendingEntry extends PendingCode {
  deviceCode: string;
  state: 'pending' | 'denied' | { approved: { token: string; device: DeviceRecord } };
}

export function createDeviceService(deps: { repo: DeviceRepo; now?: () => number }): DeviceService {
  const { repo } = deps;
  const now = deps.now ?? Date.now;
  const pending = new Map<string, PendingEntry>(); // by deviceCode
  const listeners = new Set<(deviceId: string) => void>();
  const lastTouched = new Map<string, number>();

  const sweep = (): void => {
    const t = now();
    for (const [k, e] of pending) if (e.expiresAt <= t) pending.delete(k);
  };
  const byUserCode = (userCode: string): PendingEntry | undefined => {
    const want = normalizeUserCode(userCode);
    for (const e of pending.values()) if (e.userCode === want) return e;
    return undefined;
  };

  return {
    startCode(input) {
      const deviceId = typeof input.deviceId === 'string' ? input.deviceId.trim() : '';
      if (!DEVICE_ID_RE.test(deviceId)) {
        return { ok: false, code: 'invalid_request', message: 'deviceId must be the machine id' };
      }
      const label = cleanLabel(input.label) ?? deviceId.slice(0, 8);
      sweep();
      if (pending.size >= MAX_PENDING) {
        return {
          ok: false,
          code: 'rate_limited',
          message: 'too many enrollment codes are waiting; approve or deny some, or retry later',
        };
      }
      let userCode = mintUserCode();
      while (byUserCode(userCode)) userCode = mintUserCode();
      const deviceCode = randomBytes(32).toString('base64url');
      const t = now();
      pending.set(deviceCode, {
        deviceCode,
        userCode,
        deviceId,
        label,
        createdAt: t,
        expiresAt: t + CODE_TTL_MS,
        reenroll: repo.get(deviceId) !== null,
        state: 'pending',
      });
      return {
        ok: true,
        deviceCode,
        userCode,
        expiresIn: CODE_TTL_MS / 1000,
        interval: POLL_INTERVAL_S,
      };
    },

    claim(deviceCode) {
      sweep();
      const e = pending.get(deviceCode);
      if (!e) return { status: 'expired_token' };
      if (e.state === 'pending') return { status: 'authorization_pending' };
      pending.delete(deviceCode);
      if (e.state === 'denied') return { status: 'access_denied' };
      return { status: 'approved', ...e.state.approved };
    },

    listPending() {
      sweep();
      return [...pending.values()]
        .filter((e) => e.state === 'pending')
        .map(({ userCode, deviceId, label, createdAt, expiresAt }) => ({
          userCode,
          deviceId,
          label,
          createdAt,
          expiresAt,
          // Recomputed: the device may have been enrolled since the code was opened.
          reenroll: repo.get(deviceId) !== null,
        }));
    },

    approve(userCode) {
      sweep();
      const e = byUserCode(userCode);
      if (!e || e.state !== 'pending') return { ok: false, error: 'no pending code matches' };
      const token = DEVICE_TOKEN_PREFIX + randomBytes(32).toString('base64url');
      const device = repo.enroll({
        id: e.deviceId,
        label: e.label,
        tokenHash: hashDeviceToken(token),
        now: now(),
      });
      // A re-enrolled device's old token stopped matching the moment its hash was
      // replaced; anything still streaming on it must be closed like a revocation.
      if (e.reenroll) for (const l of listeners) l(device.id);
      e.state = { approved: { token, device } };
      return { ok: true, device };
    },

    deny(userCode) {
      sweep();
      const e = byUserCode(userCode);
      if (!e || e.state !== 'pending') return false;
      e.state = 'denied';
      return true;
    },

    list() {
      return repo.list();
    },

    rename(id, label) {
      const clean = cleanLabel(label);
      if (!clean) return { ok: false, error: 'label must be a non-empty string' };
      return repo.setLabel(id, clean) ? { ok: true } : { ok: false, error: 'device not found' };
    },

    revoke(id) {
      const r = repo.revoke(id, now());
      if (r === 'revoked') for (const l of listeners) l(id);
      return r !== 'missing';
    },

    verifyToken(token) {
      if (!token.startsWith(DEVICE_TOKEN_PREFIX)) return null;
      const device = repo.findByTokenHash(hashDeviceToken(token));
      if (!device || device.revokedAt !== null) return null;
      const t = now();
      if (t - (lastTouched.get(device.id) ?? 0) >= TOUCH_EVERY_MS) {
        lastTouched.set(device.id, t);
        repo.touch(device.id, t);
      }
      return device;
    },

    onRevoked(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** In-memory repo — tests, and any profile with no device database. */
export function createMemoryDeviceRepo(): DeviceRepo {
  const rows = new Map<string, DeviceRecord & { tokenHash: string | null }>();
  const strip = (r: DeviceRecord & { tokenHash: string | null }): DeviceRecord => {
    return {
      id: r.id,
      label: r.label,
      createdAt: r.createdAt,
      lastSeenAt: r.lastSeenAt,
      revokedAt: r.revokedAt,
      userId: r.userId,
    };
  };
  return {
    get: (id) => {
      const r = rows.get(id);
      return r ? strip(r) : null;
    },
    list: () => [...rows.values()].map(strip).sort((a, b) => a.createdAt - b.createdAt),
    findByTokenHash: (hash) => {
      for (const r of rows.values()) if (r.tokenHash === hash) return strip(r);
      return null;
    },
    enroll: ({ id, label, tokenHash, now }) => {
      const prev = rows.get(id);
      const row = {
        id,
        label,
        tokenHash,
        createdAt: prev?.createdAt ?? now,
        lastSeenAt: prev?.lastSeenAt ?? null,
        revokedAt: null,
        userId: prev?.userId ?? null,
      };
      rows.set(id, row);
      return strip(row);
    },
    setLabel: (id, label) => {
      const r = rows.get(id);
      if (!r) return false;
      r.label = label;
      return true;
    },
    revoke: (id, now) => {
      const r = rows.get(id);
      if (!r) return 'missing';
      if (r.revokedAt !== null) return 'already';
      r.revokedAt = now;
      r.tokenHash = null;
      return 'revoked';
    },
    touch: (id, now) => {
      const r = rows.get(id);
      if (r) r.lastSeenAt = now;
    },
  };
}
