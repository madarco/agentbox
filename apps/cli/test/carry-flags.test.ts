import { describe, expect, it } from 'vitest';
import { parseCarryMode, resolveCarryFlags } from '../src/lib/carry-gate.js';

/**
 * The two things that decide whether a human is shown the carry table. Pure, so
 * they are tested without a box (and without touching ~/.agentbox — this suite
 * has no HOME isolation).
 */
describe('parseCarryMode', () => {
  it('accepts the two modes and "no flag"', () => {
    expect(parseCarryMode(undefined)).toBeUndefined();
    expect(parseCarryMode('skip')).toBe('skip');
    expect(parseCarryMode('ask')).toBe('ask');
  });

  it('REFUSES an unknown mode rather than reading it as "no flag"', () => {
    // `--carry <mode>` has no commander default any more, so a typo would
    // otherwise be indistinguishable from omitting the flag — and fall straight
    // into the granted-silent path, copying host secrets with no prompt.
    expect(() => parseCarryMode('skpi')).toThrow(/expected 'skip' or 'ask'/);
    expect(() => parseCarryMode('')).toThrow(/expected 'skip' or 'ask'/);
    expect(() => parseCarryMode('yes')).toThrow(/expected 'skip' or 'ask'/);
  });
});

describe('resolveCarryFlags', () => {
  const env = (o: Record<string, string> = {}) => o as NodeJS.ProcessEnv;

  it('falls back to the env vars when no flag is given', () => {
    expect(resolveCarryFlags({ mode: undefined, env: env({ AGENTBOX_CARRY_YES: '1' }) })).toEqual({
      carryYes: true,
      carrySkip: false,
      carryAsk: false,
    });
    expect(resolveCarryFlags({ mode: undefined, env: env({ AGENTBOX_CARRY: 'skip' }) })).toEqual({
      carryYes: false,
      carrySkip: true,
      carryAsk: false,
    });
  });

  it('lets --carry ask beat BOTH env bypasses', () => {
    // CLI > env: asking to review the list must not be silently skipped by an
    // env var set for some other run.
    expect(
      resolveCarryFlags({
        mode: 'ask',
        carryYesFlag: true,
        env: env({ AGENTBOX_CARRY: 'skip', AGENTBOX_CARRY_YES: '1' }),
      }),
    ).toEqual({ carryYes: false, carrySkip: false, carryAsk: true });
  });

  it('--carry skip skips, with or without the env var', () => {
    expect(resolveCarryFlags({ mode: 'skip', env: env() }).carrySkip).toBe(true);
  });
});
