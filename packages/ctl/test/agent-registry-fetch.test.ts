import { afterEach, describe, expect, it, vi } from 'vitest';

const postRpcAwait = vi.fn();
vi.mock('../src/relay-rpc.js', () => ({ postRpcAwait }));

const { fetchWatchList } = await import('../src/agent-registry.js');
const { WATCHED_CREDENTIALS } = await import('../src/credentials-watcher.js');

/**
 * The failure this guards, found by review on PR #340:
 *
 * On a cloud box the in-sandbox relay parks EVERY rpc on `HostActionQueue`,
 * whose `enqueue` is deliberately timeout-free and whose expiry sweep runs only
 * inside `drain()` — which only runs when the host's `CloudBoxPoller` polls. With
 * the host off (a resumed independent box) the promise never settles at all, and
 * `relay-rpc`'s own 10-minute bound belongs to the 202/poll shape, not this one.
 *
 * So `fetchWatchList` must bound itself. It is also no longer awaited on the
 * daemon's critical path (see daemon-startup-order.test.ts) — belt and braces,
 * since an unbounded pending request still holds a socket and a queue slot for
 * the life of the daemon.
 */
describe('fetchWatchList', () => {
  afterEach(() => {
    vi.useRealTimers();
    postRpcAwait.mockReset();
  });

  it('falls back to the baked list when the host never answers', async () => {
    vi.useFakeTimers();
    // Never settles — a parked action on a box whose host poller is down.
    postRpcAwait.mockReturnValue(new Promise(() => {}));

    const pending = fetchWatchList();
    await vi.advanceTimersByTimeAsync(30_000);

    await expect(pending).resolves.toEqual({
      files: WATCHED_CREDENTIALS,
      source: 'timeout',
    });
  });

  it('returns the host list when the host answers in time', async () => {
    postRpcAwait.mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({
        schema: 1,
        agents: [
          { id: 'codex', watch: [{ path: '/tmp/c', sync: 'fanout', shape: 'nonempty-json' }] },
        ],
      }),
      stderr: '',
    });
    await expect(fetchWatchList()).resolves.toEqual({
      files: [{ agent: 'codex', path: '/tmp/c', shape: 'nonempty-json' }],
      source: 'host',
    });
  });

  it('keeps the baked list when the rpc fails or the payload is junk', async () => {
    postRpcAwait.mockResolvedValue({ exitCode: 126, stdout: '', stderr: 'refused' });
    expect((await fetchWatchList()).source).toBe('baked');

    postRpcAwait.mockResolvedValue({ exitCode: 0, stdout: 'not json', stderr: '' });
    expect((await fetchWatchList()).source).toBe('baked');

    postRpcAwait.mockRejectedValue(new Error('boom'));
    expect((await fetchWatchList()).source).toBe('baked');
  });
});
