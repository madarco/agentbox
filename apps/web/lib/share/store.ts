import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import postgres from 'postgres';
import { UsageShare } from '@agentbox/usage-view';
import { SHARE_DDL } from '@/db/schema.mjs';

export type Sql = postgres.Sql;

/** Per IP hash, the SQL backstop to a firewall rule. Deleted shares still count. */
export const SHARE_RATE = {
  sharesPerHour: 10,
} as const;

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

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** 24 characters of [a-z0-9] from the CSPRNG, unbiased (bytes >= 252 are redrawn). */
export function newShareId(): string {
  let id = '';
  while (id.length < 24) {
    for (const b of randomBytes(32)) {
      if (b < 252 && id.length < 24) id += ID_ALPHABET[b % 36];
    }
  }
  return id;
}

export type CreateResult =
  | { ok: true; id: string; deleteSecret: string }
  | { ok: false; status: 429; retryAfter: number };

/**
 * Store one share under a fresh id. Serialized per IP hash in one transaction, so a
 * burst cannot slip past the hourly limit. Only the delete secret's hash is kept.
 */
export async function createShare(
  sql: Sql,
  input: { share: UsageShare; ipHash: string },
): Promise<CreateResult> {
  const { share, ipHash } = input;
  await ensureSchema(sql);
  return sql.begin(async (tx): Promise<CreateResult> => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${'share-ip:' + ipHash}))`;
    const [recent] = await tx<{ count: number; oldest: Date | null }[]>`
      SELECT count(*)::int AS count, min(created_at) AS oldest FROM shares
      WHERE ip_hash = ${ipHash} AND created_at > now() - interval '1 hour'`;
    if (recent!.count >= SHARE_RATE.sharesPerHour) {
      return { ok: false, status: 429, retryAfter: retryAfter(recent!.oldest, 3600) };
    }
    const id = newShareId();
    const deleteSecret = randomBytes(32).toString('base64url');
    await tx`
      INSERT INTO shares (id, snapshot, delete_hash, ip_hash)
      VALUES (${id}, ${tx.json(share as postgres.JSONValue)}, ${sha256(deleteSecret)}, ${ipHash})`;
    return { ok: true, id, deleteSecret };
  });
}

function retryAfter(oldest: Date | null, windowSec: number): number {
  if (!oldest) return windowSec;
  return Math.max(1, Math.ceil((oldest.getTime() + windowSec * 1000 - Date.now()) / 1000));
}

/**
 * Delete a share with its delete secret. The snapshot is cleared and the row kept as a
 * tombstone, so the hourly limit still counts it and the id is never handed out again.
 */
export async function deleteShare(
  sql: Sql,
  id: string,
  secret: string,
): Promise<'deleted' | 'not_found' | 'forbidden'> {
  const [row] = await orEmpty(
    sql<{ delete_hash: string }[]>`
      SELECT delete_hash FROM shares WHERE id = ${id} AND deleted_at IS NULL`,
  );
  if (!row) return 'not_found';
  if (!sameHash(sha256(secret), row.delete_hash)) return 'forbidden';
  const done = await sql`
    UPDATE shares SET snapshot = NULL, deleted_at = now()
    WHERE id = ${id} AND deleted_at IS NULL RETURNING id`;
  return done.length === 1 ? 'deleted' : 'not_found';
}

export interface StoredShare {
  share: UsageShare;
  createdAt: Date;
}

/** A stored share, re-validated on the way out; null when absent, deleted or no longer valid. */
export async function getShare(sql: Sql, id: string): Promise<StoredShare | null> {
  const [row] = await orEmpty(
    sql<{ snapshot: unknown; created_at: Date }[]>`
      SELECT snapshot, created_at FROM shares WHERE id = ${id} AND deleted_at IS NULL`,
  );
  if (!row) return null;
  const parsed = UsageShare.safeParse(row.snapshot);
  return parsed.success ? { share: parsed.data, createdAt: row.created_at } : null;
}

/**
 * Reads never create the tables (no DDL on a page view): before the first share
 * there are none, which reads as no rows.
 */
async function orEmpty<T>(q: Promise<T[]>): Promise<T[]> {
  try {
    return await q;
  } catch (err) {
    if ((err as { code?: string }).code === '42P01') return [];
    throw err;
  }
}
