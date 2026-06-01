import { describe, expect, it } from 'vitest';
import { boxSizeConfigKey, resolveBoxSize } from '../src/size.js';
import { BUILT_IN_DEFAULTS, type EffectiveConfig } from '../src/types.js';

function cfg(overrides: Partial<EffectiveConfig['box']> = {}): EffectiveConfig {
  return {
    ...BUILT_IN_DEFAULTS,
    box: { ...BUILT_IN_DEFAULTS.box, ...overrides },
  };
}

describe('resolveBoxSize', () => {
  it('returns empty string when nothing is set', () => {
    expect(resolveBoxSize(cfg(), 'hetzner')).toBe('');
    expect(resolveBoxSize(cfg(), 'daytona')).toBe('');
    expect(resolveBoxSize(cfg(), 'docker')).toBe('');
  });

  it('falls back to box.size when no per-provider override is set', () => {
    const c = cfg({ size: 'cx33' });
    expect(resolveBoxSize(c, 'hetzner')).toBe('cx33');
    expect(resolveBoxSize(c, 'daytona')).toBe('cx33');
    expect(resolveBoxSize(c, 'docker')).toBe('cx33');
    expect(resolveBoxSize(c, 'vercel')).toBe('cx33');
  });

  it('per-provider override beats box.size', () => {
    const c = cfg({ size: 'cx33', sizeHetzner: 'cx43' });
    expect(resolveBoxSize(c, 'hetzner')).toBe('cx43');
    // other providers still see the generic fallback
    expect(resolveBoxSize(c, 'daytona')).toBe('cx33');
  });

  it('honors each per-provider key independently', () => {
    const c = cfg({
      sizeDocker: 'doc',
      sizeDaytona: '4-8-20',
      sizeHetzner: 'cx43',
      sizeVercel: 'vrc',
    });
    expect(resolveBoxSize(c, 'docker')).toBe('doc');
    expect(resolveBoxSize(c, 'daytona')).toBe('4-8-20');
    expect(resolveBoxSize(c, 'hetzner')).toBe('cx43');
    expect(resolveBoxSize(c, 'vercel')).toBe('vrc');
  });

  it('unknown provider falls into the docker bucket', () => {
    const c = cfg({ size: 'fallback', sizeDocker: 'doc' });
    // unknown string → docker key path
    expect(resolveBoxSize(c, 'mystery')).toBe('doc');
    // and falls back to box.size when sizeDocker is empty
    const c2 = cfg({ size: 'fallback' });
    expect(resolveBoxSize(c2, 'mystery')).toBe('fallback');
  });
});

describe('boxSizeConfigKey', () => {
  it('maps each provider to its flat key', () => {
    expect(boxSizeConfigKey('docker')).toBe('box.sizeDocker');
    expect(boxSizeConfigKey('daytona')).toBe('box.sizeDaytona');
    expect(boxSizeConfigKey('hetzner')).toBe('box.sizeHetzner');
    expect(boxSizeConfigKey('vercel')).toBe('box.sizeVercel');
  });

  it('returns the generic key for undefined / unknown provider', () => {
    expect(boxSizeConfigKey(undefined)).toBe('box.size');
    expect(boxSizeConfigKey('mystery')).toBe('box.size');
  });
});
