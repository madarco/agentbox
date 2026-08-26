import { describe, expect, it } from 'vitest';
import { decideDestroy } from '../src/commands/destroy.js';

/**
 * The core safety invariant of `agentbox destroy` (which-hub, Step 5): this
 * machine's local box record is dropped ONLY when a hub actually reaped the box,
 * or the user forced it. A bare `not-found` (the box belongs to no hub AgentBox
 * knows — e.g. a docker box whose destroy hit a configured remote hub that never
 * owned it) must NEVER drop the record: that would delete the only handle to a
 * possibly-still-running container/VM. This is the regression Bugbot flagged.
 */
describe('decideDestroy', () => {
  it('reaped -> cleanup (a hub tore the box down)', () => {
    expect(decideDestroy('reaped', false)).toBe('reap-cleanup');
    expect(decideDestroy('reaped', true)).toBe('reap-cleanup');
  });

  it('not-found without --force -> refuse (KEEP the record; the resource may still run)', () => {
    expect(decideDestroy('not-found', false)).toBe('refused');
  });

  it('not-found with --force -> drop the record deliberately', () => {
    expect(decideDestroy('not-found', true)).toBe('force-cleanup');
  });

  it('undefined (hub error, exit code already set) -> abort without touching the record', () => {
    expect(decideDestroy(undefined, false)).toBe('aborted');
    expect(decideDestroy(undefined, true)).toBe('aborted');
  });

  it('the record is dropped in exactly the reaped and force cases, never on a bare not-found', () => {
    const drops = (o: 'reaped' | 'not-found' | undefined, f: boolean): boolean => {
      const d = decideDestroy(o, f);
      return d === 'reap-cleanup' || d === 'force-cleanup';
    };
    expect(drops('reaped', false)).toBe(true);
    expect(drops('not-found', false)).toBe(false); // <- the safety property
    expect(drops('not-found', true)).toBe(true);
    expect(drops(undefined, false)).toBe(false);
  });
});
