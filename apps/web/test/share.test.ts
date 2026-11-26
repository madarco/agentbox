import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SHARE_MAX_BYTES, toShare, usageFixture } from '@agentbox/usage-view';
import { handleSharePost, ipBucket } from '@/lib/share/post';
import { SHARE_RATE, getShare, listShares } from '@/lib/share/store';
import type { Sql } from '@/lib/share/store';

// Runs against a throwaway schema of SHARE_TEST_DATABASE_URL
// (e.g. docker run -e POSTGRES_PASSWORD=pw -p 55432:5432 postgres:16).
const URL_ = process.env.SHARE_TEST_DATABASE_URL;
const SALT = 'test-salt';

const fixture = (handle: string): string => JSON.stringify(toShare(usageFixture(), handle));

let ipSeq = 0;
const freshIp = (): string => `10.0.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`;

function post(
  sql: Sql,
  body: string,
  opts: { ip?: string; secret?: string; contentLength?: boolean } = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-real-ip': opts.ip ?? freshIp(),
  };
  if (opts.secret) headers.authorization = `Bearer ${opts.secret}`;
  const req = new Request('https://agent-box.sh/api/share', { method: 'POST', headers, body });
  return handleSharePost(req, { sql, ipSalt: SALT });
}

describe('POST /api/share without a database', () => {
  it('answers 503 when the database or the salt is not configured', async () => {
    const req = new Request('https://x/api/share', { method: 'POST', body: '{}' });
    expect((await handleSharePost(req, { sql: null, ipSalt: SALT })).status).toBe(503);
  });
});

