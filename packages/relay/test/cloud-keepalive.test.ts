import { describe, expect, it } from 'vitest';
import {
  selectBoxesToRenew,
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
});
