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
      daytonaClass: 'linux-vm',
      daytonaRegion: '',
      daytonaTimeoutMs: 1_500_000,
      ...box,
    },
  } as unknown as EffectiveConfig;
}

/**
 * What every daytona call emits on top of whatever the test is asserting. The
 * class and region are coupled (only us-east-1 has linux-vm runners), and the
 * timeout rides the same keepalive rail as vercel/e2b.
 */
const DAYTONA_BASE = {
  timeoutMs: 1_500_000,
  sandboxClass: 'linux-vm',
  location: 'us-east-1',
};

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
    expect(cloudSizingProviderOptions('daytona', makeCfg())).toEqual(DAYTONA_BASE);
  });

  it('emits the resolved size for every provider', () => {
    const cfg = makeCfg({ size: '4-8-20' });
    expect(cloudSizingProviderOptions('daytona', cfg)).toEqual({ ...DAYTONA_BASE, size: '4-8-20' });
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
    // --location is a hetzner/digitalocean flag; daytona's region comes from
    // box.daytonaRegion (coupled to the class), not from the flag.
    expect(cloudSizingProviderOptions('daytona', cfg, { location: 'fsn1' })).toEqual(DAYTONA_BASE);
  });
});

describe('daytona class / region coupling', () => {
  it('pins linux-vm boxes to us-east-1 — the only region with VM runners', () => {
    expect(cloudSizingProviderOptions('daytona', makeCfg())).toMatchObject({
      sandboxClass: 'linux-vm',
      location: 'us-east-1',
    });
  });

  it('emits no region for container boxes, leaving them on the account default', () => {
    // This is what preserves today's behavior byte-for-byte for anyone who opts
    // out of VMs (e.g. for EU data residency).
    const out = cloudSizingProviderOptions('daytona', makeCfg({ daytonaClass: 'container' }));
    expect(out).toMatchObject({ sandboxClass: 'container' });
    expect('location' in out).toBe(false);
  });

  it('lets an explicit region override the class-derived one', () => {
    expect(
      cloudSizingProviderOptions('daytona', makeCfg({ daytonaRegion: 'eu' })),
    ).toMatchObject({ location: 'eu' });
  });

  it('passes daytonaTimeoutMs=0 through, so "disable auto-stop" is not silently dropped', () => {
    expect(cloudSizingProviderOptions('daytona', makeCfg({ daytonaTimeoutMs: 0 }))).toMatchObject({
      timeoutMs: 0,
    });
  });
});

describe('digitalocean project', () => {
  it('passes box.digitaloceanProject through as providerOptions.project', () => {
    const cfg = makeCfg({ digitaloceanRegion: 'nyc3', digitaloceanProject: 'client-x' });
    expect(cloudSizingProviderOptions('digitalocean', cfg)).toEqual({
      location: 'nyc3',
      project: 'client-x',
    });
  });

  // Unset must emit nothing: an absent project means "the account's default",
  // which is DigitalOcean's own behavior and costs no API call in the backend.
  it('emits nothing when unset', () => {
    const cfg = makeCfg({ digitaloceanRegion: 'nyc3', digitaloceanProject: '' });
    expect(cloudSizingProviderOptions('digitalocean', cfg)).toEqual({ location: 'nyc3' });
  });

  it('is ignored for every other provider', () => {
    const cfg = makeCfg({ digitaloceanProject: 'client-x' });
    for (const p of ['hetzner', 'daytona', 'vercel', 'e2b', 'docker']) {
      expect(cloudSizingProviderOptions(p, cfg).project).toBeUndefined();
    }
  });
});
