import { describe, expect, it } from 'vitest';
import { MemoryStore } from '../src/store/memory-store.js';
import type { Store } from '../src/store/store.js';
import type { BoxRegistration } from '../src/types.js';

/**
 * Behavioral conformance suite for the {@link Store} seam. Phase 0 runs it
 * against {@link MemoryStore}; later phases run the same factory'd suite
 * against PostgresStore / RemoteStore so every backend honors the same
 * contract. Pure — no network, no docker.
 */
function makeBox(boxId: string, token: string, over: Partial<BoxRegistration> = {}): BoxRegistration {
  return {
    boxId,
    token,
    name: over.name ?? boxId,
    registeredAt: new Date().toISOString(),
    ...over,
  };
}

function runStoreConformance(name: string, factory: () => Store): void {
  describe(`Store conformance: ${name}`, () => {
    describe('boxes', () => {
      it('registers, gets, lists, and counts boxes', async () => {
        const store = factory();
        expect(await store.countBoxes()).toBe(0);
        await store.registerBox(makeBox('b1', 'tok-1'));
        await store.registerBox(makeBox('b2', 'tok-2'));
        expect(await store.countBoxes()).toBe(2);
        expect((await store.getBox('b1'))?.token).toBe('tok-1');
        expect(await store.getBox('missing')).toBeUndefined();
        const ids = (await store.listBoxes()).map((b) => b.boxId).sort();
        expect(ids).toEqual(['b1', 'b2']);
      });

      it('authenticates by token, rejecting empty/unknown tokens', async () => {
        const store = factory();
        await store.registerBox(makeBox('b1', 'secret'));
        expect((await store.authenticateBox('secret'))?.boxId).toBe('b1');
        expect(await store.authenticateBox('')).toBeNull();
        expect(await store.authenticateBox('nope')).toBeNull();
      });

      it('re-registering the same id overwrites', async () => {
        const store = factory();
        await store.registerBox(makeBox('b1', 'tok-1', { name: 'first' }));
        await store.registerBox(makeBox('b1', 'tok-1b', { name: 'second' }));
        expect(await store.countBoxes()).toBe(1);
        expect((await store.getBox('b1'))?.name).toBe('second');
        expect((await store.authenticateBox('tok-1b'))?.boxId).toBe('b1');
      });

      it('forgets boxes idempotently', async () => {
        const store = factory();
        await store.registerBox(makeBox('b1', 'tok-1'));
        expect(await store.forgetBox('b1')).toBe(true);
        expect(await store.forgetBox('b1')).toBe(false);
        expect(await store.getBox('b1')).toBeUndefined();
      });
    });

    describe('events', () => {
      it('appends with monotonic ids + receivedAt, filters by since/box', async () => {
        const store = factory();
        expect(await store.countEvents()).toBe(0);
        const e1 = await store.appendEvent({ boxId: 'b1', type: 'a' });
        const e2 = await store.appendEvent({ boxId: 'b2', type: 'b' });
        const e3 = await store.appendEvent({ boxId: 'b1', type: 'c' });
        expect(e2.id).toBeGreaterThan(e1.id);
        expect(e3.id).toBeGreaterThan(e2.id);
        expect(typeof e1.receivedAt).toBe('string');
        expect(await store.countEvents()).toBe(3);

        const sinceE1 = await store.listEvents(e1.id);
        expect(sinceE1.map((e) => e.id)).toEqual([e2.id, e3.id]);

        const b1Only = await store.listEvents(0, 'b1');
        expect(b1Only.map((e) => e.type)).toEqual(['a', 'c']);
      });
    });

    describe('status', () => {
      it('sets, gets, and deletes the latest snapshot per box', async () => {
        const store = factory();
        expect(await store.getStatus('b1')).toBeUndefined();
        await store.setStatus('b1', 'box-one', 1, { schema: 1, boxId: 'b1', phase: 'ready' });
        expect(await store.getStatus('b1')).toMatchObject({ phase: 'ready' });
        await store.setStatus('b1', 'box-one', 1, { schema: 1, boxId: 'b1', phase: 'busy' });
        expect(await store.getStatus('b1')).toMatchObject({ phase: 'busy' });
        await store.deleteStatus('b1');
        expect(await store.getStatus('b1')).toBeUndefined();
      });
    });
  });
}

runStoreConformance('MemoryStore', () => new MemoryStore());
