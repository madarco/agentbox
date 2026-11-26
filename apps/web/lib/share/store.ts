import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import postgres from 'postgres';
import { UsageShare } from '@agentbox/usage-view';
import { SHARE_DDL } from '@/db/schema.mjs';

export type Sql = postgres.Sql;

/** Per IP hash, the SQL backstop to a firewall rule. */
export const SHARE_RATE = {
  sharesPerHour: 10,
  newHandlesPerDay: 3,
} as const;

/** Handles the site itself uses: `/u/example` is the fixture demo. */
export const RESERVED_HANDLES = new Set(['example']);

let client: Sql | null = null;
let ready: Promise<void> | null = null;

/** The shared client, or null when no database is configured (a preview without Neon). */
export function db(): Sql | null {
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  // prepare:false: Neon's pooled endpoint is pgbouncer in transaction mode.
  client ??= postgres(url, { prepare: false, max: 5, idle_timeout: 20, onnotice: () => {} });
  return client;
}

/** Create the tables once per process; a failure is retried on the next call. */
export function ensureSchema(sql: Sql): Promise<void> {
  ready ??= sql
    .unsafe(SHARE_DDL)
    .then(() => undefined)
    .catch((err: unknown) => {
      ready = null;
      throw err;
    });
  return ready;
}

export const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

export function hashIp(ip: string, salt: string): string {
  return createHmac('sha256', salt).update(ip).digest('hex');
}

function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === y.length && timingSafeEqual(x, y);
}

export type CreateResult =
  | { ok: true; n: number; claimSecret?: string }
  | { ok: false; status: 403 }
  | { ok: false; status: 429; retryAfter: number };

class Reject extends Error {
  constructor(readonly result: CreateResult) {
    super('share rejected');
  }
}

/**
 * Store one share. Runs in one transaction, serialized per IP hash (so a burst cannot
 * slip past the limits) and per handle (so `n` is max + 1 without a race).
 */
export async function createShare(
  sql: Sql,
  input: { share: UsageShare; ipHash: string; secret: string | null },
): Promise<CreateResult> {
  const { share, ipHash, secret } = input;
  const handle = share.handle;
  if (RESERVED_HANDLES.has(handle)) return { ok: false, status: 403 };
  await ensureSchema(sql);
  // A rejection throws, so the transaction rolls back (a returned value would commit).
  const reject = (r: CreateResult): never => {
    throw new Reject(r);
  };
  try {
    return await sql.begin(async (tx): Promise<CreateResult> => {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${'share-ip:' + ipHash}))`;
      const [recent] = await tx<{ count: number; oldest: Date | null }[]>`
      SELECT count(*)::int AS count, min(created_at) AS oldest FROM shares
      WHERE ip_hash = ${ipHash} AND created_at > now() - interval '1 hour'`;
      if (recent!.count >= SHARE_RATE.sharesPerHour) {
        reject({ ok: false, status: 429, retryAfter: retryAfter(recent!.oldest, 3600) });
      }

      let claimSecret: string | undefined;
      const created = await tx`
      INSERT INTO handles (handle, claim_hash) VALUES (${handle}, '')
      ON CONFLICT (handle) DO NOTHING RETURNING handle`;
      if (created.length === 1) {
        // A new handle is counted by its first share (n = 1), which carries the IP hash.
        const [fresh] = await tx<{ count: number; oldest: Date | null }[]>`
        SELECT count(*)::int AS count, min(created_at) AS oldest FROM shares
        WHERE ip_hash = ${ipHash} AND n = 1 AND created_at > now() - interval '1 day'`;
        if (fresh!.count >= SHARE_RATE.newHandlesPerDay) {
          reject({ ok: false, status: 429, retryAfter: retryAfter(fresh!.oldest, 86400) });
        }
        claimSecret = randomBytes(32).toString('base64url');
        await tx`UPDATE handles SET claim_hash = ${sha256(claimSecret)} WHERE handle = ${handle}`;
      } else {
        const [row] = await tx<{ claim_hash: string }[]>`
        SELECT claim_hash FROM handles WHERE handle = ${handle} FOR UPDATE`;
        if (!secret || !sameHash(sha256(secret), row!.claim_hash))
          reject({ ok: false, status: 403 });
      }

      const [inserted] = await tx<{ n: number }[]>`
      INSERT INTO shares (handle, n, snapshot, ip_hash)
      SELECT ${handle}, coalesce(max(n), 0) + 1, ${tx.json(share as postgres.JSONValue)}, ${ipHash}
      FROM shares WHERE handle = ${handle}
      RETURNING n`;
      return claimSecret ? { ok: true, n: inserted!.n, claimSecret } : { ok: true, n: inserted!.n };
    });
  } catch (err) {
    if (err instanceof Reject) return err.result;
    throw err;
  }
}

function retryAfter(oldest: Date | null, windowSec: number): number {
  if (!oldest) return windowSec;
  return Math.max(1, Math.ceil((oldest.getTime() + windowSec * 1000 - Date.now()) / 1000));
}

export interface StoredShare {
  share: UsageShare;
  createdAt: Date;
}

/** A stored share, re-validated on the way out; null when absent or no longer valid. */
export async function getShare(sql: Sql, handle: string, n: number): Promise<StoredShare | null> {
  await ensureSchema(sql);
  const [row] = await sql<{ snapshot: unknown; created_at: Date }[]>`
    SELECT snapshot, created_at FROM shares WHERE handle = ${handle} AND n = ${n}`;
  if (!row) return null;
  const parsed = UsageShare.safeParse(row.snapshot);
  return parsed.success ? { share: parsed.data, createdAt: row.created_at } : null;
}

export interface ShareSummary extends StoredShare {
  n: number;
}

export async function listShares(sql: Sql, handle: string): Promise<ShareSummary[]> {
  await ensureSchema(sql);
  const rows = await sql<{ n: number; snapshot: unknown; created_at: Date }[]>`
    SELECT n, snapshot, created_at FROM shares WHERE handle = ${handle}
    ORDER BY n DESC LIMIT 200`;
  const out: ShareSummary[] = [];
  for (const r of rows) {
    const parsed = UsageShare.safeParse(r.snapshot);
    if (parsed.success) out.push({ n: r.n, share: parsed.data, createdAt: r.created_at });
  }
  return out;
}
