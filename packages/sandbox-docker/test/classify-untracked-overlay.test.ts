import { describe, expect, it } from 'vitest';
import { classifyUntrackedOverlay } from '../src/in-box-git.js';

describe('classifyUntrackedOverlay', () => {
  it('copies when the box has no file at the path', () => {
    expect(classifyUntrackedOverlay(undefined, 'abc123')).toBe('copy');
  });

  it('is a no-op when the box file is byte-identical to the host file', () => {
    // The bug we fixed: identical files (e.g. seeded at create then re-probed on
    // the immediate resync) must NOT count as conflicts.
    expect(classifyUntrackedOverlay('deadbeef', 'deadbeef')).toBe('identical');
  });

  it('conflicts when the box file differs from the host file', () => {
    expect(classifyUntrackedOverlay('deadbeef', 'cafe00')).toBe('conflict');
  });

  it('conflicts when the box path is a non-regular file (dir/symlink sentinel)', () => {
    // Never clobber a box dir/symlink, regardless of the host hash.
    expect(classifyUntrackedOverlay('-', 'anything')).toBe('conflict');
  });
});
