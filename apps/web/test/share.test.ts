import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SHARE_MAX_BYTES, toShare, usageFixture } from '@agentbox/usage-view';
import { SHARE_DDL, SHARE_MIGRATION } from '@/db/schema.mjs';
import { SHARE_ID_RE } from '@/lib/share/params';
import { handleShareDelete, handleSharePost, ipBucket } from '@/lib/share/post';
import { SHARE_RATE, getShare, newShareId } from '@/lib/share/store';
import type { Sql } from '@/lib/share/store';

// Runs against a throwaway schema of SHARE_TEST_DATABASE_URL
// (e.g. docker run -e POSTGRES_PASSWORD=pw -p 55432:5432 postgres:16).
const URL_ = process.env.SHARE_TEST_DATABASE_URL;
const SALT = 'test-salt';

const fixture = (name?: string): string => JSON.stringify(toShare(usageFixture(), name));

let ipSeq = 0;
const freshIp = (): string => `10.0.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`;

interface Posted {
  url: string;
  id: string;
  deleteSecret: string;
}

function post(sql: Sql, body: string, opts: { ip?: string } = {}): Promise<Response> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-real-ip': opts.ip ?? freshIp(),
  };
  const req = new Request('https://agent-box.sh/api/share', { method: 'POST', headers, body });
  return handleSharePost(req, { sql, ipSalt: SALT });
}

function del(sql: Sql, id: string, secret?: string): Promise<Response> {
  const headers: Record<string, string> = secret ? { authorization: `Bearer ${secret}` } : {};
  const req = new Request(`https://agent-box.sh/api/share/${id}`, { method: 'DELETE', headers });
  return handleShareDelete(req, id, { sql });
}

describe('share ids', () => {
  it('are 24 random lowercase letters and digits', () => {
    const ids = Array.from({ length: 2000 }, newShareId);
    for (const id of ids) expect(id).toMatch(SHARE_ID_RE);
    expect(new Set(ids).size).toBe(ids.length);
    const chars = new Set(ids.join(''));
    expect(chars.size).toBe(36);
  });
});

describe('POST /api/share without a database', () => {
  it('answers 503 when the database or the salt is not configured', async () => {
    const req = new Request('https://x/api/share', { method: 'POST', body: '{}' });
    expect((await handleSharePost(req, { sql: null, ipSalt: SALT })).status).toBe(503);
  });
});

