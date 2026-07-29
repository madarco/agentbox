import { describe, expect, it } from 'vitest';
import { resolvePrepareLocation } from '../src/location.js';
import { BUILT_IN_DEFAULTS, type EffectiveConfig } from '../src/types.js';

function cfg(overrides: Partial<EffectiveConfig['box']> = {}): EffectiveConfig {
  return {
    ...BUILT_IN_DEFAULTS,
    box: { ...BUILT_IN_DEFAULTS.box, ...overrides },
  };
}

describe('resolvePrepareLocation', () => {
  it('prefers an explicit value over the config pin', () => {
    expect(resolvePrepareLocation('hetzner', 'fsn1', cfg({ hetznerLocation: 'nbg1' }))).toBe(
      'fsn1',
    );
  });

  it('trims the explicit value and ignores a blank one', () => {
    expect(resolvePrepareLocation('hetzner', '  fsn1 ', cfg())).toBe('fsn1');
    expect(resolvePrepareLocation('hetzner', '   ', cfg({ hetznerLocation: 'nbg1' }))).toBe('nbg1');
  });

  it('falls back to the provider-specific config pin', () => {
    expect(resolvePrepareLocation('hetzner', undefined, cfg({ hetznerLocation: 'hel1' }))).toBe(
      'hel1',
    );
    expect(
      resolvePrepareLocation('digitalocean', undefined, cfg({ digitaloceanRegion: 'fra1' })),
    ).toBe('fra1');
    expect(resolvePrepareLocation('daytona', undefined, cfg({ daytonaRegion: 'us-east-1' }))).toBe(
      'us-east-1',
    );
  });

  it('is undefined for providers with no bake-time placement', () => {
    expect(resolvePrepareLocation('vercel', undefined, cfg({ hetznerLocation: 'nbg1' }))).toBe(
      undefined,
    );
  });

  it('is undefined when no config is available and no explicit value is given', () => {
    expect(resolvePrepareLocation('hetzner', undefined, undefined)).toBe(undefined);
    // daytonaRegion has no built-in default (empty), so it resolves to undefined.
    expect(resolvePrepareLocation('daytona', undefined, cfg())).toBe(undefined);
  });

  it('resolves hetzner/digitalocean to their built-in default pin when unset', () => {
    expect(resolvePrepareLocation('hetzner', undefined, cfg())).toBe('nbg1');
    expect(resolvePrepareLocation('digitalocean', undefined, cfg())).toBe('nyc3');
  });
});
