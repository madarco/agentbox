import { describe, expect, it } from 'vitest';
import { compareSemver, isNewer } from '../src/lib/semver-lite.js';

describe('compareSemver — plain releases', () => {
  it('orders by major, minor, patch', () => {
    expect(compareSemver('1.0.0', '0.9.9')).toBe(1);
    expect(compareSemver('0.28.0', '0.27.9')).toBe(1);
    expect(compareSemver('0.27.1', '0.27.2')).toBe(-1);
    expect(compareSemver('0.27.0', '0.27.0')).toBe(0);
  });

  it('returns null for unparseable input', () => {
    expect(compareSemver('not-a-version', '1.0.0')).toBeNull();
    expect(compareSemver('1.0', '1.0.0')).toBeNull();
    // An HTML error page from a proxy, which the registry fetch could hand us.
    expect(compareSemver('<!doctype html>', '1.0.0')).toBeNull();
  });

  it('treats the 0.0.0 dev sentinel as uncomparable in both directions', () => {
    expect(compareSemver('0.27.0', '0.0.0-dev')).toBeNull();
    expect(compareSemver('0.0.0-dev', '0.27.0')).toBeNull();
    expect(isNewer('0.27.0', '0.0.0-dev')).toBe(false);
  });
});

describe('compareSemver — prerelease ordering', () => {
  // The two comparisons the whole nightly channel rests on.
  it('a newer nightly supersedes an older one', () => {
    expect(compareSemver('0.28.0-nightly.202607251430', '0.28.0-nightly.202607241200')).toBe(1);
    expect(isNewer('0.28.0-nightly.6', '0.28.0-nightly.5')).toBe(true);
  });

  it('the release supersedes every nightly of the same version', () => {
    expect(compareSemver('0.28.0', '0.28.0-nightly.202607251430')).toBe(1);
    expect(isNewer('0.28.0', '0.28.0-nightly.999')).toBe(true);
    // ...and is not superseded BY one.
    expect(isNewer('0.28.0-nightly.999', '0.28.0')).toBe(false);
  });

  it('a later version prerelease still outranks an earlier release', () => {
    expect(isNewer('0.29.0-nightly.1', '0.28.0')).toBe(true);
  });

  it('compares numeric identifiers numerically, not lexically', () => {
    // The bug a naive string compare produces: '10' < '9' lexically.
    expect(compareSemver('1.0.0-nightly.10', '1.0.0-nightly.9')).toBe(1);
  });

  it('ranks a numeric identifier below an alphanumeric one', () => {
    expect(compareSemver('1.0.0-1', '1.0.0-alpha')).toBe(-1);
    expect(compareSemver('1.0.0-alpha', '1.0.0-1')).toBe(1);
  });

  it('breaks a prefix tie in favour of the longer identifier list', () => {
    expect(compareSemver('1.0.0-nightly.1.2', '1.0.0-nightly.1')).toBe(1);
    expect(compareSemver('1.0.0-nightly.1', '1.0.0-nightly.1.2')).toBe(-1);
  });

  it('matches the spec example chain', () => {
    const ascending = [
      '1.0.0-alpha',
      '1.0.0-alpha.1',
      '1.0.0-alpha.beta',
      '1.0.0-beta',
      '1.0.0-beta.2',
      '1.0.0-beta.11',
      '1.0.0-rc.1',
      '1.0.0',
    ];
    for (let i = 1; i < ascending.length; i++) {
      const lower = ascending[i - 1] as string;
      const higher = ascending[i] as string;
      expect(compareSemver(higher, lower), `${higher} > ${lower}`).toBe(1);
    }
  });

  it('ignores build metadata', () => {
    expect(compareSemver('1.0.0+abc', '1.0.0+def')).toBe(0);
    expect(compareSemver('1.0.0-nightly.1+abc', '1.0.0-nightly.1')).toBe(0);
  });

  it('rejects an empty prerelease identifier', () => {
    expect(compareSemver('1.0.0-a..b', '1.0.0')).toBeNull();
  });
});
