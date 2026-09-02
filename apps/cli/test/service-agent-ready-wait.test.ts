import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { BoxRecord } from '@agentbox/core';
import type { HubApiServiceView } from '../src/control-plane/hub-api-client.js';

/**
 * `waitForService` must mirror the SUPERVISOR'S satisfaction rule, and must fail
 * when it does not get there.
 *
 * Two bugs this pins, both of which reported a launch that had not happened:
 *
 *   1. `running` was accepted for every service. A probed unit enters `running`
 *      the moment its process spawns, BEFORE its http/port probe passes — so
 *      create printed the URL while the endpoint was still refusing. The
 *      supervisor satisfies a probed unit at `ready` and an unprobed one at
 *      `running` (`Supervisor.onServiceState`); this must say the same thing.
 *   2. A ready timeout only warned and returned, so the caller still printed the
 *      outro and exited 0 — an exit code that lies to every script and CI job
 *      reading it.
 */

const getServices = vi.fn();

// `withOwningHub` is the box -> hub seam; stub it to hand the op a client whose
// getServices returns whatever the case under test queued up.
vi.mock('../src/control-plane/with-hub.js', () => ({
  withOwningHub: async (_box: unknown, op: (client: unknown) => Promise<void>) => {
    await op({ getServices });
    return 'ok' as const;
  },
}));
// Pulled in transitively by service-action; none of it runs on this path.
vi.mock('../src/provider/registry.js', () => ({
  providerForBox: vi.fn(),
  providerForCreate: vi.fn(),
}));

const { waitForService } = await import('../src/agents/command/service-action.js');

const box = { id: 'b1', name: 'smokebox' } as BoxRecord;

function view(over: Partial<HubApiServiceView>): HubApiServiceView {
  return {
    name: 'demosvc',
    state: 'running',
    pid: 42,
    restarts: 0,
    lastExitCode: null,
    blockedOn: [],
    command: 'demosvc gateway',
    ...over,
  };
}

/** Queue one services payload per poll. */
function queue(...views: (HubApiServiceView | undefined)[]): void {
  getServices.mockReset();
  for (const v of views) {
    getServices.mockResolvedValueOnce({
      source: 'live',
      services: v ? [v] : [],
      tasks: [],
      ports: [],
    });
  }
  // Any poll past the queue repeats the last answer.
  const last = views[views.length - 1];
  getServices.mockResolvedValue({
    source: 'live',
    services: last ? [last] : [],
    tasks: [],
    ports: [],
  });
}

/**
 * Fake timers throughout: the wait polls on a 2s interval, so a real-clock test
 * of a timeout would sit for the whole window. Advancing past the deadline is
 * the same code path, in milliseconds.
 */
function settle<T>(p: Promise<T>, ms: number): Promise<T> {
  // Attach the handler BEFORE the first await, or the rejection lands while the
  // timer advance is still in flight and vitest reports an unhandled rejection.
  const outcome = p.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  return (async () => {
    await vi.advanceTimersByTimeAsync(ms);
    const r = await outcome;
    if (r.ok) return r.value;
    throw r.error;
  })();
}

describe('waitForService — the supervisor satisfaction rule', () => {
  beforeEach(() => {
    getServices.mockReset();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it('does NOT accept `running` for a probed service: the probe has not passed yet', async () => {
    // The regression: this used to return immediately and print the URL while
    // /healthz was still down. It must keep waiting, then time out.
    queue(view({ state: 'running', probed: true }));
    const p = waitForService(box, 'demosvc', 30, () => {});
    await expect(settle(p, 40_000)).rejects.toThrow(/did not report ready within/);
  });

  it('accepts `ready` for a probed service', async () => {
    queue(view({ state: 'running', probed: true }), view({ state: 'ready', probed: true }));
    const v = await settle(
      waitForService(box, 'demosvc', 30, () => {}),
      4_000,
    );
    expect(v.state).toBe('ready');
  });

  it('accepts `running` for an UNPROBED service — that is where the supervisor satisfies it', async () => {
    queue(view({ state: 'running', probed: false }));
    const v = await settle(
      waitForService(box, 'demosvc', 30, () => {}),
      0,
    );
    expect(v.state).toBe('running');
  });

  it('treats an absent `probed` as unprobed, so an older box still completes', async () => {
    // Additive-field convention: a box whose ctl predates `probed` sends neither
    // half, and the only reading that cannot hang forever is "unprobed".
    queue(view({ state: 'running', probed: undefined }));
    const v = await settle(
      waitForService(box, 'demosvc', 30, () => {}),
      0,
    );
    expect(v.state).toBe('running');
  });
});

describe('waitForService — a timeout is a failure, not a quiet return', () => {
  beforeEach(() => {
    getServices.mockReset();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it('throws when a probed service never leaves `running`, naming the unit and the probe', async () => {
    queue(view({ state: 'running', probed: true }));
    const p = waitForService(box, 'demosvc', 30, () => {});
    const err = await settle(p, 40_000).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    const msg = (err as Error).message;
    expect(msg).toContain('demosvc');
    expect(msg).toContain('last state: running');
    expect(msg).toContain('readiness probe has not passed');
    expect(msg).toContain('agentbox logs');
  });

  it('throws when the supervisor never picked the unit up at all', async () => {
    queue(undefined);
    const p = waitForService(box, 'demosvc', 30, () => {});
    await expect(settle(p, 40_000)).rejects.toThrow(/the supervisor never picked it up/);
  });

  it('still throws immediately on a dead state rather than waiting out the timeout', async () => {
    queue(view({ state: 'crashed', lastExitCode: 3 }));
    const p = waitForService(box, 'demosvc', 30, () => {});
    await expect(settle(p, 0)).rejects.toThrow(/is crashed \(exit 3\)/);
  });
});
