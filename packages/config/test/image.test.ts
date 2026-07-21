import { describe, expect, it } from 'vitest';
import { boxImageConfigKey, resolveBoxImage } from '../src/image.js';
import { BUILT_IN_DEFAULTS, type EffectiveConfig } from '../src/types.js';

function cfg(overrides: Partial<EffectiveConfig['box']> = {}): EffectiveConfig {
  return {
    ...BUILT_IN_DEFAULTS,
    box: { ...BUILT_IN_DEFAULTS.box, ...overrides },
  };
}

describe('resolveBoxImage', () => {
  it('falls back to the built-in agentbox/box:dev when nothing is set', () => {
    expect(resolveBoxImage(cfg(), 'hetzner')).toBe('agentbox/box:dev');
    expect(resolveBoxImage(cfg(), 'daytona')).toBe('agentbox/box:dev');
    expect(resolveBoxImage(cfg(), 'docker')).toBe('agentbox/box:dev');
    expect(resolveBoxImage(cfg(), 'vercel')).toBe('agentbox/box:dev');
  });

  it('returns box.image when no per-provider override is set', () => {
    const c = cfg({ image: 'custom/image:latest' });
    expect(resolveBoxImage(c, 'docker')).toBe('custom/image:latest');
    expect(resolveBoxImage(c, 'daytona')).toBe('custom/image:latest');
    expect(resolveBoxImage(c, 'hetzner')).toBe('custom/image:latest');
    expect(resolveBoxImage(c, 'vercel')).toBe('custom/image:latest');
  });

  it('per-provider override beats box.image', () => {
    const c = cfg({ image: 'generic', imageHetzner: 'agentbox-base-abc' });
    expect(resolveBoxImage(c, 'hetzner')).toBe('agentbox-base-abc');
    // other providers still see the generic fallback
    expect(resolveBoxImage(c, 'daytona')).toBe('generic');
    expect(resolveBoxImage(c, 'docker')).toBe('generic');
  });

  it('isolates per-provider keys from each other', () => {
    // Concrete bug repro: a Vercel snapshot id pinned via imageVercel must
    // not leak into a Hetzner create.
    const c = cfg({
      imageDocker: 'docker-tag',
      imageDaytona: 'agentbox-base-day',
      imageHetzner: 'agentbox-base-hetz',
      imageVercel: 'snap_vercel123',
    });
    expect(resolveBoxImage(c, 'docker')).toBe('docker-tag');
    expect(resolveBoxImage(c, 'daytona')).toBe('agentbox-base-day');
    expect(resolveBoxImage(c, 'hetzner')).toBe('agentbox-base-hetz');
    expect(resolveBoxImage(c, 'vercel')).toBe('snap_vercel123');
  });

  it('unknown / plugin provider falls back to the generic box.image (not the docker bucket)', () => {
    // An external plugin provider has no `box.image<P>` key; it must resolve to
    // the generic `box.image` sentinel, never docker's per-provider value.
    const c = cfg({ image: 'fallback', imageDocker: 'doc' });
    expect(resolveBoxImage(c, 'digitalocean')).toBe('fallback');
    const c2 = cfg({ image: 'fallback' });
    expect(resolveBoxImage(c2, 'mystery')).toBe('fallback');
  });
});

describe('boxImageConfigKey', () => {
  it('maps each provider to its flat key', () => {
    expect(boxImageConfigKey('docker')).toBe('box.imageDocker');
    expect(boxImageConfigKey('daytona')).toBe('box.imageDaytona');
    expect(boxImageConfigKey('hetzner')).toBe('box.imageHetzner');
    expect(boxImageConfigKey('vercel')).toBe('box.imageVercel');
  });

  it('returns the generic key for undefined / unknown provider', () => {
    expect(boxImageConfigKey(undefined)).toBe('box.image');
    expect(boxImageConfigKey('mystery')).toBe('box.image');
  });
});
