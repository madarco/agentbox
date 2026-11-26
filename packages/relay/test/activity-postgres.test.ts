import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { PostgresActivityStore } from '../src/activity/index.js';

/**
 * The postgres ledger, gated like the relay store's conformance run:
 *
 *   docker run --rm -d -p 55432:5432 -e POSTGRES_PASSWORD=pw --name abpg postgres:16
 *   AGENTBOX_TEST_DATABASE_URL=postgres://postgres:pw@localhost:55432/postgres \
 *     pnpm --filter @agentbox/relay test activity-postgres
 *   docker rm -f abpg
 */
const url = process.env.AGENTBOX_TEST_DATABASE_URL ?? '';

if (!url) {
  describe.skip('PostgresActivityStore (set AGENTBOX_TEST_DATABASE_URL to run)', () => {
    it('skipped — no AGENTBOX_TEST_DATABASE_URL', () => {});
  });
} else {
  const store = new PostgresActivityStore({ connectionString: url });
  let admin: Pool | undefined;

  beforeEach(async () => {
    await store.migrate();
    if (!admin) {
      const { Pool } = await import('pg');
      admin = new Pool({ connectionString: url });
    }
    await admin.query('TRUNCATE activity_events');
  });

  afterAll(async () => {
    await store.close();
    await admin?.end();
  });

  describe('PostgresActivityStore', () => {
    it('appends once per id, in chunks, and reads back the same shape', async () => {
      const base = Date.parse('2026-11-01T00:00:00.000Z');
      const rows = Array.from({ length: 1200 }, (_, i) => ({
        id: `e${String(i)}`,
        type: i % 2 ? ('box.paused' as const) : ('box.resumed' as const),
        at: new Date(base + i * 1000).toISOString(),
        boxId: `b${String(i % 3)}`,
        source: 'backfill' as const,
      }));
      expect(await store.append(rows)).toBe(1200);
      expect(await store.append(rows)).toBe(0);
      await store.append([
        {
          id: 'push',
          type: 'git.push',
          at: new Date(base + 5_000_000).toISOString(),
          boxId: 'b1',
          commits: 3,
          filesChanged: 4,
          additions: 9,
          deletions: 1,
          hostOnly: true,
          pr: { repo: 'acme/x', number: 2, url: 'https://github.com/acme/x/pull/2' },
          source: 'live',
        },
      ]);
      const push = await store.list({ types: ['git.push'] });
      expect(push[0]).toMatchObject({
        commits: 3,
        filesChanged: 4,
        hostOnly: true,
        pr: { repo: 'acme/x', number: 2 },
        at: new Date(base + 5_000_000).toISOString(),
      });
      const win = await store.list({
        sinceMs: base,
        untilMs: base + 10_000,
        boxId: 'b0',
      });
      expect(win.map((e) => e.id)).toEqual(['e0', 'e3', 'e6', 'e9']);
      expect(Number(await store.getMeta('created_at'))).toBeGreaterThan(0);
      expect([...(await store.has(['e1', 'push', 'nope']))].sort()).toEqual(['e1', 'push']);
      const newest = await store.list({ limit: 2, order: 'desc' });
      expect(newest.map((e) => e.id)).toEqual(['e1199', 'push']);
    });
  });
}
