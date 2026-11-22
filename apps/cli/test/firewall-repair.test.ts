import { describe, expect, it, vi } from 'vitest';
import type { BoxRecord, Provider } from '@agentbox/core';
import { ensureFirewallReach, withFirewallRepair } from '../src/lib/firewall-repair.js';

const box = (provider: string) => ({ id: 'b', name: 'b', provider }) as unknown as BoxRecord;

function fakeProvider(opts: { failFirst: boolean; changed: boolean }) {
  let calls = 0;
  const exec = vi.fn(async () => {
    calls += 1;
    if (opts.failFirst && calls === 1) throw new Error('ssh: connect timed out');
    return { stdout: '', stderr: '', exitCode: 0 };
  });
  const repairReachability = vi.fn(async () => ({
    changed: opts.changed,
    detail: opts.changed ? 'firewall updated: added' : 'firewall: already allowed',
  }));
  return {
    provider: { name: 'x', exec, repairReachability } as unknown as Provider,
    exec,
    repairReachability,
  };
}

describe('ensureFirewallReach', () => {
  it('adds a not-yet-allowed machine on the first connect failure and retries (hetzner + digitalocean)', async () => {
    for (const p of ['hetzner', 'digitalocean']) {
      const f = fakeProvider({ failFirst: true, changed: true });
      const lines: string[] = [];
      await ensureFirewallReach(f.provider, box(p), { enabled: true, onLog: (l) => lines.push(l) });
      expect(f.repairReachability).toHaveBeenCalledTimes(1);
      expect(f.exec).toHaveBeenCalledTimes(2);
      expect(lines).toEqual(['firewall updated: added']);
    }
  });

  it('touches nothing for a provider without a per-box firewall', async () => {
    const f = fakeProvider({ failFirst: true, changed: true });
    await ensureFirewallReach(f.provider, box('e2b'), { enabled: true, onLog: () => {} });
    expect(f.exec).not.toHaveBeenCalled();
    expect(f.repairReachability).not.toHaveBeenCalled();
  });

  it('a reachable box costs one exec and no repair', async () => {
    const f = fakeProvider({ failFirst: false, changed: false });
    await ensureFirewallReach(f.provider, box('hetzner'), { enabled: true, onLog: () => {} });
    expect(f.exec).toHaveBeenCalledTimes(1);
    expect(f.repairReachability).not.toHaveBeenCalled();
  });
});

describe('withFirewallRepair', () => {
  it('rethrows the original error when the repair changed nothing (not a firewall problem)', async () => {
    const f = fakeProvider({ failFirst: true, changed: false });
    await expect(
      withFirewallRepair(f.provider, box('hetzner'), { enabled: true, onLog: () => {} }, () =>
        f.provider.exec(box('hetzner'), ['true']),
      ),
    ).rejects.toThrow('connect timed out');
  });
});
