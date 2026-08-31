import { describe, expect, it } from 'vitest';
import { AGENT_SPECS } from '../src/index.js';

const claude = AGENT_SPECS.find((s) => s.id === 'claude');
const tui = (mode: string): Record<string, string> => ({ ...(claude?.tuiEnv?.[mode] ?? {}) });

/**
 * These two variable names are Claude Code's own, read off the shipped binary
 * (v2.1.250) — `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1 forces that any time`
 * and `/tui fullscreen or CLAUDE_CODE_NO_FLICKER=1 to override`. If a Claude
 * Code update renames them this test still passes and the box silently gets the
 * wrong renderer, so the real check is the live one in docs/test-plan.md.
 *
 * Was `claudeTuiEnv` in `@agentbox/core`. The env is registry data now, so the
 * test reads the row — which is also what the launch sites do.
 */
describe("claude's tuiEnv row", () => {
  it('pins the classic renderer for `default`', () => {
    expect(tui('default')).toEqual({ CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: '1' });
  });

  it('pins the fullscreen renderer for `fullscreen`', () => {
    expect(tui('fullscreen')).toEqual({ CLAUDE_CODE_NO_FLICKER: '1' });
  });

  it('sets nothing for `auto`, leaving the choice to Claude Code', () => {
    expect(tui('auto')).toEqual({});
  });

  it('never sets both — they contradict each other', () => {
    for (const mode of ['default', 'fullscreen', 'auto']) {
      const env = tui(mode);
      expect('CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN' in env && 'CLAUDE_CODE_NO_FLICKER' in env).toBe(
        false,
      );
    }
  });

  it('is the only agent that declares one', () => {
    // Not a rule — if another agent needs a renderer pin it adds a row and this
    // updates. It records that the `binary === 'claude'` branch the launch sites
    // used to carry is now a fact about DATA, and would have to be re-earned.
    expect(AGENT_SPECS.filter((s) => s.tuiEnv).map((s) => s.id)).toEqual(['claude']);
  });
});
