import { describe, expect, it } from 'vitest';
import {
  selectBoxesToRenew,
  startCloudKeepaliveLoop,
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
  it('renews an active box, anchoring the target at lastActivity + window', () => {
    const out = selectBoxesToRenew([entry({ boxId: 'a', lastActivityMs: NOW })], WINDOW, NOW);
    expect(out).toEqual([
      { boxId: 'a', backend: 'vercel', targetDeadlineEpochMs: NOW + WINDOW },
    ]);
  });

  it('renews an idle box still within the window', () => {
    const e = entry({ boxId: 'a', agentState: 'idle', lastActivityMs: NOW - WINDOW + 1 });
    expect(selectBoxesToRenew([e], WINDOW, NOW)).toHaveLength(1);
  });

  it('skips an idle box past the window (it lapses)', () => {
    const e = entry({ boxId: 'a', agentState: 'idle', lastActivityMs: NOW - WINDOW });
    expect(selectBoxesToRenew([e], WINDOW, NOW)).toEqual([]);
  });

  it('skips boxes with no activity signal', () => {
    expect(
      selectBoxesToRenew([entry({ boxId: 'a', lastActivityMs: null })], WINDOW, NOW),
    ).toEqual([]);
    expect(
      selectBoxesToRenew([entry({ boxId: 'b', agentState: null })], WINDOW, NOW),
    ).toEqual([]);
  });

  it('recomputes the target from lastActivity, not now (restart-robust)', () => {
    const e = entry({ boxId: 'a', lastActivityMs: NOW });
    const a = selectBoxesToRenew([e], WINDOW, NOW);
    const b = selectBoxesToRenew([e], WINDOW, NOW + 999_999);
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
      lookupSandboxId: async () => 'sb-123',
      vercelCreateTimeoutMs: async () => 0, // seed tracked deadline = createdAt(=NOW)
    });

    await got.promise;
    await loop.stop();

    expect(calls).toEqual([{ id: 'sb-123', target: NOW + WINDOW, current: NOW }]);
  });

  it('skips docker boxes and backends without renewTimeout', async () => {
    const registry = new BoxRegistry();
    // docker box (no renewal)
    registry.register({
      boxId: 'd1',
      token: 't',
      name: 'd1',
      registeredAt: new Date(NOW).toISOString(),
      kind: 'docker',
      containerName: 'agentbox-d1',
      createdAt: new Date(NOW).toISOString(),
    });
    // cloud box whose backend lacks renewTimeout
    registerCloud(registry, 'c1', 'daytona');
    let calls = 0;
    const backend = { name: 'daytona' } as unknown as CloudBackend; // no renewTimeout

    const loop = startCloudKeepaliveLoop({
      registry,
      statusStore: statusFor({ claude: { state: 'working', updatedAt: new Date(NOW).toISOString() } }),
      log: () => {},
      intervalMs: 5,
      now: () => NOW,
      loadConfig: async () => CFG,
      resolveBackend: async () => backend,
      lookupSandboxId: async () => {
        calls++;
        return 'sb-x';
      },
      vercelCreateTimeoutMs: async () => 0,
    });

    await new Promise((r) => setTimeout(r, 40));
    await loop.stop();
    expect(calls).toBe(0);
  });

  it('does not crash when renewTimeout throws', async () => {
    const registry = new BoxRegistry();
    registerCloud(registry, 'b1');
    const attempted = deferred<void>();
    const backend: CloudBackend = {
      name: 'vercel',
      renewTimeout: async () => {
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
      lookupSandboxId: async () => 'sb-123',
      vercelCreateTimeoutMs: async () => 0,
    });

    await attempted.promise;
    // The loop must keep scheduling after a renew failure.
    await new Promise((r) => setTimeout(r, 20));
    await expect(loop.stop()).resolves.toBeUndefined();
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
      lookupSandboxId: async () => 'sb-123',
      vercelCreateTimeoutMs: async () => 0,
    });

    await new Promise((r) => setTimeout(r, 40));
    await loop.stop();
    expect(calls).toBe(0);
  });
});
