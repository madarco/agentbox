import { describe, expect, it } from 'vitest';
import { parseAccountRef } from '../src/commands/accounts.js';

describe('parseAccountRef', () => {
  it('splits <agent>/<account>', () => {
    expect(parseAccountRef('claude/work')).toEqual({ agent: 'claude', id: 'work' });
  });
  it.each(['claude', '/work', 'claude/', 'claude/a/b', ''])('refuses %j', (ref) => {
    expect(() => parseAccountRef(ref)).toThrow(/<agent>\/<account>/);
  });
});
