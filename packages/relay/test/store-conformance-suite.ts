import { beforeEach, describe, expect, it } from 'vitest';
import type { Store } from '../src/store/store.js';
import type { BoxRegistration } from '../src/types.js';

/**
 * Behavioral conformance suite for the {@link Store} seam. Every backend
 * (MemoryStore, PostgresStore, RemoteStore) runs the SAME assertions so they
 * stay drop-in interchangeable. `setup` returns a fresh-state store before each
 * test (a new MemoryStore, or a truncated PostgresStore). Pure — no docker,
 * no network — unless the injected store reaches one (the Postgres run is
 * gated behind an opt-in env var).
 */
export function makeBox(
  boxId: string,
  token: string,
  over: Partial<BoxRegistration> = {},
): BoxRegistration {
  return {
    boxId,
    token,
    name: over.name ?? boxId,
    registeredAt: new Date().toISOString(),
    ...over,
  };
}

export function runStoreConformance(name: string, setup: () => Promise<Store>): void {
  describe(`Store conformance: ${name}`, () => {
    let store: Store;
    beforeEach(async () => {
      store = await setup();
    });

    describe('boxes', () => {
      it('registers, gets, lists, and counts boxes', async () => {
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
        await store.registerBox(makeBox('b1', 'secret'));
        expect((await store.authenticateBox('secret'))?.boxId).toBe('b1');
        expect(await store.authenticateBox('')).toBeNull();
        expect(await store.authenticateBox('nope')).toBeNull();
      });

      it('re-registering the same id overwrites', async () => {
        await store.registerBox(makeBox('b1', 'tok-1', { name: 'first' }));
        await store.registerBox(makeBox('b1', 'tok-1b', { name: 'second' }));
        expect(await store.countBoxes()).toBe(1);
        expect((await store.getBox('b1'))?.name).toBe('second');
        expect((await store.authenticateBox('tok-1b'))?.boxId).toBe('b1');
        expect(await store.authenticateBox('tok-1')).toBeNull();
      });

      it('forgets boxes idempotently', async () => {
        await store.registerBox(makeBox('b1', 'tok-1'));
        expect(await store.forgetBox('b1')).toBe(true);
        expect(await store.forgetBox('b1')).toBe(false);
        expect(await store.getBox('b1')).toBeUndefined();
      });

      it('round-trips optional registration fields', async () => {
        await store.registerBox(
          makeBox('b1', 'tok-1', {
            kind: 'cloud',
            backend: 'daytona',
            projectIndex: 3,
            worktrees: [{ containerPath: '/workspace', hostMainRepo: '/repo', branch: 'agentbox/b1' }],
            autoApproveHostActions: true,
          }),
        );
        const got = await store.getBox('b1');
        expect(got?.kind).toBe('cloud');
        expect(got?.backend).toBe('daytona');
        expect(got?.projectIndex).toBe(3);
        expect(got?.worktrees?.[0]?.branch).toBe('agentbox/b1');
        expect(got?.autoApproveHostActions).toBe(true);
      });
    });

    describe('events', () => {
      it('appends with monotonic ids + receivedAt, filters by since/box', async () => {
        expect(await store.countEvents()).toBe(0);
        const e1 = await store.appendEvent({ boxId: 'b1', type: 'a' });
        const e2 = await store.appendEvent({ boxId: 'b2', type: 'b' });
        const e3 = await store.appendEvent({ boxId: 'b1', type: 'c', payload: { n: 1 } });
        expect(e2.id).toBeGreaterThan(e1.id);
        expect(e3.id).toBeGreaterThan(e2.id);
        expect(typeof e1.receivedAt).toBe('string');
        expect(await store.countEvents()).toBe(3);

        const sinceE1 = await store.listEvents(e1.id);
        expect(sinceE1.map((e) => e.id)).toEqual([e2.id, e3.id]);

        const b1Only = await store.listEvents(0, 'b1');
        expect(b1Only.map((e) => e.type)).toEqual(['a', 'c']);
        expect(b1Only[1]?.payload).toEqual({ n: 1 });
      });
    });

    describe('status', () => {
      it('sets, gets, and deletes the latest snapshot per box', async () => {
        expect(await store.getStatus('b1')).toBeUndefined();
        await store.setStatus('b1', 'box-one', 1, { schema: 1, boxId: 'b1', phase: 'ready' });
        expect(await store.getStatus('b1')).toMatchObject({ phase: 'ready' });
        await store.setStatus('b1', 'box-one', 1, { schema: 1, boxId: 'b1', phase: 'busy' });
        expect(await store.getStatus('b1')).toMatchObject({ phase: 'busy' });
        await store.deleteStatus('b1');
        expect(await store.getStatus('b1')).toBeUndefined();
      });
    });

    describe('prompt mailbox', () => {
      const baseRow = (id: string) => ({
        id,
        boxId: 'b1',
        ev: { id, kind: 'confirm' as const, message: 'go?', context: { command: 'git push' } },
        method: 'git.lease-token',
        params: { path: '/workspace' },
        status: 'pending' as const,
        createdAt: new Date().toISOString(),
      });

      it('creates, lists pending, answers (idempotent), and caches a result', async () => {
        expect(await store.getPrompt('p1')).toBeNull();
        await store.createPrompt(baseRow('p1'));
        await store.createPrompt(baseRow('p2'));

        const pending = await store.listPendingPrompts('b1');
        expect(pending.map((p) => p.id).sort()).toEqual(['p1', 'p2']);
        expect((await store.getPrompt('p1'))?.ev.context?.command).toBe('git push');
        expect((await store.getPrompt('p1'))?.params).toEqual({ path: '/workspace' });

        // First answer transitions; a second is a no-op (idempotent).
        expect(await store.answerPrompt('p1', 'y')).toBe(true);
        expect(await store.answerPrompt('p1', 'n')).toBe(false);
        const p1 = await store.getPrompt('p1');
        expect(p1?.status).toBe('answered');
        expect(p1?.answer).toBe('y');

        // Answered prompts drop out of the pending list.
        expect((await store.listPendingPrompts('b1')).map((p) => p.id)).toEqual(['p2']);

        // Result caching round-trips.
        await store.setPromptResult('p1', { exitCode: 0, stdout: 'ok', stderr: '' });
        expect((await store.getPrompt('p1'))?.result).toEqual({ exitCode: 0, stdout: 'ok', stderr: '' });
      });

      it('records a cancelled denial', async () => {
        await store.createPrompt(baseRow('p3'));
        expect(await store.answerPrompt('p3', 'n', true)).toBe(true);
        const p3 = await store.getPrompt('p3');
        expect(p3?.answer).toBe('n');
        expect(p3?.cancelled).toBe(true);
      });
    });

    describe('create-job queue', () => {
      const job = (id: string) => ({
        id,
        status: 'queued' as const,
        request: { repoUrl: 'https://github.com/acme/widgets.git', provider: 'e2b' },
        createdAt: new Date(Date.now() + Number(id.slice(1))).toISOString(),
      });

      it('enqueues, claims atomically (oldest first, once), and completes', async () => {
        if (!store.enqueueCreateJob || !store.claimNextCreateJob || !store.completeCreateJob || !store.getCreateJob) {
          return; // store without create-job support (e.g. RemoteStore)
        }
        await store.enqueueCreateJob(job('j1'));
        await store.enqueueCreateJob(job('j2'));

        const first = await store.claimNextCreateJob('w1');
        expect(first?.id).toBe('j1');
        expect(first?.status).toBe('running');
        expect(first?.claimedBy).toBe('w1');

        // The same job is not handed to a second claimer.
        const second = await store.claimNextCreateJob('w2');
        expect(second?.id).toBe('j2');

        // Queue now empty.
        expect(await store.claimNextCreateJob('w3')).toBeNull();

        await store.completeCreateJob('j1', 'done', { boxId: 'box-123' });
        const done = await store.getCreateJob('j1');
        expect(done?.status).toBe('done');
        expect(done?.result?.boxId).toBe('box-123');

        await store.completeCreateJob('j2', 'failed', { error: 'boom' });
        expect((await store.getCreateJob('j2'))?.status).toBe('failed');
      });
    });
  });
}