describe.skipIf(!URL_)('the share API', () => {
  const schema = `share_test_${randomBytes(4).toString('hex')}`;
  let admin: Sql;
  let sql: Sql;

  beforeAll(async () => {
    admin = postgres(URL_!, { max: 1, onnotice: () => {} });
    await admin.unsafe(`CREATE SCHEMA ${schema}`);
    sql = postgres(URL_!, {
      prepare: false,
      max: 10,
      onnotice: () => {},
      connection: { search_path: schema },
    });
  });

  afterAll(async () => {
    await sql?.end();
    await admin?.unsafe(`DROP SCHEMA ${schema} CASCADE`);
    await admin?.end();
  });

  it('reads no share before the tables exist, without creating them', async () => {
    expect(await getShare(sql, newShareId())).toBeNull();
    expect((await del(sql, newShareId(), 'x')).status).toBe(404);
    const [t] = await sql`SELECT to_regclass('shares') AS t`;
    expect(t!.t).toBeNull();
  });

  it('db:migrate replaces the empty handle-keyed tables, idempotently; the lazy DDL never does', async () => {
    const s = `share_old_${randomBytes(4).toString('hex')}`;
    const old = postgres(URL_!, { max: 1, onnotice: () => {}, connection: { search_path: s } });
    try {
      await admin.unsafe(`CREATE SCHEMA ${s}`);
      await old.unsafe(`
        CREATE TABLE handles (handle text PRIMARY KEY, claim_hash text NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now());
        CREATE TABLE shares (handle text NOT NULL REFERENCES handles (handle), n integer NOT NULL,
          snapshot jsonb NOT NULL, ip_hash text NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (handle, n));
        CREATE INDEX shares_ip_created ON shares (ip_hash, created_at);`);
      // The app's lazy DDL never touches the old tables.
      await old.unsafe(SHARE_DDL);
      const [kept] = await old`SELECT to_regclass('handles') AS t`;
      expect(kept!.t).not.toBeNull();
      await old.unsafe(SHARE_MIGRATION);
      await old.unsafe(SHARE_MIGRATION);
      const cols = await old<{ column_name: string }[]>`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = ${s} AND table_name = 'shares' ORDER BY column_name`;
      expect(cols.map((c) => c.column_name)).toEqual([
        'created_at',
        'delete_hash',
        'deleted_at',
        'id',
        'ip_hash',
        'snapshot',
      ]);
      const [h] = await old`SELECT to_regclass('handles') AS t`;
      expect(h!.t).toBeNull();
    } finally {
      await old.end();
      await admin.unsafe(`DROP SCHEMA IF EXISTS ${s} CASCADE`);
    }
  });

  it('refuses to drop an old shares table that still holds rows', async () => {
    const s = `share_old_${randomBytes(4).toString('hex')}`;
    const old = postgres(URL_!, { max: 1, onnotice: () => {}, connection: { search_path: s } });
    try {
      await admin.unsafe(`CREATE SCHEMA ${s}`);
      await old.unsafe(`
        CREATE TABLE shares (handle text NOT NULL, n integer NOT NULL, snapshot jsonb NOT NULL);
        INSERT INTO shares VALUES ('me', 1, '{}');`);
      await expect(old.unsafe(SHARE_MIGRATION)).rejects.toThrow(/handle-keyed rows/);
      expect((await old`SELECT count(*)::int AS c FROM shares`)[0]!.c).toBe(1);
    } finally {
      await old.end();
      await admin.unsafe(`DROP SCHEMA IF EXISTS ${s} CASCADE`);
    }
  });

  it('stores a share under a fresh id and returns a delete secret', async () => {
    const res = await post(sql, fixture('marco-d'));
    expect(res.status).toBe(201);
    const a = (await res.json()) as Posted;
    expect(a.id).toMatch(SHARE_ID_RE);
    expect(a.url).toBe(`https://agent-box.sh/s/${a.id}`);
    expect(a.deleteSecret).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect((await getShare(sql, a.id))?.share.name).toBe('marco-d');

    // The same body again is another share with another id: a name is not a namespace.
    const b = (await (await post(sql, fixture('marco-d'))).json()) as Posted;
    expect(b.id).not.toBe(a.id);

    const [row] = await sql<{ delete_hash: string }[]>`
      SELECT delete_hash FROM shares WHERE id = ${a.id}`;
    expect(row!.delete_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row!.delete_hash).not.toContain(a.deleteSecret);
  });

  it('takes a share with no display name', async () => {
    const a = (await (await post(sql, fixture())).json()) as Posted;
    const stored = await getShare(sql, a.id);
    expect(stored).not.toBeNull();
    expect('name' in stored!.share).toBe(false);
  });

  it('deletes a share only with its secret, and the id then reads as absent', async () => {
    const a = (await (await post(sql, fixture('me'))).json()) as Posted;
    const b = (await (await post(sql, fixture('me'))).json()) as Posted;
    expect((await del(sql, a.id)).status).toBe(401);
    expect((await del(sql, a.id, 'wrong')).status).toBe(403);
    expect((await del(sql, a.id, b.deleteSecret)).status).toBe(403);
    expect((await del(sql, 'not-an-id', a.deleteSecret)).status).toBe(404);
    expect((await del(sql, a.id, a.deleteSecret)).status).toBe(204);
    expect(await getShare(sql, a.id)).toBeNull();
    expect((await del(sql, a.id, a.deleteSecret)).status).toBe(404);
    const [row] = await sql<
      { snapshot: unknown }[]
    >`SELECT snapshot FROM shares WHERE id = ${a.id}`;
    expect(row!.snapshot).toBeNull();
    expect(await getShare(sql, b.id)).not.toBeNull();
  });

  it('stores the parsed share, not the raw body', async () => {
    const share = JSON.parse(fixture('me')) as Record<string, unknown>;
    const spaced = JSON.stringify(share, null, 1);
    const a = (await (await post(sql, spaced)).json()) as Posted;
    const [row] = await sql<{ snapshot: unknown; ip_hash: string }[]>`
      SELECT snapshot, ip_hash FROM shares WHERE id = ${a.id}`;
    expect(row!.snapshot).toEqual(share);
    expect(row!.ip_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects a body over the size cap before parsing it', async () => {
    const big = ' '.repeat(SHARE_MAX_BYTES + 1);
    expect((await post(sql, big)).status).toBe(413);
  });

  it('rejects a __proto__ key, unknown keys, a handle and a bad name', async () => {
    const share = JSON.parse(fixture('me')) as Record<string, unknown>;
    const proto = fixture('me').replace('{', '{"__proto__":{"x":1},');
    expect((await post(sql, proto)).status).toBe(400);
    expect((await post(sql, JSON.stringify({ ...share, note: 'buy now' }))).status).toBe(400);
    expect((await post(sql, JSON.stringify({ ...share, handle: 'me' }))).status).toBe(400);
    expect((await post(sql, JSON.stringify({ ...share, name: 'Not A Name' }))).status).toBe(400);
    expect((await post(sql, 'not json')).status).toBe(400);
  });

  it('limits a whole IPv6 /64 as one client', async () => {
    const prefix = `2001:db8:${(++ipSeq).toString(16)}:1`;
    for (let i = 0; i < SHARE_RATE.sharesPerHour; i++) {
      expect((await post(sql, fixture(), { ip: `${prefix}::${i + 1}` })).status).toBe(201);
    }
    expect((await post(sql, fixture(), { ip: `${prefix}:ab:cd:ef:99` })).status).toBe(429);
  });

  it('limits shares per IP per hour, deleted ones included, under concurrency', async () => {
    const ip = freshIp();
    const results = await Promise.all(
      Array.from({ length: SHARE_RATE.sharesPerHour + 3 }, () => post(sql, fixture(), { ip })),
    );
    const statuses = results.map((r) => r.status).sort();
    expect(statuses.filter((s) => s === 201)).toHaveLength(SHARE_RATE.sharesPerHour);
    expect(statuses.filter((s) => s === 429)).toHaveLength(3);
    const first = (await results.find((r) => r.status === 201)!.json()) as Posted;
    expect((await del(sql, first.id, first.deleteSecret)).status).toBe(204);
    const over = await post(sql, fixture(), { ip });
    expect(over.status).toBe(429);
    expect(Number(over.headers.get('retry-after'))).toBeGreaterThan(3000);
    // Another IP is unaffected.
    expect((await post(sql, fixture())).status).toBe(201);
  });
});

describe('ipBucket', () => {
  it('keeps an IPv4 address whole', () => {
    expect(ipBucket('203.0.113.7')).toBe('203.0.113.7');
    expect(ipBucket('::ffff:203.0.113.7')).toBe('203.0.113.7');
  });

  it('counts an IPv6 address by its /64', () => {
    const a = ipBucket('2001:db8:85a3:12:8a2e:370:7334:1');
    expect(a).toBe('2001:db8:85a3:12::/64');
    expect(ipBucket('2001:0db8:85a3:0012:ffff:ffff:ffff:ffff')).toBe(a);
    expect(ipBucket('2001:db8:85a3:12::9')).toBe(a);
    expect(ipBucket('[2001:DB8:85A3:12::1]')).toBe(a);
    expect(ipBucket('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(ipBucket('::1')).toBe('0:0:0:0::/64');
    expect(ipBucket('fe80::1%eth0')).toBe('fe80:0:0:0::/64');
    expect(ipBucket('2001:db8:85a3:13::1')).not.toBe(a);
  });
});
