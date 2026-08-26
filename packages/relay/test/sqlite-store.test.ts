import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { SqliteStore } from '../src/store/sqlite-store.js';
import { makeBox, runStoreConformance } from './store-conformance-suite.js';

/**
 * SQLite conformance — pure (no docker, no network): every case gets a fresh
 * `:memory:` DB, so this runs in the default `pnpm test`.
 */
const open: SqliteStore[] = [];

runStoreConformance('SqliteStore', () => {
  const store = new SqliteStore({ path: ':memory:' });
  open.push(store);
  return Promise.resolve(store);
});

afterAll(async () => {
  await Promise.all(open.map((s) => s.close()));
});

describe('SqliteStore persistence', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentbox-sqlite-store-'));
  const path = join(dir, 'nested', 'store.db');

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('survives a store (process) restart on disk', async () => {
    const first = new SqliteStore({ path });
    await first.registerBox(makeBox('b1', 'tok-1', { name: 'persisted' }));
    await first.createPrompt({
      id: 'p1',
      boxId: 'b1',
      ev: { id: 'p1', kind: 'confirm', message: 'push?', context: { command: 'git push' } },
      method: 'git.lease-token',
      params: { path: '/workspace' },
      status: 'pending',
      createdAt: new Date().toISOString(),
    });
    await first.close();

    // A brand new store over the same file is what a relay restart looks like.
    const second = new SqliteStore({ path });
    expect((await second.getBox('b1'))?.name).toBe('persisted');
    expect((await second.authenticateBox('tok-1'))?.boxId).toBe('b1');
    expect((await second.listPendingPrompts('b1')).map((p) => p.id)).toEqual(['p1']);
    await second.close();
  });
});
