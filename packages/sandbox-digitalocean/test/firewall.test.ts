import { describe, expect, it } from 'vitest';
import { allowAllOutboundRules, normalizeSourceCidr, sshInboundRules } from '../src/firewall.js';

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
