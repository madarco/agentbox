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

  it('re-offers work to a RESTARTED poller, so a relay restart mid-copy cannot hang a box', async () => {
    // The predecessor took the action and died without posting a result. The
    // went-away sweep cannot see it — the replacement keeps this machine
    // "reachable" — so the queue has to notice the new identity itself.
    let now = 1_000;
    const q = new HostReachQueue({ graceMs: 5_000, reachTimeoutMs: 200, now: () => now });
    const pending = q.request('box1', 'cp.fromHost', {});
    const first = await q.poll(50, 'poller-a');
    expect(first).toHaveLength(1);
    // Same poller asking again gets nothing: it may be sitting on a confirm.
    expect(await q.poll(10, 'poller-a')).toHaveLength(0);
    // 'poller-a' dies; only after its heartbeat lapses is the work re-offered.
    now += 300;
    const second = await q.poll(50, 'poller-b');
    expect(second.map((a) => a.id)).toEqual(first.map((a) => a.id));
    q.resolve(second[0]!.id, { exitCode: 0, stdout: 'done', stderr: '' });
    await expect(pending).resolves.toMatchObject({ kind: 'result' });
  });

  it('does not let a second machine steal a copy whose owner is still polling', async () => {
    // Two machines can hold the same admin token, and an old process can still be
    // finishing after a restart. Handing in-flight work to whoever asks next lets
    // the wrong one answer "I don't know that box" and settle the request, so the
    // real machine's success arrives with nowhere to go.
    let now = 1_000;
    const q = new HostReachQueue({ graceMs: 5_000, reachTimeoutMs: 500, now: () => now });
    const pending = q.request('box1', 'cp.fromHost', {});
    const mine = await q.poll(50, 'poller-a');
    expect(mine).toHaveLength(1);
    // 'poller-a' keeps heartbeating while its user thinks about the confirm.
    now += 100;
    await q.poll(10, 'poller-a');
    now += 100;
    expect(await q.poll(10, 'poller-b')).toHaveLength(0);
    // A result from the interloper is refused; the owner's still counts.
    expect(
      q.resolve(mine[0]!.id, { exitCode: 69, stdout: '', stderr: 'not mine' }, 'poller-b'),
    ).toBe(false);
    expect(q.resolve(mine[0]!.id, { exitCode: 0, stdout: 'ok', stderr: '' }, 'poller-a')).toBe(
      true,
    );
    await expect(pending).resolves.toMatchObject({ kind: 'result', result: { exitCode: 0 } });
  });

  it('returns a declined action to the pool instead of settling it', async () => {
    // A machine that does not hold the box must not answer for it: with two
    // machines on one hub, its "unknown box" would settle someone else's copy.
    const q = new HostReachQueue({ graceMs: 5_000 });
    const pending = q.request('box1', 'cp.fromHost', {});
    const [taken] = await q.poll(50, 'poller-a');
    expect(q.decline(taken!.id, 'poller-a')).toBe(true);
    // Still parked, and offered to the next machine that asks.
    const [again] = await q.poll(50, 'poller-b');
    expect(again?.id).toBe(taken!.id);
    q.resolve(again!.id, { exitCode: 0, stdout: 'done', stderr: '' }, 'poller-b');
    await expect(pending).resolves.toMatchObject({ kind: 'result' });
  });

  it('never re-offers a declined action to the machine that refused it', async () => {
    // Otherwise the only machine on the hub takes it, declines, takes it again —
    // a tight loop that also starves the fallback, since the went-away sweep
    // only inspects delivered work.
    const q = new HostReachQueue({ graceMs: 5_000 });
    void q.request('box1', 'cp.fromHost', {});
    const [taken] = await q.poll(50, 'poller-a');
    q.decline(taken!.id, 'poller-a');
    expect(await q.poll(10, 'poller-a')).toHaveLength(0);
    expect(await q.poll(10, 'poller-a')).toHaveLength(0);
  });

  it('settles a declined action nobody else claims, so the box falls back', async () => {
    // Delivery cleared the grace timer; a decline has to re-arm it or the box
    // waits forever on a copy no machine will ever make.
    const q = new HostReachQueue({ graceMs: 60 });
    const pending = q.request('box1', 'cp.fromHost', {});
    const [taken] = await q.poll(50, 'poller-a');
    q.decline(taken!.id, 'poller-a');
    await expect(pending).resolves.toEqual({ kind: 'unreachable', reason: 'never-connected' });
  });

  it('ignores a decline from a machine that no longer owns the action', async () => {
    const q = new HostReachQueue({ graceMs: 5_000 });
    void q.request('box1', 'cp.fromHost', {});
    const [taken] = await q.poll(50, 'poller-a');
    expect(q.decline(taken!.id, 'poller-b')).toBe(false);
  });

  it('settles everything as unreachable on stop, so a hub restart cannot hang a box', async () => {
    const q = new HostReachQueue({ graceMs: 5_000 });
    const pending = q.request('box1', 'cp.fromHost', {});
    await q.poll(10);
    q.stop();
    await expect(pending).resolves.toEqual({ kind: 'unreachable', reason: 'went-away' });
  });
});
