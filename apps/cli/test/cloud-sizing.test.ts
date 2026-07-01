import type { EffectiveConfig } from '@agentbox/config';
import { describe, expect, it } from 'vitest';
import { cloudSizingProviderOptions } from '../src/lib/cloud-sizing.js';

// Only the `box` slice is read; cast a minimal shape through unknown.
const cfg = {
  box: {
    vercelVcpus: 2,
    vercelTimeoutMs: 2_700_000,
    vercelNetworkPolicy: 'strict',
    e2bTimeoutMs: 120_000,
  },
} as unknown as EffectiveConfig;

describe('cloudSizingProviderOptions', () => {
  it('threads the e2b session timeout for e2b boxes', () => {
    expect(cloudSizingProviderOptions('e2b', cfg)).toEqual({ timeoutMs: 120_000 });
  });

  it('threads vcpus / timeout / network policy for vercel boxes', () => {
    expect(cloudSizingProviderOptions('vercel', cfg)).toEqual({
      vcpus: 2,
      timeoutMs: 2_700_000,
      networkPolicy: 'strict',
    });
  });

  it('returns nothing for providers without sizing overrides', () => {
    expect(cloudSizingProviderOptions('docker', cfg)).toEqual({});
    expect(cloudSizingProviderOptions('hetzner', cfg)).toEqual({});
    expect(cloudSizingProviderOptions('daytona', cfg)).toEqual({});
  });
});
