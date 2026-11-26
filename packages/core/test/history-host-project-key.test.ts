import { describe, expect, it } from 'vitest';
import { hostProjectKey } from '../src/history/memory.js';

describe('hostProjectKey (dashed-path)', () => {
  it('dashes every non-alphanumeric char', () => {
    expect(hostProjectKey('dashed-path', '/Users/me/my.app')).toBe('-Users-me-my-app');
  });

  it('matches the folder Claude Code created for a 273-char path', () => {
    const p = `/home/vscode/${Array.from(
      { length: 9 },
      (_, i) => `segment-number-${String(i).padStart(2, '0')}-abcdefghij`,
    ).join('/')}`;
    expect(p.length).toBe(273);
    // `ls ~/.claude/projects` after `claude -p` in that folder (Claude Code 2.1.326).
    expect(hostProjectKey('dashed-path', p)).toBe(
      '-home-vscode-segment-number-00-abcdefghij-segment-number-01-abcdefghij-segment-number-02-abcdefghij-segment-number-03-abcdefghij-segment-number-04-abcdefghij-segment-number-05-abcdefghij-segment-numbe-h3nr1k',
    );
  });

  it('keeps a key of exactly 200 chars whole', () => {
    const p = `/${'a'.repeat(199)}`;
    expect(hostProjectKey('dashed-path', p)).toBe(`-${'a'.repeat(199)}`);
  });
});
