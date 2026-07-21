import { describe, expect, it } from 'vitest';
import { boxDirSegment, boxRunDirFor } from '../src/sync/host-export.js';
import { snapshotPathFor } from '../src/snapshot.js';

describe('boxDirSegment', () => {
  it('includes the project index when set: <id>-<n>-<mnemonic>', () => {
    expect(boxDirSegment({ id: 'aabbccdd', name: 'smoke', projectIndex: 1 })).toBe(
      'aabbccdd-1-smoke',
    );
    expect(boxDirSegment({ id: 'aabbccdd', name: 'smoke', projectIndex: 42 })).toBe(
      'aabbccdd-42-smoke',
    );
  });

  it('falls back to <id>-<mnemonic> for legacy boxes (no projectIndex)', () => {
    expect(boxDirSegment({ id: 'aabbccdd', name: 'smoke' })).toBe('aabbccdd-smoke');
  });

  it('ignores invalid projectIndex values (NaN, 0, negative, non-integer)', () => {
    expect(boxDirSegment({ id: 'aabbccdd', name: 'smoke', projectIndex: 0 })).toBe(
      'aabbccdd-smoke',
    );
    expect(boxDirSegment({ id: 'aabbccdd', name: 'smoke', projectIndex: -3 })).toBe(
      'aabbccdd-smoke',
    );
    expect(boxDirSegment({ id: 'aabbccdd', name: 'smoke', projectIndex: NaN })).toBe(
      'aabbccdd-smoke',
    );
  });

  it('sanitizes the name (drops dashes, lowercases) regardless of N', () => {
    // The default-name shape carries the id; sanitization converts `-` to `_`
    // so the segment retains exactly one `-` between id and mnemonic, and one
    // more before N when present.
    expect(boxDirSegment({ id: 'aabbccdd', name: 'My-Box', projectIndex: 2 })).toBe(
      'aabbccdd-2-my_box',
    );
  });
});

describe('boxRunDirFor + snapshotPathFor', () => {
  it('produce paths under their respective roots with the same segment shape', () => {
    const box = { id: 'aabbccdd', name: 'smoke', projectIndex: 3 };
    const runDir = boxRunDirFor(box);
    const snapDir = snapshotPathFor(box);
    expect(runDir.endsWith('/.agentbox/boxes/aabbccdd-3-smoke')).toBe(true);
    expect(snapDir.endsWith('/.agentbox/snapshots/aabbccdd-3-smoke')).toBe(true);
  });

  it('share the legacy fallback when projectIndex is absent', () => {
    const box = { id: 'aabbccdd', name: 'smoke' };
    expect(boxRunDirFor(box).endsWith('/.agentbox/boxes/aabbccdd-smoke')).toBe(true);
    expect(snapshotPathFor(box).endsWith('/.agentbox/snapshots/aabbccdd-smoke')).toBe(true);
  });
});
