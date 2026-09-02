import { afterEach, describe, expect, it, vi } from 'vitest';

const postRpcAwait = vi.fn();
vi.mock('../src/relay-rpc.js', () => ({ postRpcAwait }));

const { fetchWatchList } = await import('../src/agent-registry.js');
const { WATCHED_CREDENTIALS } = await import('../src/credentials-watcher.js');
const { BAKED_AGENT_SESSIONS } = await import('../src/status-reporter.js');

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
      sessions: BAKED_AGENT_SESSIONS,
      // Nothing is baked for either: a unit or a render descriptor exists only
      // for an agent this ctl may never have heard of, so the fallback is
      // "none" rather than a stale guess.
      units: [],
      renders: [],
      source: 'timeout',
    });
  });

  it('returns the host list when the host answers in time', async () => {
    postRpcAwait.mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({
        schema: 1,
        agents: [
          {
            id: 'codex',
            sessionName: 'codex',
            activitySource: ['scraper'],
            watch: [{ path: '/tmp/c', sync: 'fanout', shape: 'nonempty-json' }],
          },
        ],
      }),
      stderr: '',
    });
    await expect(fetchWatchList()).resolves.toEqual({
      files: [{ agent: 'codex', path: '/tmp/c', shape: 'nonempty-json' }],
      sessions: [{ agent: 'codex', sessionName: 'codex' }],
      // A schema-1 payload names no surface, so every agent in it is a TUI and
      // contributes neither a unit nor a render descriptor.
      units: [],
      renders: [],
      source: 'host',
    });
  });

  it('probes a session name this binary was never baked with', async () => {
    // The whole point of pulling the list: ctl is baked into the image, so an
    // agent added after the bake has no entry in BAKED_AGENT_SESSIONS and would
    // otherwise never be probed for activity at all.
    postRpcAwait.mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({
        schema: 1,
        agents: [
          {
            id: 'openclaw',
            sessionName: 'openclaw',
            activitySource: ['hooks'],
            watch: [{ path: '/tmp/o', sync: 'fanout', shape: 'nonempty-json' }],
          },
        ],
      }),
      stderr: '',
    });
    const got = await fetchWatchList();
    expect(got.sessions).toEqual([{ agent: 'openclaw', sessionName: 'openclaw' }]);
  });

  it('does not probe an agent that reports no activity at all', async () => {
    // An agent with no hooks, no plugin and no scraper would only ever add a
    // permanently-`unknown` entry to every snapshot.
    postRpcAwait.mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({
        schema: 1,
        agents: [
          {
            id: 'quiet',
            sessionName: 'quiet',
            activitySource: [],
            watch: [{ path: '/tmp/q', sync: 'fanout', shape: 'nonempty-json' }],
          },
        ],
      }),
      stderr: '',
    });
    // No usable session rows at all -> keep the baked probes rather than going
    // silent, which is what a host predating `sessionName` also looks like.
    expect((await fetchWatchList()).sessions).toEqual(BAKED_AGENT_SESSIONS);
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
