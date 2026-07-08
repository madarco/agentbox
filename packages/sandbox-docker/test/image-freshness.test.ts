import { describe, expect, it } from 'vitest';
import { classifyDockerBaseFreshness } from '../src/image.js';

// Must mirror ensureImage()'s rebuild predicate: these cases map 1:1 onto its
// reason branches so the announced freshness never disagrees with what a
// create would actually do.
describe('classifyDockerBaseFreshness', () => {
  const sha = 'a'.repeat(64);
  const other = 'b'.repeat(64);

  it('unprepared when the image is missing', () => {
    expect(
      classifyDockerBaseFreshness({ imagePresent: false, fingerprint: sha, stampedSha: sha }),
    ).toEqual({ state: 'unprepared' });
  });

  it('unknown (inert) when the context cannot be fingerprinted', () => {
    expect(
      classifyDockerBaseFreshness({ imagePresent: true, fingerprint: null, stampedSha: sha }),
    ).toEqual({ state: 'unknown' });
  });

  it('stale when no prepared stamp exists', () => {
    expect(
      classifyDockerBaseFreshness({ imagePresent: true, fingerprint: sha, stampedSha: null }),
    ).toEqual({ state: 'stale', reason: 'no docker-prepared.json on disk' });
  });

  it('stale with both short fingerprints when the context changed', () => {
    const res = classifyDockerBaseFreshness({
      imagePresent: true,
      fingerprint: sha,
      stampedSha: other,
    });
    expect(res.state).toBe('stale');
    expect(res.state === 'stale' && res.reason).toBe(
      `build context changed (was ${other.slice(0, 12)}, now ${sha.slice(0, 12)})`,
    );
  });

  it('fresh when the stamp matches the live fingerprint', () => {
    expect(
      classifyDockerBaseFreshness({ imagePresent: true, fingerprint: sha, stampedSha: sha }),
    ).toEqual({ state: 'fresh' });
  });
});
