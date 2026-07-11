import type { EffectiveConfig } from '@agentbox/config';
import { describe, expect, it } from 'vitest';
import { cloudSizingProviderOptions } from '../src/lib/cloud-sizing.js';

// Only the `box` slice is read; cast a minimal shape through unknown.
function makeCfg(box: Record<string, unknown> = {}): EffectiveConfig {
  return {
    box: {
      size: '',
      sizeDocker: '',
      sizeDaytona: '',
      sizeHetzner: '',
      sizeVercel: '',
      sizeE2b: '',
      hetznerLocation: 'nbg1',
      vercelTimeoutMs: 2_700_000,
      vercelNetworkPolicy: 'strict',
      e2bTimeoutMs: 120_000,
      ...box,
    },
  } as unknown as EffectiveConfig;
}

describe('cloudSizingProviderOptions', () => {
  it('threads the e2b session timeout for e2b boxes', () => {
    expect(cloudSizingProviderOptions('e2b', makeCfg())).toEqual({ timeoutMs: 120_000 });
  });

  it('threads timeout / network policy for vercel boxes (no vcpus key)', () => {
    expect(cloudSizingProviderOptions('vercel', makeCfg())).toEqual({
      timeoutMs: 2_700_000,
      networkPolicy: 'strict',
    });
  });

  it('defaults hetzner to the configured location', () => {
    expect(cloudSizingProviderOptions('hetzner', makeCfg())).toEqual({ location: 'nbg1' });
  });

  it('omits inbound when locked (default) — backend treats absent as locked', () => {
    expect('inbound' in cloudSizingProviderOptions('hetzner', makeCfg({ inbound: 'locked' }))).toBe(
      false,
    );
    expect(
      'inbound' in cloudSizingProviderOptions('digitalocean', makeCfg({ inbound: 'locked' })),
    ).toBe(false);
  });

  it('emits inbound for hetzner/digitalocean when open or a CIDR list', () => {
    expect(cloudSizingProviderOptions('hetzner', makeCfg({ inbound: 'open' })).inbound).toBe('open');
    expect(
      cloudSizingProviderOptions('digitalocean', makeCfg({ inbound: '203.0.113.5/32' })).inbound,
    ).toBe('203.0.113.5/32');
  });

  it('lets the --inbound flag win over box.inbound', () => {
    expect(
      cloudSizingProviderOptions('hetzner', makeCfg({ inbound: 'locked' }), { inbound: 'open' })
        .inbound,
    ).toBe('open');
  });

  it('never emits inbound for non-VPS providers', () => {
    expect('inbound' in cloudSizingProviderOptions('vercel', makeCfg({ inbound: 'open' }))).toBe(
      false,
    );
  });

  it('emits no size when neither flag nor config sets one', () => {
    expect(cloudSizingProviderOptions('docker', makeCfg())).toEqual({});
    expect(cloudSizingProviderOptions('daytona', makeCfg())).toEqual({});
  });

  it('emits the resolved size for every provider', () => {
    const cfg = makeCfg({ size: '4-8-20' });
    expect(cloudSizingProviderOptions('daytona', cfg)).toEqual({ size: '4-8-20' });
    expect(cloudSizingProviderOptions('docker', cfg)).toEqual({ size: '4-8-20' });
    expect(cloudSizingProviderOptions('hetzner', cfg)).toEqual({
      size: '4-8-20',
      location: 'nbg1',
    });
  });

  it('prefers the per-provider size key over the generic one', () => {
    const cfg = makeCfg({ size: '4-8-20', sizeHetzner: 'cx33' });
    expect(cloudSizingProviderOptions('hetzner', cfg)).toMatchObject({ size: 'cx33' });
  });

  it('lets the --size flag win over config, trimming whitespace', () => {
    const cfg = makeCfg({ sizeVercel: '2' });
    expect(cloudSizingProviderOptions('vercel', cfg, { size: ' 4 ' })).toMatchObject({ size: '4' });
    // A blank flag falls back to config rather than clearing the size.
    expect(cloudSizingProviderOptions('vercel', cfg, { size: '  ' })).toMatchObject({ size: '2' });
  });

  it('lets the --location flag win over box.hetznerLocation, hetzner only', () => {
    const cfg = makeCfg();
    expect(cloudSizingProviderOptions('hetzner', cfg, { location: ' fsn1 ' })).toEqual({
      location: 'fsn1',
    });
    expect(cloudSizingProviderOptions('daytona', cfg, { location: 'fsn1' })).toEqual({});
  });
});
