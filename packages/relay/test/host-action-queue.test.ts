import { describe, expect, it } from 'vitest';
import { HostActionQueue } from '../src/host-action-queue.js';

describe('HostActionQueue', () => {
  it('enqueue returns a Promise that resolves on matching resolve()', async () => {
    const q = new HostActionQueue();
    const p = q.enqueue('box1', 'git.push', { remote: 'origin' });
    expect(q.size()).toBe(1);
    const [action] = q.drain();
    expect(action).toBeDefined();
    expect(action!.boxId).toBe('box1');
    expect(action!.method).toBe('git.push');
    const ok = q.resolve(action!.id, { exitCode: 0, stdout: 'ok', stderr: '' });
    expect(ok).toBe(true);
    await expect(p).resolves.toEqual({ exitCode: 0, stdout: 'ok', stderr: '' });
    expect(q.size()).toBe(0);
  });

  it('drain marks actions as delivered (no re-delivery)', async () => {
    const q = new HostActionQueue();
    void q.enqueue('box1', 'git.fetch', {});
    expect(q.drain()).toHaveLength(1);
    expect(q.drain()).toHaveLength(0);
  });

  it('resolve is idempotent — second resolve on the same id returns false', () => {
    const q = new HostActionQueue();
    void q.enqueue('box1', 'cp.toHost', {});
    const [a] = q.drain();
    q.resolve(a!.id, { exitCode: 0, stdout: '', stderr: '' });
    expect(q.resolve(a!.id, { exitCode: 1, stdout: '', stderr: '' })).toBe(false);
  });

  it('resolve on unknown id returns false (best-effort idempotency)', () => {
    const q = new HostActionQueue();
    expect(q.resolve('nope', { exitCode: 0, stdout: '', stderr: '' })).toBe(false);
  });

  it('multiple concurrent enqueues each settle independently', async () => {
    const q = new HostActionQueue();
    const p1 = q.enqueue('b1', 'm1', {});
    const p2 = q.enqueue('b1', 'm2', {});
    const drained = q.drain();
    expect(drained).toHaveLength(2);
    q.resolve(drained[0]!.id, { exitCode: 0, stdout: 'one', stderr: '' });
    q.resolve(drained[1]!.id, { exitCode: 7, stdout: '', stderr: 'two' });
    await expect(p1).resolves.toEqual({ exitCode: 0, stdout: 'one', stderr: '' });
    await expect(p2).resolves.toEqual({ exitCode: 7, stdout: '', stderr: 'two' });
  });
});
