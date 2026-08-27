import { describe, expect, it } from 'vitest';
import { HostReachQueue } from '../src/host-reach.js';

/**
 * The queue's whole job is answering "is the user's machine there?" without
 * ever leaving a box hanging, so every test here is about a *settled* outcome:
 * a result, or an explicit unreachable. A test that merely asserts something
 * was queued would pass for the bug this exists to prevent.
 */

const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

describe('HostReachQueue', () => {
  it('resolves with the machine result once it answers', async () => {
    const q = new HostReachQueue({ graceMs: 5_000 });
    const pending = q.request('box1', 'cp.fromHost', { sources: ['/a'], dest: '/b' });
    const [action] = await q.poll(50);
    expect(action?.method).toBe('cp.fromHost');
    expect(q.resolve(action!.id, { exitCode: 0, stdout: 'ok', stderr: '' })).toBe(true);
    await expect(pending).resolves.toEqual({
      kind: 'result',
      result: { exitCode: 0, stdout: 'ok', stderr: '' },
    });
  });

  it('gives up as never-connected when nobody polls within the grace window', async () => {
    const q = new HostReachQueue({ graceMs: 20 });
    await expect(q.request('box1', 'cp.toHost', {})).resolves.toEqual({
      kind: 'unreachable',
      reason: 'never-connected',
    });
  });

  it('waits indefinitely once a machine takes the action (a human may be answering)', async () => {
    const q = new HostReachQueue({ graceMs: 20 });
    const pending = q.request('box1', 'cp.fromHost', {});
    const [action] = await q.poll(50);
    expect(action).toBeDefined();
    // Well past the grace window: delivery must have cancelled it.
    await new Promise((r) => setTimeout(r, 60));
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await flush();
    expect(settled).toBe(false);
    q.resolve(action!.id, { exitCode: 0, stdout: '', stderr: '' });
    await expect(pending).resolves.toMatchObject({ kind: 'result' });
  });

  it('fails a claimed action once the machine that took it stops polling', async () => {
    let now = 1_000;
    const q = new HostReachQueue({
      graceMs: 10_000,
      reachTimeoutMs: 100,
      sweepIntervalMs: 10,
      now: () => now,
    });
    const pending = q.request('box1', 'cp.fromHost', {});
    const [action] = await q.poll(50);
    expect(action).toBeDefined();
    // The laptop slept: no further polls, so the heartbeat window lapses.
    now += 500;
    await expect(pending).resolves.toEqual({ kind: 'unreachable', reason: 'went-away' });
  });

  it('reports reachability from polls alone, so an idle machine still counts as present', async () => {
    let now = 1_000;
    const q = new HostReachQueue({ reachTimeoutMs: 100, now: () => now });
    expect(q.reachable()).toBe(false);
    await q.poll(0);
    expect(q.reachable()).toBe(true);
    now += 101;
    expect(q.reachable()).toBe(false);
  });

  it('hands a newly parked action to a poller already waiting', async () => {
    const q = new HostReachQueue({ graceMs: 5_000 });
    const polling = q.poll(1_000);
    void q.request('box1', 'cp.fromHost', {});
    const actions = await polling;
    expect(actions).toHaveLength(1);
    expect(actions[0]!.boxId).toBe('box1');
  });

  it('never hands the same action to two pollers', async () => {
    const q = new HostReachQueue({ graceMs: 5_000 });
    void q.request('box1', 'cp.fromHost', {});
    const first = await q.poll(10);
    const second = await q.poll(10);
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
  });

  it('settles everything as unreachable on stop, so a hub restart cannot hang a box', async () => {
    const q = new HostReachQueue({ graceMs: 5_000 });
    const pending = q.request('box1', 'cp.fromHost', {});
    await q.poll(10);
    q.stop();
    await expect(pending).resolves.toEqual({ kind: 'unreachable', reason: 'went-away' });
  });
});
