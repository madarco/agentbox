import { describe, expect, it } from 'vitest';
import {
  deviceEntryNeedsUpdate,
  upsertDeviceEntry,
  withInboundPolicy,
  type DeviceAllowEntry,
} from '@agentbox/sandbox-core';
import type {
  DigitalOceanClient,
  DigitalOceanFirewall,
  DigitalOceanInboundRule,
} from '../src/client.js';
import {
  allowAllOutboundRules,
  boxFirewallSources,
  controlPlaneInboundRules,
  decodeBoxFirewall,
  decodeDeviceTag,
  encodeBoxDevices,
  encodeDeviceTag,
  firewallDiscriminator,
  firewallNeedsSync,
  normalizeSourceCidr,
  sshInboundRules,
  writeBoxFirewall,
  type BoxFirewallSsh,
} from '../src/firewall.js';

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

describe('sshInboundRules', () => {
  it('emits exactly one rule: TCP/22 inbound from the given source', () => {
    const rules = sshInboundRules('1.2.3.4/32');
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({
      protocol: 'tcp',
      ports: '22',
      sources: { addresses: ['1.2.3.4/32'] },
    });
  });

  it('carries multiple sources in the single rule (host egress + whitelist / open)', () => {
    const rules = sshInboundRules(['1.2.3.4/32', '0.0.0.0/0', '::/0']);
    expect(rules).toHaveLength(1);
    expect(rules[0]?.sources.addresses).toEqual(['1.2.3.4/32', '0.0.0.0/0', '::/0']);
  });
});

describe('allowAllOutboundRules', () => {
  it('permits all egress over tcp/udp/icmp to IPv4 + IPv6 (DigitalOcean blocks egress otherwise)', () => {
    const rules = allowAllOutboundRules();
    const protocols = rules.map((r) => r.protocol).sort();
    expect(protocols).toEqual(['icmp', 'tcp', 'udp']);
    for (const r of rules) {
      expect(r.destinations.addresses).toEqual(['0.0.0.0/0', '::/0']);
    }
    // icmp carries no ports; tcp/udp span the full range.
    const tcp = rules.find((r) => r.protocol === 'tcp');
    expect(tcp?.ports).toBe('1-65535');
    const icmp = rules.find((r) => r.protocol === 'icmp');
    expect(icmp?.ports).toBeUndefined();
  });
});

describe('controlPlaneInboundRules', () => {
  it('locks :22 to the host CIDR but opens :80/:443 to the world (ACME + boxes)', () => {
    const rules = controlPlaneInboundRules('1.2.3.4/32');
    const ssh = rules.find((r) => r.ports === '22');
    expect(ssh?.sources.addresses).toEqual(['1.2.3.4/32']);
    for (const port of ['80', '443']) {
      const rule = rules.find((r) => r.ports === port);
      expect(rule?.sources.addresses).toEqual(['0.0.0.0/0', '::/0']);
    }
    // Never exposes the Next app's own port — Caddy fronts it on the compose net.
    expect(rules.map((r) => r.ports).sort()).toEqual(['22', '443', '80']);
  });
});

describe('firewallNeedsSync', () => {
  it('syncs when the current egress is not in the allowed sources', () => {
    expect(firewallNeedsSync(['1.2.3.4/32'], '5.6.7.8/32')).toBe(true);
  });

  it('does not sync when the current egress is already allowed', () => {
    expect(firewallNeedsSync(['1.2.3.4/32', '5.6.7.8/32'], '5.6.7.8/32')).toBe(false);
  });

  it('never syncs a wide-open firewall (0.0.0.0/0 already allows everyone)', () => {
    expect(firewallNeedsSync(['0.0.0.0/0'], '5.6.7.8/32')).toBe(false);
  });

  it('treats missing / empty sources as a mismatch worth syncing', () => {
    expect(firewallNeedsSync(undefined, '5.6.7.8/32')).toBe(true);
    expect(firewallNeedsSync([], '5.6.7.8/32')).toBe(true);
  });
});

