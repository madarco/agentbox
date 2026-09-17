import { describe, expect, it, vi } from 'vitest';
import type { AgentStatusEntry } from '@agentbox/ctl';
import {
  classifyHubFailure,
  runAgentWait,
  type AgentWaitResult,
  type WaitNotice,
  type WaitTarget,
} from '../src/lib/wait/agent-wait.js';

/**
 * The wait loop's contract, driven by a fake clock so a 50-minute wait costs
 * nothing. The cases that matter are the failure ones: a hub that blips must
 * NOT end a wait, and a wait that ended because nobody answered must not be
 * reported as "the agent never got there".
 */

const WORKING: AgentStatusEntry = {
  state: 'working',
  updatedAt: '2026-01-01T00:00:00.000Z',
  sessionRunning: true,
};
const IDLE: AgentStatusEntry = {
  state: 'idle',
  updatedAt: '2026-01-01T00:00:01.000Z',
  sessionRunning: true,
};

function target(name: string): WaitTarget<{ name: string }> {
  return { id: name, name, box: { name } };
}

/** A clock that advances only when the loop sleeps — so the test never waits. */
function fakeClock(): { now: () => number; sleep: (ms: number) => Promise<void> } {
  let t = 0;
  return {
    now: () => t,
    sleep: (ms: number) => {
      t += Math.max(ms, 1);
      return Promise.resolve();
    },
  };
}

function run<B>(args: Parameters<typeof runAgentWait<B>>[0]): Promise<AgentWaitResult<B>> {
  const clock = fakeClock();
  return runAgentWait<B>({ ...clock, random: () => 0.5, ...args });
}

describe('classifyHubFailure', () => {
  it('treats a bare network failure as transient', () => {
    expect(classifyHubFailure(new TypeError('fetch failed'))).toBe('transient');
  });

  it('reads the hub envelope codes', () => {
    expect(classifyHubFailure({ code: 'not_found', status: 404 })).toBe('not-found');
    expect(classifyHubFailure({ code: 'unauthorized', status: 401 })).toBe('unauthorized');
    expect(classifyHubFailure({ code: 'internal', status: 503 })).toBe('transient');
  });

  it('treats a 403 with no code as a credential problem', () => {
    expect(classifyHubFailure({ status: 403 })).toBe('unauthorized');
  });
});

