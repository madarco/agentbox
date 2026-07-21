import { describe, expect, it } from 'vitest';
import {
  OPEN_INBOUND_SOURCES,
  describeInbound,
  normalizeInboundCidr,
  parseInboundSpec,
  resolveInboundSources,
} from '../src/inbound.js';

describe('normalizeInboundCidr', () => {
  it('appends /32 to a bare IPv4', () => {
    expect(normalizeInboundCidr('203.0.113.5')).toBe('203.0.113.5/32');
  });
  it('appends /128 to a bare IPv6', () => {
    expect(normalizeInboundCidr('2001:db8::1')).toBe('2001:db8::1/128');
  });
  it('passes an existing CIDR through, trimmed', () => {
    expect(normalizeInboundCidr('  10.0.0.0/24 ')).toBe('10.0.0.0/24');
  });
});

describe('parseInboundSpec', () => {
  it('defaults empty/undefined/locked to locked', () => {
    for (const s of [undefined, '', '  ', 'locked', 'LOCK', 'Locked']) {
      expect(parseInboundSpec(s)).toEqual({ mode: 'locked', sources: [] });
    }
  });
  it('parses open (case-insensitive)', () => {
    expect(parseInboundSpec('OPEN')).toEqual({ mode: 'open', sources: [] });
  });
  it('parses a bare CIDR list as whitelist', () => {
    expect(parseInboundSpec('203.0.113.5/32, 198.51.100.7')).toEqual({
      mode: 'whitelist',
      sources: ['203.0.113.5/32', '198.51.100.7/32'],
    });
  });
  it('strips a whitelist: prefix', () => {
    expect(parseInboundSpec('whitelist:203.0.113.0/24')).toEqual({
      mode: 'whitelist',
      sources: ['203.0.113.0/24'],
    });
  });
  it('splits on spaces or commas', () => {
    expect(parseInboundSpec('1.2.3.4 5.6.7.8/32').sources).toEqual(['1.2.3.4/32', '5.6.7.8/32']);
  });
  it('throws on whitelist with no CIDRs', () => {
    expect(() => parseInboundSpec('whitelist:')).toThrow(/needs at least one CIDR/);
  });
});

describe('resolveInboundSources', () => {
  const host = '94.62.212.253/32';
  it('locked → just the host egress', () => {
    expect(resolveInboundSources({ mode: 'locked', sources: [] }, host)).toEqual([host]);
  });
  it('open → 0.0.0.0/0 + ::/0, ignoring host egress', () => {
    expect(resolveInboundSources({ mode: 'open', sources: [] }, host)).toEqual([
      ...OPEN_INBOUND_SOURCES,
    ]);
  });
  it('whitelist → host egress + the extra CIDRs, de-duped', () => {
    expect(
      resolveInboundSources({ mode: 'whitelist', sources: ['203.0.113.5/32', host] }, host),
    ).toEqual([host, '203.0.113.5/32']);
  });
  it('tolerates a missing host egress (open needs none)', () => {
    expect(resolveInboundSources({ mode: 'open', sources: [] }, null)).toEqual([
      ...OPEN_INBOUND_SOURCES,
    ]);
    expect(resolveInboundSources({ mode: 'whitelist', sources: ['1.2.3.4/32'] }, null)).toEqual([
      '1.2.3.4/32',
    ]);
  });
});

describe('describeInbound', () => {
  it('summarizes each mode', () => {
    expect(describeInbound({ mode: 'locked', sources: [] })).toMatch(/locked/);
    expect(describeInbound({ mode: 'open', sources: [] })).toMatch(/anywhere/);
    expect(describeInbound({ mode: 'whitelist', sources: ['1.2.3.4/32'] })).toMatch(/1.2.3.4\/32/);
  });
});
