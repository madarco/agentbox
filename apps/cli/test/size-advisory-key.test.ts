import { describe, expect, it } from 'vitest';
import { providerForSizeKey } from '../src/lib/size-advisory.js';

/**
 * Which provider a `box.size…` key targets. The generic `box.size` maps to
 * null — "ask the effective provider" — so setting a global default doesn't
 * emit warnings for backends the user never uses.
 */
describe('providerForSizeKey', () => {
  it('maps a per-provider key to its provider', () => {
    expect(providerForSizeKey('box.sizeDaytona')).toBe('daytona');
    expect(providerForSizeKey('box.sizeE2b')).toBe('e2b');
    expect(providerForSizeKey('box.sizeHetzner')).toBe('hetzner');
  });

  it('maps the generic key to null (defer to the effective provider)', () => {
    expect(providerForSizeKey('box.size')).toBeNull();
  });

  it('returns undefined for keys that are not size keys', () => {
    // undefined vs null is load-bearing: null means "resolve it", undefined
    // means "not a size key, say nothing".
    expect(providerForSizeKey('box.provider')).toBeUndefined();
    expect(providerForSizeKey('box.imageDaytona')).toBeUndefined();
    expect(providerForSizeKey('queue.openIn')).toBeUndefined();
  });
});
