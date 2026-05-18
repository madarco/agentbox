import { describe, expect, it } from 'vitest';
import { sanitizePaneTitle } from '../src/tmux.js';

describe('sanitizePaneTitle', () => {
  it('returns null for empty / whitespace-only', () => {
    expect(sanitizePaneTitle('', {})).toBeNull();
    expect(sanitizePaneTitle('   \n', {})).toBeNull();
  });

  it('returns null for the default tmux title (hostname / session / shell)', () => {
    expect(sanitizePaneTitle('agentbox-smoke', { hostname: 'agentbox-smoke' })).toBeNull();
    expect(sanitizePaneTitle('AGENTBOX-SMOKE', { hostname: 'agentbox-smoke' })).toBeNull();
    expect(sanitizePaneTitle('claude', { sessionName: 'claude' })).toBeNull();
    expect(sanitizePaneTitle('bash', {})).toBeNull();
    expect(sanitizePaneTitle('-zsh', {})).toBeNull();
  });

  it('returns a trimmed meaningful title', () => {
    expect(sanitizePaneTitle('  Fix login bug  ', { hostname: 'agentbox-x' })).toBe(
      'Fix login bug',
    );
  });

  it('hard-caps an over-long title at 120 chars', () => {
    const out = sanitizePaneTitle('y'.repeat(300), {});
    expect(out).toHaveLength(120);
  });
});
