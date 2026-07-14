import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BoxRegistry, EventBuffer } from '../src/registry.js';
import { BoxStatusStore } from '../src/status-store.js';
import { SqliteStore } from '../src/store/sqlite-store.js';
import { WriteThroughStore } from '../src/store/write-through-store.js';
import { makeBox, runStoreConformance } from './store-conformance-suite.js';

// BoxStatusStore.set persists status.json under $HOME/.agentbox/boxes — point it
// at a throwaway dir so the suite doesn't touch the real home.
const home = mkdtempSync(join(tmpdir(), 'agentbox-wt-home-'));
beforeAll(() => {
  process.env.HOME = home;
});
afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

// A WriteThroughStore over a fresh in-memory SQLite store must be behaviorally
// identical to the durable store it wraps — reads delegate straight through.
const open: SqliteStore[] = [];
runStoreConformance('WriteThroughStore(SqliteStore)', () => {
  const inner = new SqliteStore({ path: ':memory:' });
  open.push(inner);
  const store = new WriteThroughStore(inner, {
    registry: new BoxRegistry(),
    events: new EventBuffer(),
    statusStore: new BoxStatusStore(),
  });
  return Promise.resolve(store);
});
afterAll(async () => {
  await Promise.all(open.map((s) => s.close()));
});

describe('WriteThroughStore mirroring', () => {
  function fresh(): { store: WriteThroughStore; registry: BoxRegistry; statusStore: BoxStatusStore } {
    const registry = new BoxRegistry();
    const statusStore = new BoxStatusStore();
    const store = new WriteThroughStore(new SqliteStore({ path: ':memory:' }), {
      registry,
      events: new EventBuffer(),
      statusStore,
    });
    return { store, registry, statusStore };
  }

  const status = { schema: 1, boxId: 'b1', claude: { state: 'idle' } };

  it('mirrors registerBox + setStatus into the in-memory instances the loops read', async () => {
    const { store, registry, statusStore } = fresh();
    await store.registerBox(makeBox('b1', 'tok-1', { name: 'box-one' }));
    await store.setStatus('b1', 'box-one', 1, status);

    // The daemon loops + hub backend read these synchronously — they must be populated.
    expect(registry.get('b1')?.token).toBe('tok-1');
    expect(registry.list().map((r) => r.boxId)).toEqual(['b1']);
    expect(statusStore.get('b1')).toEqual(status);
  });

  it('mirrors forgetBox + deleteStatus removals', async () => {
    const { store, registry, statusStore } = fresh();
    await store.registerBox(makeBox('b1', 'tok-1'));
    await store.setStatus('b1', 'b1', undefined, status);
    expect(await store.forgetBox('b1')).toBe(true);
    await store.deleteStatus('b1');
    expect(registry.get('b1')).toBeUndefined();
    expect(statusStore.get('b1')).toBeUndefined();
  });

  it('hydrate() re-populates the in-memory instances from a restarted store', async () => {
    // Seed a durable store, then simulate a relay restart: a brand-new
    // WriteThroughStore over the same DB with EMPTY in-memory instances.
    const dir = mkdtempSync(join(tmpdir(), 'agentbox-wt-'));
    try {
      const path = join(dir, 'store.db');
      const seed = new SqliteStore({ path });
      await seed.registerBox(makeBox('b1', 'tok-1', { name: 'persisted' }));
      await seed.setStatus('b1', 'persisted', 2, status);
      await seed.close();

      const registry = new BoxRegistry();
      const statusStore = new BoxStatusStore();
      const restarted = new WriteThroughStore(new SqliteStore({ path }), {
        registry,
        events: new EventBuffer(),
        statusStore,
      });
      // Before hydration the mirror is empty (the loops would see nothing).
      expect(registry.list()).toEqual([]);
      await restarted.hydrate();
      expect(registry.get('b1')?.name).toBe('persisted');
      expect(statusStore.get('b1')).toEqual(status);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
