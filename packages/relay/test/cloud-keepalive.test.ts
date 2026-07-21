import { describe, expect, it } from 'vitest';
import {
  selectBoxesToRenew,
  shouldIdlePause,
  startCloudKeepaliveLoop,
  type CloudBoxLookup,
  type KeepaliveScanEntry,
} from '../src/cloud-keepalive.js';
import { BoxRegistry } from '../src/registry.js';
import type { AutopauseConfig } from '../src/autopause.js';
import type { CloudBackend, CloudHandle } from '@agentbox/core';
import type { BoxStatusStore, BoxStatusSnapshot } from '../src/status-store.js';

const NOW = 1_700_000_000_000;
const WINDOW = 5 * 60_000;

function entry(p: Partial<KeepaliveScanEntry> & { boxId: string }): KeepaliveScanEntry {
  return {
    backend: 'vercel',
    agentState: 'active',
    lastActivityMs: NOW,
    ...p,
  };
}

describe('selectBoxesToRenew', () => {
  it('renews an active box, anchoring the target at now + window', () => {
    const out = selectBoxesToRenew([entry({ boxId: 'a', lastActivityMs: NOW })], WINDOW, NOW);
    expect(out).toEqual([
      { boxId: 'a', backend: 'vercel', targetDeadlineEpochMs: NOW + WINDOW },
    ]);
  });

  it('renews an active box even when updatedAt is very stale (now + window, not stale + window)', () => {
    // The in-box status reporter freezes updatedAt during a long single
    // `working` op; the target must still anchor on `now` so the box isn't
    // killed mid-work. (Regression for the high-sev bugbot finding.)
    const e = entry({ boxId: 'a', agentState: 'active', lastActivityMs: NOW - 100 * 60_000 });
    expect(selectBoxesToRenew([e], WINDOW, NOW)).toEqual([
      { boxId: 'a', backend: 'vercel', targetDeadlineEpochMs: NOW + WINDOW },
    ]);
  });

  it('renews an active box even with no activity timestamp at all', () => {
    // Active sessions reported without updatedAt must still be kept alive.
    const e = entry({ boxId: 'a', agentState: 'active', lastActivityMs: null });
    expect(selectBoxesToRenew([e], WINDOW, NOW)).toEqual([
      { boxId: 'a', backend: 'vercel', targetDeadlineEpochMs: NOW + WINDOW },
    ]);
  });

  it('renews an idle box still within the window, anchored at lastActivity + window', () => {
    const e = entry({ boxId: 'a', agentState: 'idle', lastActivityMs: NOW - WINDOW + 1 });
    expect(selectBoxesToRenew([e], WINDOW, NOW)).toEqual([
      { boxId: 'a', backend: 'vercel', targetDeadlineEpochMs: NOW - WINDOW + 1 + WINDOW },
    ]);
  });

  it('skips an idle box past the window (it lapses)', () => {
    const e = entry({ boxId: 'a', agentState: 'idle', lastActivityMs: NOW - WINDOW });
    expect(selectBoxesToRenew([e], WINDOW, NOW)).toEqual([]);
  });

  it('skips an idle box with no activity timestamp', () => {
    const e = entry({ boxId: 'a', agentState: 'idle', lastActivityMs: null });
    expect(selectBoxesToRenew([e], WINDOW, NOW)).toEqual([]);
  });

  it('skips boxes with no agent state', () => {
    expect(selectBoxesToRenew([entry({ boxId: 'b', agentState: null })], WINDOW, NOW)).toEqual([]);
  });

  it('idle target is now-independent (restart-robust)', () => {
    const e = entry({ boxId: 'a', agentState: 'idle', lastActivityMs: NOW - 60_000 });
    const a = selectBoxesToRenew([e], WINDOW, NOW);
    const b = selectBoxesToRenew([e], WINDOW, NOW + 30_000);
    expect(a[0]!.targetDeadlineEpochMs).toBe(b[0]!.targetDeadlineEpochMs);
  });
});

