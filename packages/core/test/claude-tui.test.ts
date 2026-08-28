import { describe, expect, it } from 'vitest';
import { claudeTuiEnv } from '../src/claude-tui.js';

/**
 * These two variable names are Claude Code's own, read off the shipped binary
 * (v2.1.250) — `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1 forces that any time`
 * and `/tui fullscreen or CLAUDE_CODE_NO_FLICKER=1 to override`. If a Claude
 * Code update renames them this test still passes and the box silently gets the
 * wrong renderer, so the real check is the live one in docs/test-plan.md.
 */
describe('claudeTuiEnv', () => {
  it('pins the classic renderer for `default`', () => {
    expect(claudeTuiEnv('default')).toEqual({ CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: '1' });
  });

  it('pins the fullscreen renderer for `fullscreen`', () => {
    expect(claudeTuiEnv('fullscreen')).toEqual({ CLAUDE_CODE_NO_FLICKER: '1' });
  });

  it('sets nothing for `auto`, leaving the choice to Claude Code', () => {
    expect(claudeTuiEnv('auto')).toEqual({});
  });

  it('never sets both — they contradict each other', () => {
    for (const mode of ['default', 'fullscreen', 'auto'] as const) {
      const env = claudeTuiEnv(mode);
      expect('CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN' in env && 'CLAUDE_CODE_NO_FLICKER' in env).toBe(
        false,
      );
    }
  });
});
