import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

// The events helper imports `ensureRelay` and uses global `fetch`. Stub both
// before importing the module so the test never hits the network.
vi.mock('@agentbox/sandbox-docker', () => ({
  ensureRelay: vi.fn().mockResolvedValue({ hostUrl: 'http://127.0.0.1:9999', url: '', port: 9999 }),
}));

// Module under test loaded AFTER mocks so the stub is wired.
const eventsModulePromise = import('../src/lib/wait/events.js');

interface RelayEvent {
  id: number;
  boxId: string;
  type: string;
  receivedAt: string;
  payload?: unknown;
}

/**
 * Pluggable fetch stub: each call drains the next pre-staged batch and
 * applies the `since=` filter exactly like the real relay endpoint.
 */
function stubFetch(batches: RelayEvent[][]): { fetchMock: ReturnType<typeof vi.fn>; callCount: () => number } {
  let i = 0;
  const fetchMock = vi.fn(async (url: URL | string) => {
    const u = typeof url === 'string' ? new URL(url) : url;
    const since = Number.parseInt(u.searchParams.get('since') ?? '0', 10);
    const batch = batches[i] ?? [];
    if (i < batches.length) i += 1;
    const filtered = batch.filter((e) => e.id > since);
    return {
      ok: true,
      status: 200,
      async json(): Promise<{ events: RelayEvent[] }> {
        return { events: filtered };
      },
    } as Response;
  });
  return { fetchMock, callCount: () => i };
}

describe('waitForEvent (race-handling)', () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.useRealTimers();
  });

  it('matches the latest buffered event on the first sweep (no cursor passed)', async () => {
    // Race scenario the bugbot finding describes: a relevant `box-status`
    // event was broadcast just before the wait-for call. Without the fix
    // we'd capture its id as the head cursor and never evaluate it.
    const ev: RelayEvent = {
      id: 42,
      boxId: 'b1',
      type: 'box-status',
      receivedAt: '2026-05-27T00:00:00.000Z',
      payload: { match: true },
    };
    const { fetchMock } = stubFetch([[ev]]);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { waitForEvent } = await eventsModulePromise;
    const result = await waitForEvent<string>(
      (e) => ((e.payload as { match?: boolean }).match ? 'HIT' : undefined),
      { boxId: 'b1', timeoutMs: 5000 },
    );
    expect(result).toBe('HIT');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not match historical events older than the head on the first sweep', async () => {
    // Two historical events; only #1 (older) would match if we replayed
    // the buffer. Correct behavior: skip older entries, only evaluate the
    // head (#2, no match) and start long-polling.
    const stale: RelayEvent = {
      id: 5,
      boxId: 'b1',
      type: 'box-status',
      receivedAt: '2026-05-27T00:00:00.000Z',
      payload: { match: true },
    };
    const head: RelayEvent = {
      id: 6,
      boxId: 'b1',
      type: 'box-status',
      receivedAt: '2026-05-27T00:00:01.000Z',
      payload: { match: false },
    };
    const future: RelayEvent = {
      id: 7,
      boxId: 'b1',
      type: 'box-status',
      receivedAt: '2026-05-27T00:00:02.000Z',
      payload: { match: true },
    };
    const { fetchMock } = stubFetch([[stale, head], [future], [future]]);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { waitForEvent } = await eventsModulePromise;
    const promise = waitForEvent<number>(
      (e) => ((e.payload as { match?: boolean }).match ? e.id : undefined),
      { boxId: 'b1', timeoutMs: 5000 },
    );
    // Advance the internal poll loop so the second fetch fires.
    await vi.advanceTimersByTimeAsync(600);
    const result = await promise;

    // Must be 7 (the future event), NOT 5 (the stale historical match).
    expect(result).toBe(7);
  });

  it('throws WaitTimeoutError when no matching event arrives in time', async () => {
    const head: RelayEvent = {
      id: 1,
      boxId: 'b1',
      type: 'box-status',
      receivedAt: '2026-05-27T00:00:00.000Z',
      payload: { match: false },
    };
    // Return the same non-matching event forever.
    const { fetchMock } = stubFetch(Array.from({ length: 50 }, () => [head]));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { waitForEvent, WaitTimeoutError } = await eventsModulePromise;
    const promise = waitForEvent(
      (e) => ((e.payload as { match?: boolean }).match ? 'HIT' : undefined),
      { boxId: 'b1', timeoutMs: 1500 },
    );
    // Attach a catch handler *before* advancing timers so the rejection isn't
    // observed as unhandled when vi.advanceTimersByTimeAsync flushes it.
    const rejected = expect(promise).rejects.toBeInstanceOf(WaitTimeoutError);
    await vi.advanceTimersByTimeAsync(2000);
    await rejected;
  });
});