describe('shouldIdlePause', () => {
  // The box's own idle timeout (box.daytonaTimeoutMs), NOT the 5-min renewal window.
  const IDLE = 25 * 60_000;

  it('pauses a box idle for its full configured timeout', () => {
    const e = entry({ boxId: 'a', agentState: 'idle', lastActivityMs: NOW - IDLE });
    expect(shouldIdlePause(e, IDLE, NOW)).toBe(true);
  });

  it('waits for the box timeout, not the shorter renewal window', () => {
    // Past the 5-min renewal window (so no longer renewed) but nowhere near the
    // 25-min idle timeout the user configured: it must coast, not be paused.
    const e = entry({ boxId: 'a', agentState: 'idle', lastActivityMs: NOW - WINDOW - 1 });
    expect(selectBoxesToRenew([e], WINDOW, NOW)).toEqual([]); // renewals have stopped
    expect(shouldIdlePause(e, IDLE, NOW)).toBe(false); // but it is NOT paused yet
  });

  it('never pauses an active box, however stale its timestamp', () => {
    const e = entry({ boxId: 'a', agentState: 'active', lastActivityMs: NOW - 100 * IDLE });
    expect(shouldIdlePause(e, IDLE, NOW)).toBe(false);
  });

  it('never pauses a box with no agent state or no timestamp', () => {
    const noState = entry({ boxId: 'a', agentState: null, lastActivityMs: NOW - 10 * IDLE });
    const noStamp = entry({ boxId: 'b', agentState: 'idle', lastActivityMs: null });
    expect(shouldIdlePause(noState, IDLE, NOW)).toBe(false);
    expect(shouldIdlePause(noStamp, IDLE, NOW)).toBe(false);
  });
});

