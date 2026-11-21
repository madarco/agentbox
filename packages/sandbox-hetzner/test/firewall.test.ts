import { describe, expect, it } from 'vitest';
import { upsertDeviceEntry, type DeviceAllowEntry } from '@agentbox/sandbox-core';
import {
  boxFirewallRules,
  boxFirewallSources,
  createPerBoxFirewall,
  decodeBoxFirewall,
  firewallNeedsSync,
  normalizeSourceCidr,
  writeBoxFirewall,
} from '../src/firewall.js';
import { HetznerApiError, type HetznerClient, type HetznerFirewall } from '../src/client.js';

describe('createPerBoxFirewall retries transient 5xx', () => {
  it('retries a 502 Bad Gateway and returns the firewall (does not abort the create)', async () => {
    let calls = 0;
    const fw: HetznerFirewall = { id: 7, name: 'box-fw', rules: [], applied_to: [] };
    const client = {
      createFirewall: async () => {
        calls += 1;
        if (calls === 1) throw new HetznerApiError(502, 'http_502', 'bad gateway');
        return fw;
      },
    } as unknown as HetznerClient;

    const result = await createPerBoxFirewall(client, {
      name: 'box-fw',
      ssh: { staticSources: [], entries: [{ key: 'pc-a', cidrs: ['1.2.3.4/32'], seen: 1 }] },
    });
    expect(result.id).toBe(7);
    expect(calls).toBe(2);
  });
});

describe('firewallNeedsSync', () => {
  it('no sync when the allowed source already matches the current egress', () => {
    expect(firewallNeedsSync('1.2.3.4/32', '1.2.3.4/32')).toBe(false);
  });

  it('sync when the egress IP changed', () => {
    expect(firewallNeedsSync('1.2.3.4/32', '5.6.7.8/32')).toBe(true);
  });

  it('never syncs a wide-open (0.0.0.0/0) firewall — explicit dynamic-IP opt-in', () => {
    expect(firewallNeedsSync('0.0.0.0/0', '5.6.7.8/32')).toBe(false);
  });

  it('syncs when there is no SSH rule at all (absent allowed source)', () => {
    expect(firewallNeedsSync(undefined, '5.6.7.8/32')).toBe(true);
  });

  it('no sync when the current egress is one of several allowed sources (whitelist)', () => {
    expect(firewallNeedsSync(['5.6.7.8/32', '1.2.3.4/32'], '1.2.3.4/32')).toBe(false);
  });

  it('syncs when the current egress is absent from the allowed list', () => {
    expect(firewallNeedsSync(['5.6.7.8/32', '9.9.9.9/32'], '1.2.3.4/32')).toBe(true);
  });

  it('never syncs when 0.0.0.0/0 is present (open policy)', () => {
    expect(firewallNeedsSync(['1.2.3.4/32', '0.0.0.0/0'], '5.6.7.8/32')).toBe(false);
  });
});

describe('normalizeSourceCidr', () => {
  it('appends /32 to a bare IPv4', () => {
    expect(normalizeSourceCidr('1.2.3.4')).toBe('1.2.3.4/32');
  });

  it('appends /128 to a bare IPv6', () => {
    expect(normalizeSourceCidr('2001:db8::1')).toBe('2001:db8::1/128');
  });

  it('passes through an already-CIDR value', () => {
    expect(normalizeSourceCidr('10.0.0.0/8')).toBe('10.0.0.0/8');
    expect(normalizeSourceCidr('0.0.0.0/0')).toBe('0.0.0.0/0');
  });

  it('trims whitespace', () => {
    expect(normalizeSourceCidr('  1.2.3.4  ')).toBe('1.2.3.4/32');
  });
});

describe('per-device firewall rules', () => {
  const pcA: DeviceAllowEntry = { key: 'pc-a', cidrs: ['1.1.1.1/32'], seen: 100 };
  const hub: DeviceAllowEntry = { key: 'hub', cidrs: ['9.9.9.9/32'], seen: 50, hub: true };

  it('writes one tcp/22 rule per device, metadata in the description, plus the static rule', () => {
    const rules = boxFirewallRules({ staticSources: ['10.0.0.0/8'], entries: [pcA, hub] });
    expect(rules.map((r) => [r.source_ips, r.description])).toEqual([
      [['10.0.0.0/8'], 'agentbox: SSH inbound'],
      [['9.9.9.9/32'], 'agentbox-device key=hub seen=50 hub'],
      [['1.1.1.1/32'], 'agentbox-device key=pc-a seen=100'],
    ]);
    expect(rules.every((r) => r.direction === 'in' && r.port === '22')).toBe(true);
  });

  it('round-trips through decode', () => {
    const ssh = { staticSources: ['10.0.0.0/8'], entries: [pcA, hub] };
    const back = decodeBoxFirewall(boxFirewallRules(ssh), []);
    expect(back.staticSources).toEqual(['10.0.0.0/8']);
    expect(back.entries).toEqual(expect.arrayContaining([pcA, hub]));
  });

  it('omits the static rule when the policy has no sources (locked)', () => {
    expect(boxFirewallRules({ staticSources: [], entries: [pcA] })).toHaveLength(1);
  });

  it('reads a pre-device firewall: the creator egress becomes a legacy entry, whitelist stays static', () => {
    const legacyRules = [
      {
        direction: 'in' as const,
        protocol: 'tcp' as const,
        port: '22',
        source_ips: ['1.1.1.1/32', '10.0.0.0/8'],
        description: 'agentbox: SSH inbound',
      },
    ];
    const fw = decodeBoxFirewall(legacyRules, ['10.0.0.0/8']);
    expect(fw.staticSources).toEqual(['10.0.0.0/8']);
    expect(fw.entries).toEqual([{ key: 'legacy', cidrs: ['1.1.1.1/32'], seen: 0 }]);
  });

  it("a second PC's repair adds its rule and keeps the first PC's (the last-PC-wins regression)", async () => {
    const before = boxFirewallRules({ staticSources: [], entries: [pcA] });
    const decoded = decodeBoxFirewall(before, []);
    const pcB: DeviceAllowEntry = { key: 'pc-b', cidrs: ['2.2.2.2/32'], seen: 200 };
    let written: unknown;
    const client = {
      setFirewallRules: async (_id: number, rules: unknown) => {
        written = rules;
        return [];
      },
    } as unknown as HetznerClient;
    const next = {
      staticSources: decoded.staticSources,
      entries: upsertDeviceEntry(decoded.entries, pcB),
    };
    await writeBoxFirewall(client, 7, next);
    const after = decodeBoxFirewall(written as never, []);
    expect(boxFirewallSources(after).sort()).toEqual(['1.1.1.1/32', '2.2.2.2/32']);
  });
});
