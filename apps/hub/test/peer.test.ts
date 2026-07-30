import { describe, expect, it } from 'vitest';
import { isLoopbackAddress, PEER_LOOPBACK_HEADER } from '../lib/peer';

describe('isLoopbackAddress', () => {
  it('accepts the loopback forms node reports for a local client', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('127.0.0.5')).toBe(true);
    expect(isLoopbackAddress('::1')).toBe(true);
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true);
  });

  it('rejects LAN / undefined peers (fail-closed)', () => {
    expect(isLoopbackAddress('172.17.0.2')).toBe(false);
    expect(isLoopbackAddress('192.168.68.57')).toBe(false);
    expect(isLoopbackAddress('10.0.0.4')).toBe(false);
    expect(isLoopbackAddress(undefined)).toBe(false);
    expect(isLoopbackAddress('')).toBe(false);
  });

  it('exposes the trusted header name server.ts and the route agree on', () => {
    expect(PEER_LOOPBACK_HEADER).toBe('x-agentbox-peer-loopback');
  });
});
