import { describe, expect, it, vi } from 'vitest';
import type { BoxRecord, CloudBackend } from '@agentbox/core';
import { selectFirewallBoxes, startEgressWatchLoop } from '../src/egress-watch.js';

const box = (over: Partial<BoxRecord> & { lastState?: string; mode?: string }): BoxRecord =>
  ({
    id: over.id ?? 'b1',
    name: over.name ?? 'b1',
    provider: over.provider ?? 'hetzner',
    cloud: {
      sandboxId: '123',
      lastState: over.lastState ?? 'running',
      ...(over.mode ? { inbound: { mode: over.mode, sources: [] } } : {}),
    },
  }) as unknown as BoxRecord;

function harness(boxes: BoxRecord[], opts: { cache?: string[] | null; detect?: string[] } = {}) {
  const detect = vi.fn(async () => opts.detect ?? ['5.5.5.5/32']);
  const repair = vi.fn(async () => ({ changed: true, detail: 'added' }));
  const resolveBackend = vi.fn(
    async () => ({ name: 'hetzner', repairReachability: repair }) as unknown as CloudBackend,
  );
  let cache: string[] | null = opts.cache ?? null;
  const writeCache = vi.fn(async (c: string[]) => {
    cache = c;
  });
  const handle = startEgressWatchLoop({
    log: () => {},
    listBoxes: async () => boxes,
    detect,
    resolveBackend,
    readCache: async () => cache,
    writeCache,
    intervalMs: 1_000_000,
  });
  return { handle, detect, repair, resolveBackend, writeCache };
}

describe('selectFirewallBoxes', () => {
  it('keeps running, non-open hetzner/digitalocean boxes only', () => {
    const picked = selectFirewallBoxes([
      box({ id: 'h' }),
      box({ id: 'd', provider: 'digitalocean' }),
      box({ id: 'x', provider: 'docker' }),
      box({ id: 'e', provider: 'e2b' }),
      box({ id: 's', lastState: 'stopped' }),
      box({ id: 'o', mode: 'open' }),
    ]);
    expect(picked.map((b) => b.id)).toEqual(['h', 'd']);
  });
});

describe('startEgressWatchLoop', () => {
  it('does nothing at all without a firewall-bearing box: no probe, no backend', async () => {
    const h = harness([box({ provider: 'docker' }), box({ lastState: 'stopped' })]);
    await h.handle.stop();
    await h.handle.tick();
    expect(h.detect).not.toHaveBeenCalled();
    expect(h.resolveBackend).not.toHaveBeenCalled();
  });

  it('repairs every running box once on a change, then caches the new egress', async () => {
    const h = harness([box({ id: 'a' }), box({ id: 'b', provider: 'digitalocean' })], {
      cache: ['1.1.1.1/32'],
    });
    await h.handle.stop(); // drains the start tick
    expect(h.repair).toHaveBeenCalledTimes(2);
    expect(h.writeCache).toHaveBeenCalledWith(['5.5.5.5/32']);
  });

  it('probes but makes no provider call when the egress is unchanged', async () => {
    const h = harness([box({})], { cache: ['5.5.5.5/32'] });
    await h.handle.stop();
    expect(h.detect).toHaveBeenCalledTimes(1);
    expect(h.repair).not.toHaveBeenCalled();
  });

  it('keeps the old cache when a repair fails, so the next tick retries', async () => {
    const h = harness([box({})], { cache: ['1.1.1.1/32'] });
    // The start tick is parked on its first await; this lands before repair runs.
    h.repair.mockRejectedValueOnce(new Error('api down'));
    await h.handle.stop();
    expect(h.repair).toHaveBeenCalledTimes(1);
    expect(h.writeCache).not.toHaveBeenCalled();
  });
});
