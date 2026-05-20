import { describe, expect, it } from 'vitest';
import { projectDirSegment, sanitizeMnemonic } from '../src/paths.js';

describe('sanitizeMnemonic', () => {
  it('collapses `-` to `_` so the dir name has exactly one `-` between hash and mnemonic', () => {
    expect(sanitizeMnemonic('foo-bar')).toBe('foo_bar');
  });

  it('lowercases and folds non-safe chars into `_`', () => {
    expect(sanitizeMnemonic('My Project!')).toBe('my_project');
  });

  it('collapses repeats and trims surrounding `_`', () => {
    expect(sanitizeMnemonic('___a---b___')).toBe('a_b');
  });

  it('falls back to "unnamed" when nothing survives', () => {
    expect(sanitizeMnemonic('@@@')).toBe('unnamed');
    expect(sanitizeMnemonic('')).toBe('unnamed');
  });

  it('caps length at 32 chars and never leaves a trailing `_`', () => {
    const out = sanitizeMnemonic('a'.repeat(40));
    expect(out.length).toBeLessThanOrEqual(32);
    expect(out).not.toMatch(/_$/);
  });
});

describe('projectDirSegment', () => {
  it('is `<sha1-16>-<mnemonic>`', () => {
    const seg = projectDirSegment('/Users/marco/Projects/AgentBox/agentbox');
    expect(seg).toMatch(/^[0-9a-f]{16}-agentbox$/);
  });

  it('preserves the hash when the basename collapses to the fallback', () => {
    const seg = projectDirSegment('/tmp/@@@');
    expect(seg).toMatch(/^[0-9a-f]{16}-unnamed$/);
  });
});
