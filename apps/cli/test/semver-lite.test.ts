import { describe, expect, it } from 'vitest';
import { compareSemver, isNewer } from '../src/lib/semver-lite.js';

describe('compareSemver', () => {
  it('orders plain triplets', () => {
    expect(compareSemver('0.22.1', '0.22.1')).toBe(0);
    expect(compareSemver('0.22.2', '0.22.1')).toBe(1);
    expect(compareSemver('0.22.1', '0.23.0')).toBe(-1);
    expect(compareSemver('1.0.0', '0.99.99')).toBe(1);
    expect(compareSemver('0.9.0', '0.10.0')).toBe(-1);
  });

  it('returns null for anything that is not x.y.z', () => {
    expect(compareSemver('0.0.0-dev', '0.22.1')).toBeNull();
    expect(compareSemver('0.22.1', 'latest')).toBeNull();
    expect(compareSemver('', '0.22.1')).toBeNull();
  });
});

describe('isNewer', () => {
  it('is true only for a strictly newer latest', () => {
    expect(isNewer('0.23.0', '0.22.1')).toBe(true);
    expect(isNewer('0.22.1', '0.22.1')).toBe(false);
    expect(isNewer('0.22.0', '0.22.1')).toBe(false);
  });

  it('never reads unparseable or missing versions as newer', () => {
    expect(isNewer(undefined, '0.22.1')).toBe(false);
    expect(isNewer('99.0.0', '0.0.0-dev')).toBe(false);
    expect(isNewer('banana', '0.22.1')).toBe(false);
  });
});