describe('runAgentWait', () => {
  it('returns the matched entry', async () => {
    const result = await run({
      targets: [target('a')],
      state: 'idle',
      timeoutMs: 60_000,
      read: vi.fn().mockResolvedValueOnce(WORKING).mockResolvedValue(IDLE),
    });
    expect(result.kind).toBe('matched');
    if (result.kind === 'matched') expect(result.entry).toBe(IDLE);
  });

  it('survives a window of transport failures and still matches', async () => {
    let call = 0;
    const result = await run({
      targets: [target('a')],
      state: 'idle',
      timeoutMs: 600_000,
      read: () => {
        call += 1;
        // A hub restart: a handful of `fetch failed`, then the state we wanted.
        if (call > 1 && call < 8) return Promise.reject(new TypeError('fetch failed'));
        return Promise.resolve(call < 8 ? WORKING : IDLE);
      },
    });
    expect(result.kind).toBe('matched');
  });

  it('reports unreachable — not timeout — when the hub never answers', async () => {
    const result = await run({
      targets: [target('a')],
      state: 'idle',
      timeoutMs: 5_000,
      read: () => Promise.reject(new TypeError('fetch failed')),
    });
    expect(result.kind).toBe('unreachable');
    if (result.kind === 'unreachable') expect(result.lastError).toBe('fetch failed');
  });

  it('reports timeout when the hub answered but the state never matched', async () => {
    const result = await run({
      targets: [target('a')],
      state: 'idle',
      timeoutMs: 5_000,
      read: () => Promise.resolve(WORKING),
    });
    expect(result.kind).toBe('timeout');
  });

  it('notices going away and coming back exactly once each', async () => {
    const notices: WaitNotice<{ name: string }>[] = [];
    let call = 0;
    await run({
      targets: [target('a')],
      state: 'idle',
      timeoutMs: 600_000,
      read: () => {
        call += 1;
        if (call > 1 && call < 6) return Promise.reject(new TypeError('fetch failed'));
        return Promise.resolve(call < 6 ? WORKING : IDLE);
      },
      onNotice: (n) => notices.push(n),
    });
    expect(notices.map((n) => n.kind)).toEqual(['unreachable', 'recovered']);
  });

  it('gives up when the re-resolve says the plane needs a credential we lack', async () => {
    const onStale = vi.fn().mockResolvedValue('unauthorized');
    const result = await run({
      targets: [target('a')],
      state: 'idle',
      timeoutMs: 600_000,
      read: () => Promise.reject(new TypeError('fetch failed')),
      onStale,
    });
    expect(onStale).toHaveBeenCalledTimes(1);
    expect(result.kind).toBe('fatal');
    if (result.kind === 'fatal') expect(result.reason).toBe('unauthorized');
  });

  it('keeps waiting when the re-resolve simply could not bring a hub up', async () => {
    // A hub that can't be restarted right now is the exact case the caller
    // asked us to sit through — it ends as `unreachable` at the deadline, not
    // as a fatal partway through.
    const onStale = vi.fn().mockResolvedValue('unreachable');
    const result = await run({
      targets: [target('a')],
      state: 'idle',
      timeoutMs: 60_000,
      read: () => Promise.reject(new TypeError('fetch failed')),
      onStale,
    });
    expect(result.kind).toBe('unreachable');
    expect(onStale.mock.calls.length).toBeGreaterThan(1);
  });

  it('is fatal on a box the hub never knew', async () => {
    const result = await run({
      targets: [target('gone')],
      state: 'idle',
      timeoutMs: 600_000,
      read: () => Promise.reject({ code: 'not_found', status: 404 }),
    });
    expect(result.kind).toBe('fatal');
    if (result.kind === 'fatal') expect(result.reason).toBe('not-found');
  });

  it('rides out a 404 from a box that HAD answered, then believes it', async () => {
    let call = 0;
    const result = await run({
      targets: [target('a')],
      state: 'idle',
      timeoutMs: 600_000,
      read: () => {
        call += 1;
        if (call === 1) return Promise.resolve(WORKING);
        if (call === 2) return Promise.reject({ code: 'not_found', status: 404 });
        if (call === 3) return Promise.resolve(WORKING); // registry rehydrated
        return Promise.reject({ code: 'not_found', status: 404 }); // actually destroyed
      },
    });
    expect(call).toBeGreaterThan(4); // the first 404 did NOT end the wait
    expect(result.kind).toBe('fatal');
    if (result.kind === 'fatal') expect(result.reason).toBe('not-found');
  });

  it('is fatal on a credential the hub rejects', async () => {
    const result = await run({
      targets: [target('a')],
      state: 'idle',
      timeoutMs: 600_000,
      read: () => Promise.reject({ code: 'unauthorized', status: 401 }),
    });
    expect(result.kind).toBe('fatal');
    if (result.kind === 'fatal') expect(result.reason).toBe('unauthorized');
  });

  it('races several boxes and returns the first to match', async () => {
    const result = await run({
      targets: [target('a'), target('b')],
      state: 'idle',
      timeoutMs: 600_000,
      read: (t) => Promise.resolve(t.name === 'b' ? IDLE : WORKING),
    });
    expect(result.kind).toBe('matched');
    if (result.kind === 'matched') expect(result.target.name).toBe('b');
  });

  it('keeps waiting on the other boxes when one hub is unreachable', async () => {
    let calls = 0;
    const result = await run({
      targets: [target('down'), target('up')],
      state: 'idle',
      timeoutMs: 600_000,
      read: (t) => {
        if (t.name === 'down') return Promise.reject(new TypeError('fetch failed'));
        calls += 1;
        return Promise.resolve(calls < 4 ? WORKING : IDLE);
      },
    });
    expect(result.kind).toBe('matched');
    if (result.kind === 'matched') expect(result.target.name).toBe('up');
  });
});

/**
 * Bugbot #390: `wait-for` used to treat a hub it could not resolve AT THE START
 * as terminal — instant exit 7, every other target dropped, no `--json`
 * envelope — even though exit 7 is documented as "gone for the whole window".
 * The command now enters the loop with no source for that target, which is the
 * shape these two assert: a read that throws because there is no client yet is
 * an ordinary transient failure, and the wait survives it.
 */
describe('a hub that was already down when the wait started', () => {
  it('rides out a missing client and matches once one appears', async () => {
    let client: string | null = null;
    const result = await run<{ name: string }>({
      targets: [target('a')],
      state: 'idle',
      timeoutMs: 60_000,
      read: () => {
        // Exactly what `sourceFor` throws before `onStale` resolves one.
        if (!client) throw new Error('no hub reachable for this box yet');
        return Promise.resolve(IDLE);
      },
      onStale: () => {
        client = 'hub';
        return Promise.resolve('ok');
      },
    });
    expect(result.kind).toBe('matched');
  });

  it('reports unreachable — not timeout — when the hub never comes back', async () => {
    const result = await run<{ name: string }>({
      targets: [target('a')],
      state: 'idle',
      timeoutMs: 30_000,
      read: () => Promise.reject(new Error('no hub reachable for this box yet')),
      onStale: () => Promise.resolve('unreachable'),
    });
    expect(result.kind).toBe('unreachable');
  });

  it("one target's dead hub does not stop another target from matching", async () => {
    const result = await run<{ name: string }>({
      targets: [target('down'), target('up')],
      state: 'idle',
      timeoutMs: 60_000,
      read: (t) => {
        if (t.name === 'down') throw new Error('no hub reachable for this box yet');
        return Promise.resolve(IDLE);
      },
      onStale: () => Promise.resolve('unreachable'),
    });
    expect(result.kind).toBe('matched');
    if (result.kind === 'matched') expect(result.target.name).toBe('up');
  });
});