describe('startCloudKeepaliveLoop', () => {
  function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  }

  function statusFor(snap: Partial<BoxStatusSnapshot>): BoxStatusStore {
    return {
      get: (): BoxStatusSnapshot => ({ schema: 1, boxId: 'b', ...snap }) as BoxStatusSnapshot,
    } as unknown as BoxStatusStore;
  }

  const CFG: AutopauseConfig = { enabled: true, maxRunningBoxes: 5, idleMinutes: 5 };
  // Lookup that seeds the tracked deadline at exactly NOW (createdAt=NOW, timeout=0)
  // so an active box's target (NOW+WINDOW) clears the renew gate.
  const lookupAtNow = async (): Promise<CloudBoxLookup> => ({
    sandboxId: 'sb-123',
    createdAtMs: NOW,
    createTimeoutMs: 0,
  });

  function registerCloud(reg: BoxRegistry, boxId: string, backend = 'vercel'): void {
    reg.register({
      boxId,
      token: 't',
      name: boxId,
      registeredAt: new Date(NOW).toISOString(),
      kind: 'cloud',
      backend,
      createdAt: new Date(NOW).toISOString(),
    });
  }

  it('renews an active cloud box with (target, trackedDeadline)', async () => {
    const registry = new BoxRegistry();
    registerCloud(registry, 'b1');
    const calls: Array<{ id: string; target: number; current: number }> = [];
    const got = deferred<void>();
    const backend: CloudBackend = {
      name: 'vercel',
      renewTimeout: async (h: CloudHandle, target: number, current: number) => {
        calls.push({ id: h.sandboxId, target, current });
        got.resolve();
      },
    } as unknown as CloudBackend;

    const loop = startCloudKeepaliveLoop({
      registry,
      statusStore: statusFor({ claude: { state: 'working', updatedAt: new Date(NOW).toISOString() } }),
      log: () => {},
      intervalMs: 5,
      now: () => NOW,
      loadConfig: async () => CFG,
      resolveBackend: async () => backend,
      lookupBox: lookupAtNow,
    });

    await got.promise;
    await loop.stop();

    expect(calls).toEqual([{ id: 'sb-123', target: NOW + WINDOW, current: NOW }]);
  });

  it('skips docker boxes and backends without renewTimeout', async () => {
    const registry = new BoxRegistry();
    registry.register({
      boxId: 'd1',
      token: 't',
      name: 'd1',
      registeredAt: new Date(NOW).toISOString(),
      kind: 'docker',
      containerName: 'agentbox-d1',
      createdAt: new Date(NOW).toISOString(),
    });
    registerCloud(registry, 'c1', 'daytona');
    let lookups = 0;
    const backend = { name: 'daytona' } as unknown as CloudBackend; // no renewTimeout

    const loop = startCloudKeepaliveLoop({
      registry,
      statusStore: statusFor({ claude: { state: 'working', updatedAt: new Date(NOW).toISOString() } }),
      log: () => {},
      intervalMs: 5,
      now: () => NOW,
      loadConfig: async () => CFG,
      resolveBackend: async () => backend,
      lookupBox: async () => {
        lookups++;
        return { sandboxId: 'sb-x', createdAtMs: NOW, createTimeoutMs: 0 };
      },
    });

    await new Promise((r) => setTimeout(r, 40));
    await loop.stop();
    expect(lookups).toBe(0);
  });

  it('does not advance the tracked deadline when renewTimeout throws (retries later)', async () => {
    const registry = new BoxRegistry();
    registerCloud(registry, 'b1');
    const targets: number[] = [];
    const attempted = deferred<void>();
    const backend: CloudBackend = {
      name: 'vercel',
      renewTimeout: async (_h: CloudHandle, target: number) => {
        targets.push(target);
        attempted.resolve();
        throw new Error('plan cap reached');
      },
    } as unknown as CloudBackend;

    const loop = startCloudKeepaliveLoop({
      registry,
      statusStore: statusFor({ claude: { state: 'working', updatedAt: new Date(NOW).toISOString() } }),
      log: () => {},
      intervalMs: 5,
      now: () => NOW,
      loadConfig: async () => CFG,
      resolveBackend: async () => backend,
      lookupBox: lookupAtNow,
    });

    await attempted.promise;
    // The loop must keep scheduling after a renew failure.
    await new Promise((r) => setTimeout(r, 20));
    await expect(loop.stop()).resolves.toBeUndefined();
    // FAILURE_BACKOFF_MS (5m) > our fixed clock delta, so the box is backed off
    // and not retried every tick — at most one attempt in this window.
    expect(targets.length).toBeGreaterThanOrEqual(1);
    expect(targets.every((t) => t === NOW + WINDOW)).toBe(true);
  });

  it('does nothing when disabled', async () => {
    const registry = new BoxRegistry();
    registerCloud(registry, 'b1');
    let calls = 0;
    const backend: CloudBackend = {
      name: 'vercel',
      renewTimeout: async () => {
        calls++;
      },
    } as unknown as CloudBackend;

    const loop = startCloudKeepaliveLoop({
      registry,
      statusStore: statusFor({ claude: { state: 'working', updatedAt: new Date(NOW).toISOString() } }),
      log: () => {},
      intervalMs: 5,
      now: () => NOW,
      loadConfig: async () => ({ ...CFG, enabled: false }),
      resolveBackend: async () => backend,
      lookupBox: lookupAtNow,
    });

    await new Promise((r) => setTimeout(r, 40));
    await loop.stop();
    expect(calls).toBe(0);
  });

  // An inactivity-model backend (daytona) can't stop its own idle boxes while
  // we poll them, so the loop does it. See `CloudBackend.timeoutModel`.
  function inactivityBackend(onPause: (h: CloudHandle) => void): CloudBackend {
    return {
      name: 'daytona',
      timeoutModel: 'inactivity',
      renewTimeout: async () => {},
      pause: async (h: CloudHandle) => {
        onPause(h);
      },
    } as unknown as CloudBackend;
  }

  /** Box whose own idle timeout is one window (0 would mean "idle timeout disabled"). */
  const lookupIdleWindow = async (): Promise<CloudBoxLookup> => ({
    sandboxId: 'sb-123',
    createdAtMs: NOW,
    createTimeoutMs: WINDOW,
  });

  /** Idle long enough to be past the box's idle timeout. */
  function idleStatus(idleForMs: number): BoxStatusStore {
    return statusFor({
      claude: { state: 'idle', updatedAt: new Date(NOW - idleForMs).toISOString() },
    } as Partial<BoxStatusSnapshot>);
  }

  it('pauses an idle box on an inactivity-model backend', async () => {
    const registry = new BoxRegistry();
    registerCloud(registry, 'b1', 'daytona');
    const paused: string[] = [];
    const got = deferred<void>();
    const backend = inactivityBackend((h) => {
      paused.push(h.sandboxId);
      got.resolve();
    });

    const loop = startCloudKeepaliveLoop({
      registry,
      statusStore: idleStatus(WINDOW + 60_000),
      log: () => {},
      intervalMs: 5,
      now: () => NOW,
      loadConfig: async () => CFG,
      resolveBackend: async () => backend,
      lookupBox: lookupIdleWindow,
    });

    await got.promise;
    await loop.stop();
    expect(paused).toEqual(['sb-123']);
  });

  it('passes the recorded sandbox class to pause (daytona archives a container, freezes a VM)', async () => {
    const registry = new BoxRegistry();
    registerCloud(registry, 'b1', 'daytona');
    const handles: CloudHandle[] = [];
    const got = deferred<void>();
    const backend = inactivityBackend((h) => {
      handles.push(h);
      got.resolve();
    });

    const loop = startCloudKeepaliveLoop({
      registry,
      statusStore: idleStatus(WINDOW + 60_000),
      log: () => {},
      intervalMs: 5,
      now: () => NOW,
      loadConfig: async () => CFG,
      resolveBackend: async () => backend,
      lookupBox: async (): Promise<CloudBoxLookup> => ({
        sandboxId: 'sb-123',
        createdAtMs: NOW,
        createTimeoutMs: WINDOW,
        sandboxClass: 'container',
      }),
    });

    await got.promise;
    await loop.stop();
    expect(handles).toEqual([{ sandboxId: 'sb-123', sandboxClass: 'container' }]);
  });

  it('records the box as paused so `list` does not keep showing it running', async () => {
    const registry = new BoxRegistry();
    registerCloud(registry, 'b1', 'daytona');
    const persisted: string[] = [];
    const got = deferred<void>();
    const backend = inactivityBackend(() => {});

    const loop = startCloudKeepaliveLoop({
      registry,
      statusStore: idleStatus(WINDOW + 60_000),
      log: () => {},
      intervalMs: 5,
      now: () => NOW,
      loadConfig: async () => CFG,
      resolveBackend: async () => backend,
      lookupBox: lookupIdleWindow,
      persistPaused: async (boxId: string) => {
        persisted.push(boxId);
        got.resolve();
      },
    });

    await got.promise;
    await loop.stop();
    expect(persisted).toEqual(['b1']);
  });

  it('keeps the box paused even if recording the state fails', async () => {
    // The pause already happened; a failed record write must not look like a
    // failed pause and re-arm the box for another pause next tick.
    const registry = new BoxRegistry();
    registerCloud(registry, 'b1', 'daytona');
    let pauses = 0;
    const backend = inactivityBackend(() => {
      pauses++;
    });

    const loop = startCloudKeepaliveLoop({
      registry,
      statusStore: idleStatus(WINDOW + 60_000),
      log: () => {},
      intervalMs: 5,
      now: () => NOW,
      loadConfig: async () => CFG,
      resolveBackend: async () => backend,
      lookupBox: lookupIdleWindow,
      persistPaused: async () => {
        throw new Error('state.json is locked');
      },
    });

    await new Promise((r) => setTimeout(r, 60)); // many ticks
    await loop.stop();
    expect(pauses).toBe(1);
  });

  it('pauses such a box only once, not on every tick', async () => {
    // A paused box keeps reporting the same idle snapshot, so it would re-qualify
    // forever without the already-paused guard.
    const registry = new BoxRegistry();
    registerCloud(registry, 'b1', 'daytona');
    let pauses = 0;
    const backend = inactivityBackend(() => {
      pauses++;
    });

    const loop = startCloudKeepaliveLoop({
      registry,
      statusStore: idleStatus(WINDOW + 60_000),
      log: () => {},
      intervalMs: 5,
      now: () => NOW,
      loadConfig: async () => CFG,
      resolveBackend: async () => backend,
      lookupBox: lookupIdleWindow,
    });

    await new Promise((r) => setTimeout(r, 60)); // many ticks
    await loop.stop();
    expect(pauses).toBe(1);
  });

  it('never pauses an idle box on an absolute-TTL backend (it lapses by itself)', async () => {
    const registry = new BoxRegistry();
    registerCloud(registry, 'b1', 'vercel');
    let pauses = 0;
    const backend = {
      name: 'vercel',
      renewTimeout: async () => {},
      pause: async () => {
        pauses++;
      },
    } as unknown as CloudBackend;

    const loop = startCloudKeepaliveLoop({
      registry,
      statusStore: idleStatus(WINDOW + 60_000),
      log: () => {},
      intervalMs: 5,
      now: () => NOW,
      loadConfig: async () => CFG,
      resolveBackend: async () => backend,
      lookupBox: lookupIdleWindow,
    });

    await new Promise((r) => setTimeout(r, 40));
    await loop.stop();
    expect(pauses).toBe(0);
  });

  it('leaves a box with no agent state alone (an attached shell is not idle evidence)', async () => {
    const registry = new BoxRegistry();
    registerCloud(registry, 'b1', 'daytona');
    let pauses = 0;
    const backend = inactivityBackend(() => {
      pauses++;
    });

    const loop = startCloudKeepaliveLoop({
      registry,
      statusStore: statusFor({}), // no claude/codex/opencode key at all
      log: () => {},
      intervalMs: 5,
      now: () => NOW,
      loadConfig: async () => CFG,
      resolveBackend: async () => backend,
      lookupBox: lookupAtNow,
    });

    await new Promise((r) => setTimeout(r, 40));
    await loop.stop();
    expect(pauses).toBe(0);
  });
});
