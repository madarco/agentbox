import { describe, expect, it } from 'vitest';
import { matchWaiting } from '../src/claude-scraper.js';

// A real Claude plan-approval frame (bottom of the pane).
const PLAN_FRAME = `
 Claude has written up a plan and is ready to execute. Would you like to
 proceed?

 ❯ 1. Yes, and use auto mode
   2. Yes, manually approve edits
   3. No, refine
`;

// A generic tool-permission frame.
const PERMISSION_FRAME = `
 Do you want to proceed?

 ❯ 1. Yes
   2. Yes, and don't ask again
   3. No, and tell Claude what to do differently
`;

// A normal mid-generation frame — the interrupt hint means "working".
const WORKING_FRAME = `
● Reading server.js to find the health route…

✻ Sautéed for 12s · esc to interrupt
`;

describe('matchWaiting (claude pane safety net)', () => {
  it('matches a plan-approval frame', () => {
    expect(matchWaiting(PLAN_FRAME)).toBe(true);
  });

  it('matches a tool-permission frame', () => {
    expect(matchWaiting(PERMISSION_FRAME)).toBe(true);
  });

  it('matches an MCP trust dialog', () => {
    expect(matchWaiting('\n A server wants to use the read_file tool.\n ❯ 1. Allow\n')).toBe(true);
  });

  it('does NOT match a mid-generation frame (interrupt hint = working)', () => {
    expect(matchWaiting(WORKING_FRAME)).toBe(false);
  });

  it('does NOT match ordinary streamed prose', () => {
    expect(matchWaiting('● Here is how the function works, step by step:\n1. parse\n2. render\n')).toBe(
      false,
    );
  });

  it('only looks at the bottom region (an answered prompt scrolled up is ignored)', () => {
    const old = '❯ 1. Yes\n' + 'output line\n'.repeat(40);
    expect(matchWaiting(old)).toBe(false);
  });

  it('working guard wins even when a stale prompt sits in the bottom region', () => {
    const mixed = '❯ 1. Yes, and use auto mode\n● working…\n✻ esc to interrupt\n';
    expect(matchWaiting(mixed)).toBe(false);
  });
});
