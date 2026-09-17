import { describe, expect, it } from 'vitest';
import { CarryCopyError } from '../src/index.js';

/**
 * An approved `carry:` entry that failed to copy used to be a log line inside a
 * create that then reported success — the box came up without the file the block
 * exists to deliver. The providers now raise this instead, AFTER attempting the
 * whole list, so one bad entry doesn't hide the others.
 *
 * What is deliberately NOT in here: an optional source that is simply absent on
 * the host. That one is skipped by design and never reaches the failure list.
 */
describe('CarryCopyError', () => {
  it('names every failure, not just the first', () => {
    const err = new CarryCopyError([
      'carry[0] "./secret.env": permission denied',
      'carry[2] "./certs": exit code 1',
    ]);
    expect(err.name).toBe('CarryCopyError');
    expect(err.message).toContain('2 approved entries');
    expect(err.message).toContain('./secret.env');
    expect(err.message).toContain('./certs');
    expect(err.failures).toHaveLength(2);
  });

  it('reads as a singular for one failure', () => {
    const err = new CarryCopyError(['carry[0] "./a": nope']);
    expect(err.message).toContain('1 approved entry');
    expect(err instanceof Error).toBe(true);
  });
});
