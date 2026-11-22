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

describe('sourceAddress', () => {
  it('uses the socket peer unless it is a loopback proxy', async () => {
    const { sourceAddress } = await import('../lib/peer');
    expect(sourceAddress('203.0.113.9', '1.2.3.4')).toBe('203.0.113.9');
    expect(sourceAddress('::ffff:203.0.113.9', undefined)).toBe('203.0.113.9');
    // Caddy on the same host: the last X-Forwarded-For entry is the one it added.
    expect(sourceAddress('127.0.0.1', 'spoofed, 198.51.100.1')).toBe('198.51.100.1');
    expect(sourceAddress('127.0.0.1', undefined)).toBe('127.0.0.1');
  });
});
