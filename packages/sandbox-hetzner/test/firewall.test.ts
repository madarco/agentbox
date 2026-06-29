import { describe, expect, it } from 'vitest';
import { firewallNeedsSync, normalizeSourceCidr, sshOnlyInboundRule } from '../src/firewall.js';

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

describe('sshOnlyInboundRule', () => {
  it('emits exactly one rule: TCP/22 inbound from the given source', () => {
    const rules = sshOnlyInboundRule('1.2.3.4/32');
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({
      direction: 'in',
      protocol: 'tcp',
      port: '22',
      source_ips: ['1.2.3.4/32'],
    });
    // No destination_ips (those are for outbound rules); no other rules in
    // the array (outbound is unrestricted by absence).
    expect(rules[0]?.destination_ips).toBeUndefined();
  });
});
