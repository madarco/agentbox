import { describe, expect, it } from 'vitest';
import {
  CHECKPOINT_IMAGE_PREFIX,
  checkpointImageTag,
  computeNextCheckpointName,
} from '../src/checkpoint.js';

describe('checkpoint helpers', () => {
  describe('checkpointImageTag', () => {
    it('builds an image tag from project root + checkpoint name', () => {
      const tag = checkpointImageTag('/Users/x/proj', 'demo-1');
      expect(tag.startsWith(CHECKPOINT_IMAGE_PREFIX)).toBe(true);
      expect(tag).toMatch(/^agentbox-ckpt-[0-9a-f]{16}:demo-1$/);
    });

    it('is deterministic per project root', () => {
      const a = checkpointImageTag('/Users/x/proj', 'one');
      const b = checkpointImageTag('/Users/x/proj', 'one');
      expect(a).toBe(b);
    });

    it('different project roots produce different image repos but same tag', () => {
      const [a, b] = [
        checkpointImageTag('/Users/x/proj', 'demo'),
        checkpointImageTag('/Users/x/other', 'demo'),
      ];
      const [repoA, nameA] = a.split(':');
      const [repoB, nameB] = b.split(':');
      expect(repoA).not.toBe(repoB);
      expect(nameA).toBe(nameB);
    });
  });

  describe('computeNextCheckpointName', () => {
    it('starts at -1 when nothing exists for the box name', () => {
      expect(computeNextCheckpointName([], 'demo')).toBe('demo-1');
      expect(computeNextCheckpointName(['other-1', 'other-2'], 'demo')).toBe('demo-1');
    });

    it('returns max+1 (gaps never recycled)', () => {
      expect(computeNextCheckpointName(['demo-1', 'demo-2', 'demo-3'], 'demo')).toBe('demo-4');
      // Gap from a deleted demo-2 still bumps past the surviving max.
      expect(computeNextCheckpointName(['demo-1', 'demo-3'], 'demo')).toBe('demo-4');
    });

    it('escapes regex metacharacters in the box name', () => {
      // A box named like `dot.demo` must not accidentally match `dotXdemo-1`.
      expect(computeNextCheckpointName(['dot.demo-7', 'dotXdemo-9'], 'dot.demo')).toBe('dot.demo-8');
    });
  });
});
