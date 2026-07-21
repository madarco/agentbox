import { describe, expect, it } from 'vitest';
import { baseFreshnessFromFingerprints } from '../src/checkpoint.js';

describe('baseFreshnessFromFingerprints', () => {
  it('reports fresh when stored and live fingerprints match', () => {
    expect(baseFreshnessFromFingerprints('abc123', 'abc123')).toEqual({ state: 'fresh' });
  });

  it('reports stale with a short-hash reason when they differ', () => {
    const s = baseFreshnessFromFingerprints('a'.repeat(64), 'b'.repeat(64));
    expect(s.state).toBe('stale');
    if (s.state === 'stale') {
      // Both short hashes appear so the nag is diagnosable.
      expect(s.reason).toContain('aaaaaaaaaaaa');
      expect(s.reason).toContain('bbbbbbbbbbbb');
    }
  });

  it('reports unprepared when there is no stored fingerprint', () => {
    expect(baseFreshnessFromFingerprints(undefined, 'abc123')).toEqual({ state: 'unprepared' });
  });

  it('reports unknown when the live fingerprint cannot be computed', () => {
    expect(baseFreshnessFromFingerprints('abc123', undefined)).toEqual({ state: 'unknown' });
  });

  it('prefers unprepared over unknown when both are absent', () => {
    expect(baseFreshnessFromFingerprints(undefined, undefined)).toEqual({ state: 'unprepared' });
  });
});
