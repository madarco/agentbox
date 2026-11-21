import { describe, expect, it, vi } from 'vitest';
import type { BoxRecord, CloudBackend } from '@agentbox/core';
import {
  selectFirewallBoxes,
  startEgressWatchLoop,
  type EgressCache,
} from '../src/egress-watch.js';

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

function harness(boxes: BoxRecord[], opts: { cache?: EgressCache | null; detect?: string[] } = {}) {
  const detect = vi.fn(async () => opts.detect ?? ['5.5.5.5/32']);
  const repair = vi.fn(async () => ({ changed: true, detail: 'added' }));
  const resolveBackend = vi.fn(
    async () => ({ name: 'hetzner', repairReachability: repair }) as unknown as CloudBackend,
  );
  const state = { cache: opts.cache ?? null };
  const writeCache = vi.fn(async (c: EgressCache) => {
    state.cache = c;
  });
  const handle = startEgressWatchLoop({
    log: () => {},
    listBoxes: async () => boxes,
    detect,
    resolveBackend,
    readCache: async () => state.cache,
    writeCache,
    intervalMs: 1_000_000,
  });
  return { handle, detect, repair, resolveBackend, writeCache, state };
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

  it('repairs every running box once on a change, then records each as verified', async () => {
    const h = harness([box({ id: 'a' }), box({ id: 'b', provider: 'digitalocean' })], {
      cache: { cidrs: ['1.1.1.1/32'], boxes: { a: '1.1.1.1/32', b: '1.1.1.1/32' } },
    });
    await h.handle.stop(); // drains the start tick
    expect(h.repair).toHaveBeenCalledTimes(2);
    expect(h.state.cache).toEqual({
      cidrs: ['5.5.5.5/32'],
      boxes: { a: '5.5.5.5/32', b: '5.5.5.5/32' },
    });
  });

  it('probes but makes no provider call when every box is verified at this egress', async () => {
    const h = harness([box({})], { cache: { cidrs: ['5.5.5.5/32'], boxes: { b1: '5.5.5.5/32' } } });
    await h.handle.stop();
    expect(h.detect).toHaveBeenCalledTimes(1);
    expect(h.repair).not.toHaveBeenCalled();
    expect(h.writeCache).not.toHaveBeenCalled();
  });

  it('a missing IPv6 answer is not a change', async () => {
    const h = harness([box({})], {
      detect: ['5.5.5.5/32'],
      cache: { cidrs: ['5.5.5.5/32', '2001:db8::/64'], boxes: { b1: '5.5.5.5/32' } },
    });
    await h.handle.stop();
    expect(h.repair).not.toHaveBeenCalled();
  });

  it('leaves a failed box unverified, so the next tick retries it', async () => {
    const h = harness([box({})], { cache: { cidrs: ['1.1.1.1/32'], boxes: { b1: '1.1.1.1/32' } } });
    // The start tick is parked on its first await; this lands before repair runs.
    h.repair.mockRejectedValueOnce(new Error('api down'));
    await h.handle.stop();
    expect(h.repair).toHaveBeenCalledTimes(1);
    expect(h.state.cache?.boxes).toEqual({});
  });

  it('repairs a box that was paused through the change once it runs again', async () => {
    const boxes = [box({ id: 'p', lastState: 'paused' })];
    const h = harness(boxes, { cache: { cidrs: ['5.5.5.5/32'], boxes: {} } });
    await h.handle.stop();
    expect(h.repair).not.toHaveBeenCalled();
    (boxes[0] as { cloud: { lastState: string } }).cloud.lastState = 'running';
    const h2 = harness(boxes, { cache: h.state.cache });
    await h2.handle.stop();
    expect(h2.repair).toHaveBeenCalledTimes(1);
  });
});
