import { describe, expect, it } from 'vitest';
import type { ResyncResult } from '@agentbox/core';
import { buildResyncWarning, prependResyncWarning } from '../src/lib/resync-warning.js';

describe('buildResyncWarning', () => {
  it('returns null when there were no conflicts', () => {
    const r: ResyncResult = {
      repos: [{ containerPath: '/workspace', mergeConflicts: [], overlaySkipped: [] }],
      hadConflicts: false,
    };
    expect(buildResyncWarning(r)).toBeNull();
  });

  it('lists conflicted + skipped paths repo-relative, deduped', () => {
    const r: ResyncResult = {
      repos: [
        { containerPath: '/workspace', mergeConflicts: ['src/a.ts'], overlaySkipped: ['src/a.ts', '.env'] },
        { containerPath: '/workspace/api', mergeConflicts: ['main.go'], overlaySkipped: [] },
      ],
      hadConflicts: true,
    };
    const w = buildResyncWarning(r);
    expect(w).not.toBeNull();
    expect(w).toContain('  - src/a.ts');
    expect(w).toContain('  - .env');
    expect(w).toContain('  - api/main.go'); // nested repo path qualified
    // deduped: src/a.ts appears once even though it's in two lists
    expect(w!.match(/- src\/a\.ts/g)).toHaveLength(1);
  });

  it('returns null when hadConflicts is true but no paths were recorded', () => {
    const r: ResyncResult = { repos: [], hadConflicts: true };
    expect(buildResyncWarning(r)).toBeNull();
  });
});

describe('prependResyncWarning', () => {
  it('returns the prompt unchanged when there is no warning', () => {
    expect(prependResyncWarning(null, 'do the thing')).toBe('do the thing');
  });

  it('returns just the warning when the prompt is empty', () => {
    expect(prependResyncWarning('heads up', '')).toBe('heads up');
  });

  it('prepends the warning above the prompt', () => {
    expect(prependResyncWarning('heads up', 'do it')).toBe('heads up\n\ndo it');
  });
});
