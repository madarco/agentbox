import { describe, expect, it } from 'vitest';
import { NON_REGULAR_TOKEN, classifyUntrackedOverlay } from '../src/sync/concerns/git.js';

// Mirrors sandbox-docker/test/classify-untracked-overlay.test.ts exactly — the
// classifier moved here (docker now re-exports it), so identical cases on both
// sides prove the move is behavior-preserving.
describe('git concern — classifyUntrackedOverlay (box-wins content-hash)', () => {
  it('copies when the box has no file at the path', () => {
    expect(classifyUntrackedOverlay(undefined, 'abc123')).toBe('copy');
  });

  it('is a no-op when the box file is byte-identical to the host file', () => {
    // The bug this guards: identical files (seeded at create, then re-probed on
    // the immediate resync) must NOT count as conflicts.
    expect(classifyUntrackedOverlay('deadbeef', 'deadbeef')).toBe('identical');
  });

  it('conflicts when the box file differs from the host file', () => {
    expect(classifyUntrackedOverlay('deadbeef', 'cafe00')).toBe('conflict');
  });

  it('conflicts when the box path is a non-regular file (dir/symlink sentinel)', () => {
    // Never clobber a box dir/symlink, regardless of the host hash.
    expect(classifyUntrackedOverlay(NON_REGULAR_TOKEN, 'anything')).toBe('conflict');
    expect(classifyUntrackedOverlay('-', 'anything')).toBe('conflict');
  });
});
