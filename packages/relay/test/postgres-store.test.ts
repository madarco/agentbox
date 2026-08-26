import { afterAll, describe, it } from 'vitest';
import type { Pool } from 'pg';
import { PostgresStore } from '../src/store/postgres-store.js';
import { runStoreConformance } from './store-conformance-suite.js';

/**
 * Postgres conformance — gated behind AGENTBOX_TEST_DATABASE_URL so the default
 * `pnpm test` stays pure (no docker, no network). To run it locally:
 *
 *   docker run --rm -d -p 55432:5432 -e POSTGRES_PASSWORD=pw --name abpg postgres:16
 *   AGENTBOX_TEST_DATABASE_URL=postgres://postgres:pw@localhost:55432/postgres \
 *     pnpm --filter @agentbox/relay test postgres-store
 *   docker rm -f abpg
 */
const url = process.env.AGENTBOX_TEST_DATABASE_URL ?? '';

if (!url) {
  describe.skip('Store conformance: PostgresStore (set AGENTBOX_TEST_DATABASE_URL to run)', () => {
    it('skipped — no AGENTBOX_TEST_DATABASE_URL', () => {});
  });
} else {
  const store = new PostgresStore({ connectionString: url });
  let adminPool: Pool | undefined;

  runStoreConformance('PostgresStore', async () => {
    await store.migrate();
    if (!adminPool) {
      const { Pool } = await import('pg');
      adminPool = new Pool({ connectionString: url });
    }
    // Fresh state per test; RESTART IDENTITY makes event ids deterministic.
    // create_jobs is in the list because the queue test re-uses fixed ids (j1/j2)
    // and enqueue is ON CONFLICT DO NOTHING — leftovers from an earlier run would
    // otherwise make the claim test pass only against a virgin database.
    await adminPool.query(
      'TRUNCATE boxes, events, box_status, prompts, create_jobs RESTART IDENTITY',
    );
    return store;
  });

  afterAll(async () => {
    await store.close();
    if (adminPool) await adminPool.end();
  });
}
