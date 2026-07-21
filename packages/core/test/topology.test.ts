import { describe, expect, it } from 'vitest';
import { resolveSyncTopology } from '../src/sync/topology.js';

describe('resolveSyncTopology', () => {
  it('docker is always docker, regardless of a URL', () => {
    expect(resolveSyncTopology('docker', undefined)).toBe('docker');
    expect(resolveSyncTopology('docker', 'https://plane.example')).toBe('docker');
  });

  it('a cloud provider without a control-plane URL is classic cloud', () => {
    for (const p of ['daytona', 'vercel', 'hetzner', 'e2b']) {
      expect(resolveSyncTopology(p, undefined)).toBe('cloud');
      expect(resolveSyncTopology(p, '')).toBe('cloud'); // empty string is not a URL
    }
  });

  it('a cloud provider with a control-plane URL is control-plane', () => {
    for (const p of ['daytona', 'vercel', 'hetzner', 'e2b']) {
      expect(resolveSyncTopology(p, 'https://plane.example')).toBe('control-plane');
    }
  });
});