describe.skipIf(!URL_)('POST /api/share', () => {
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

  let handle: string;
  beforeEach(() => {
    handle = `t-${randomBytes(5).toString('hex')}`;
  });

  it('reads no share before the tables exist, without creating them', async () => {
    expect(await getShare(sql, handle, 1)).toBeNull();
    expect((await listShares(sql, handle)).shares).toEqual([]);
    const [t] = await sql`SELECT to_regclass('shares') AS t`;
    expect(t!.t).toBeNull();
  });

  it('claims a handle on the first post, then needs its secret', async () => {
    const first = await post(sql, fixture(handle));
    expect(first.status).toBe(201);
    const a = (await first.json()) as { url: string; n: number; claimSecret?: string };
    expect(a.n).toBe(1);
    expect(a.url).toBe(`https://agent-box.sh/u/${handle}/1`);
    expect(a.claimSecret).toMatch(/^[A-Za-z0-9_-]{40,}$/);

    const second = await post(sql, fixture(handle), { secret: a.claimSecret });
    expect(second.status).toBe(201);
    const b = (await second.json()) as { n: number; claimSecret?: string };
    expect(b).toMatchObject({ n: 2 });
    expect(b.claimSecret).toBeUndefined();

    expect((await post(sql, fixture(handle))).status).toBe(403);
    expect((await post(sql, fixture(handle), { secret: 'wrong' })).status).toBe(403);

    const stored = await getShare(sql, handle, 2);
    expect(stored?.share.handle).toBe(handle);
    expect((await listShares(sql, handle)).shares.map((s) => s.n)).toEqual([2, 1]);
    const [row] = await sql<{ claim_hash: string }[]>`
      SELECT claim_hash FROM handles WHERE handle = ${handle}`;
    expect(row!.claim_hash).not.toContain(a.claimSecret!);
  });

  it('stores the parsed share, not the raw body', async () => {
    const share = JSON.parse(fixture(handle)) as Record<string, unknown>;
    const spaced = JSON.stringify(share, null, 1);
    expect((await post(sql, spaced)).status).toBe(201);
    const [row] = await sql<{ snapshot: unknown; ip_hash: string }[]>`
      SELECT snapshot, ip_hash FROM shares WHERE handle = ${handle}`;
    expect(row!.snapshot).toEqual(share);
    expect(row!.ip_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects a body over the size cap before parsing it', async () => {
    const big = ' '.repeat(SHARE_MAX_BYTES + 1);
    expect((await post(sql, big)).status).toBe(413);
  });

  it('rejects a __proto__ key and unknown keys', async () => {
    const share = JSON.parse(fixture(handle)) as Record<string, unknown>;
    const proto = fixture(handle).replace('{', '{"__proto__":{"x":1},');
    expect((await post(sql, proto)).status).toBe(400);
    expect((await post(sql, JSON.stringify({ ...share, note: 'buy now' }))).status).toBe(400);
    expect((await post(sql, JSON.stringify({ ...share, handle: 'Not A Handle' }))).status).toBe(
      400,
    );
    expect((await post(sql, 'not json')).status).toBe(400);
    expect((await sql`SELECT 1 FROM handles WHERE handle = ${handle}`).length).toBe(0);
  });

  it('refuses reserved handles', async () => {
    for (const h of ['example', 'agentbox', 'admin', 'anthropic']) {
      expect((await post(sql, fixture(h))).status).toBe(403);
    }
    expect((await sql`SELECT 1 FROM handles WHERE handle = 'agentbox'`).length).toBe(0);
  });

  it('limits a whole IPv6 /64 as one client', async () => {
    const prefix = `2001:db8:${(++ipSeq).toString(16)}:1`;
    for (let i = 0; i < SHARE_RATE.newHandlesPerDay; i++) {
      expect(
        (await post(sql, fixture(`${handle}-${i}`), { ip: `${prefix}::${i + 1}` })).status,
      ).toBe(201);
    }
    expect((await post(sql, fixture(`${handle}-x`), { ip: `${prefix}:ab:cd:ef:99` })).status).toBe(
      429,
    );
  });

  it('assigns distinct n to concurrent posts for one handle', async () => {
    const first = (await (await post(sql, fixture(handle))).json()) as { claimSecret: string };
    const results = await Promise.all(
      Array.from({ length: 8 }, () => post(sql, fixture(handle), { secret: first.claimSecret })),
    );
    expect(results.map((r) => r.status)).toEqual(Array(8).fill(201));
    const ns = await Promise.all(results.map(async (r) => ((await r.json()) as { n: number }).n));
    expect(ns.sort((x, y) => x - y)).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('gives a concurrently claimed handle to exactly one poster', async () => {
    const results = await Promise.all(Array.from({ length: 4 }, () => post(sql, fixture(handle))));
    expect(results.map((r) => r.status).sort()).toEqual([201, 403, 403, 403]);
  });

  it('limits shares per IP per hour', async () => {
    const ip = freshIp();
    const first = (await (await post(sql, fixture(handle), { ip })).json()) as {
      claimSecret: string;
    };
    for (let i = 1; i < SHARE_RATE.sharesPerHour; i++) {
      expect((await post(sql, fixture(handle), { ip, secret: first.claimSecret })).status).toBe(
        201,
      );
    }
    const over = await post(sql, fixture(handle), { ip, secret: first.claimSecret });
    expect(over.status).toBe(429);
    expect(Number(over.headers.get('retry-after'))).toBeGreaterThan(3000);
    // Another IP is unaffected.
    expect((await post(sql, fixture(handle), { secret: first.claimSecret })).status).toBe(201);
  });

  it('limits new handles per IP per day, without leaving the refused handle behind', async () => {
    const ip = freshIp();
    for (let i = 0; i < SHARE_RATE.newHandlesPerDay; i++) {
      expect((await post(sql, fixture(`${handle}-${i}`), { ip })).status).toBe(201);
    }
    const over = await post(sql, fixture(`${handle}-x`), { ip });
    expect(over.status).toBe(429);
    expect(Number(over.headers.get('retry-after'))).toBeGreaterThan(80000);
    expect((await sql`SELECT 1 FROM handles WHERE handle = ${handle + '-x'}`).length).toBe(0);
    // The refused handle is still free for someone else.
    expect((await post(sql, fixture(`${handle}-x`))).status).toBe(201);
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