describe('per-device entries in droplet tags', () => {
  const pcA: DeviceAllowEntry = { key: 'a1b2c3', cidrs: ['1.1.1.1/32'], seen: 100, label: 'mac' };
  const v6: DeviceAllowEntry = {
    key: 'd4e5f6',
    cidrs: ['2.2.2.2/32', '2001:db8:1:0::/64'],
    seen: 200,
    hub: true,
  };
  const BOX_TAG = 'agentbox-box-1';
  const disc = firewallDiscriminator(BOX_TAG);

  it('round-trips an entry through a DO-legal tag, IPv6 in the detector form', () => {
    for (const e of [pcA, v6]) {
      const tag = encodeDeviceTag(disc, e);
      expect(tag).toMatch(/^[A-Za-z0-9_:-]{1,255}$/);
      expect(decodeDeviceTag(tag as string)).toEqual(e);
    }
  });

  it('encodeDeviceTag refuses a CIDR it cannot represent', () => {
    expect(encodeDeviceTag(disc, { key: 'x', cidrs: ['not-an-ip'], seen: 1 })).toBeNull();
  });

  it('device tags differ per box (account-global tags must not be shared)', () => {
    const ssh = { staticSources: [], entries: [pcA] };
    expect(encodeBoxDevices('agentbox-a-1', ssh).tags).not.toEqual(
      encodeBoxDevices('agentbox-b-1', ssh).tags,
    );
    expect(disc).toMatch(/^[0-9a-f]{8}$/);
  });

  function box(ssh: BoxFirewallSsh): { fw: DigitalOceanFirewall; dropletTags: string[] } {
    const enc = encodeBoxDevices(BOX_TAG, ssh);
    return {
      fw: {
        id: 'fw-1',
        name: 'agentbox-box',
        status: 'succeeded',
        inbound_rules: sshInboundRules(boxFirewallSources(enc.ssh)),
        outbound_rules: allowAllOutboundRules(),
        droplet_ids: [42],
        tags: [BOX_TAG],
      },
      dropletTags: [BOX_TAG, 'agentbox', ...enc.tags],
    };
  }

  it('decodes entries back; unowned policy addresses are static', () => {
    const { fw, dropletTags } = box({ staticSources: ['10.0.0.0/8'], entries: [pcA, v6] });
    const back = decodeBoxFirewall(fw, dropletTags, ['10.0.0.0/8']);
    expect(back.staticSources).toEqual(['10.0.0.0/8']);
    expect(back.entries).toEqual(expect.arrayContaining([pcA, v6]));
  });

  it('a tag whose address is not in the rule does not count (no false "healed")', () => {
    const { fw, dropletTags } = box({ staticSources: [], entries: [pcA] });
    // updateFirewall failed after tagging: the tag says 9.9.9.9, the rule never got it
    const ghost: DeviceAllowEntry = { key: 'me0000', cidrs: ['9.9.9.9/32'], seen: 5 };
    const tags = [...dropletTags, encodeDeviceTag(disc, ghost) as string];
    const back = decodeBoxFirewall(fw, tags, []);
    expect(back.entries.map((e) => e.key)).toEqual(['a1b2c3']);
    expect(
      deviceEntryNeedsUpdate(back.entries, back.staticSources, 'me0000', ['9.9.9.9/32'], false),
    ).toBe(true);
  });

  it('a rule address no tag owns (a lost race) is an evictable legacy entry, not a permanent static source', () => {
    const { fw, dropletTags } = box({ staticSources: [], entries: [pcA] });
    fw.inbound_rules = sshInboundRules(['1.1.1.1/32', '7.7.7.7/32']);
    const back = decodeBoxFirewall(fw, dropletTags, []);
    expect(back.staticSources).toEqual([]);
    expect(back.entries).toContainEqual({ key: 'legacy', cidrs: ['7.7.7.7/32'], seen: 0 });
  });

  it('world-open addresses decode as static, and `inbound locked` removes them', () => {
    const { fw, dropletTags } = box({ staticSources: [], entries: [pcA] });
    fw.inbound_rules = sshInboundRules(['1.1.1.1/32', '0.0.0.0/0', '::/0']);
    const back = decodeBoxFirewall(fw, [BOX_TAG], []);
    expect(back.staticSources.sort()).toEqual(['0.0.0.0/0', '::/0']);
    expect(back.entries.flatMap((e) => e.cidrs)).toEqual(['1.1.1.1/32']);
    const locked = withInboundPolicy(back, []);
    expect(boxFirewallSources(locked)).toEqual([]);
    void dropletTags;
  });

  it('splits a big legacy entry across tags and loses no address', () => {
    const many = Array.from({ length: 40 }, (_, i) => `10.0.${String(i)}.1/32`);
    const big: DeviceAllowEntry = { key: 'legacy', cidrs: many, seen: 0 };
    const enc = encodeBoxDevices(BOX_TAG, { staticSources: [], entries: [big] });
    expect(enc.tags.length).toBeGreaterThan(1);
    for (const t of enc.tags) expect(t.length).toBeLessThanOrEqual(255);
    const fw = box({ staticSources: [], entries: [] }).fw;
    fw.inbound_rules = sshInboundRules(boxFirewallSources(enc.ssh));
    const back = decodeBoxFirewall(fw, [BOX_TAG, ...enc.tags], []);
    expect(back.entries).toHaveLength(1);
    expect(back.entries[0]?.cidrs.sort()).toEqual([...many].sort());
  });

  it('keeps an address no tag can carry in the rule instead of deleting it', () => {
    const enc = encodeBoxDevices(BOX_TAG, {
      staticSources: [],
      entries: [{ key: 'x', cidrs: ['1.1.1.1/32', 'not-an-ip'], seen: 1 }],
    });
    expect(boxFirewallSources(enc.ssh).sort()).toEqual(['1.1.1.1/32', 'not-an-ip']);
  });

  it('round-trips the pinned flag', () => {
    const p: DeviceAllowEntry = {
      key: 'e7e7e7',
      cidrs: ['10.8.0.1/32'],
      seen: 3,
      pinned: true,
      hub: true,
    };
    expect(decodeDeviceTag(encodeDeviceTag(disc, p) as string)).toEqual(p);
  });

  it("ignores another box's device tags on the same droplet tag list", () => {
    const other = encodeBoxDevices('agentbox-other-9', { staticSources: [], entries: [v6] });
    const { fw, dropletTags } = box({ staticSources: [], entries: [pcA] });
    const back = decodeBoxFirewall(fw, [...dropletTags, ...other.tags], []);
    expect(back.entries).toEqual([pcA]);
  });

  it('matches an IPv6 rule the API echoes in compressed form', () => {
    const { fw, dropletTags } = box({ staticSources: [], entries: [v6] });
    fw.inbound_rules = sshInboundRules(['2.2.2.2/32', '2001:db8:1::/64']);
    const back = decodeBoxFirewall(fw, dropletTags, []);
    expect(back.staticSources).toEqual([]);
  });

  it('reads a pre-device box: creator egress -> legacy entry, whitelist stays static', () => {
    const { fw } = box({ staticSources: ['1.1.1.1/32', '10.0.0.0/8'], entries: [] });
    const back = decodeBoxFirewall(fw, [BOX_TAG], ['10.0.0.0/8']);
    expect(back.staticSources).toEqual(['10.0.0.0/8']);
    expect(back.entries).toEqual([{ key: 'legacy', cidrs: ['1.1.1.1/32'], seen: 0 }]);
  });

  it("a second PC's write keeps the first PC's address and swaps only its own tag", async () => {
    const pcBOld: DeviceAllowEntry = { key: 'b0b0b0', cidrs: ['3.3.3.3/32'], seen: 150 };
    const { fw, dropletTags } = box({ staticSources: [], entries: [pcA, pcBOld] });
    const created: string[] = [];
    const tagged: string[] = [];
    const deleted: string[] = [];
    let body: { inbound_rules: DigitalOceanInboundRule[]; tags?: string[] } | undefined;
    const client = {
      createTag: async (t: string) => void created.push(t),
      tagDroplet: async (t: string) => void tagged.push(t),
      deleteTag: async (t: string) => void deleted.push(t),
      updateFirewall: async (_id: string, b: typeof body) => {
        body = b;
        return fw;
      },
    } as unknown as DigitalOceanClient;
    const current = decodeBoxFirewall(fw, dropletTags, []);
    const pcBNew: DeviceAllowEntry = { key: 'b0b0b0', cidrs: ['4.4.4.4/32'], seen: 300 };
    await writeBoxFirewall(
      client,
      fw,
      { id: 42, tags: dropletTags },
      {
        staticSources: current.staticSources,
        entries: upsertDeviceEntry(current.entries, pcBNew),
      },
    );
    expect(body?.inbound_rules[0]?.sources.addresses?.sort()).toEqual(['1.1.1.1/32', '4.4.4.4/32']);
    expect(body?.tags).toEqual([BOX_TAG]);
    expect(created).toEqual([encodeDeviceTag(disc, pcBNew)]);
    expect(tagged).toEqual([encodeDeviceTag(disc, pcBNew)]);
    expect(deleted).toEqual([encodeDeviceTag(disc, pcBOld)]);
  });
});
