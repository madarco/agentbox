import { describe, expect, it } from 'vitest';
import { describeSessionAccount, sessionAccountMismatch } from '../src/cli/login-session.js';

/**
 * A pending headless session is bound to one account. Its worker writes the
 * shared volume + legacy backup + custody (default) or a named account's own
 * volume, so a code for another account must never reach it (review #433-1).
 */
describe('sessionAccountMismatch', () => {
  it('allows the same account, default included', () => {
    expect(sessionAccountMismatch(undefined, undefined)).toBeNull();
    expect(sessionAccountMismatch({ id: 'work' }, { id: 'work' })).toBeNull();
  });

  it('refuses a named login against a pending default session', () => {
    const msg = sessionAccountMismatch(undefined, { id: 'work' });
    expect(msg).toContain('the default account');
    expect(msg).toContain("account 'work'");
    expect(msg).toContain('`agentbox claude login --code <CODE>`');
  });

  it('refuses a default login against a pending named session, naming how to finish it', () => {
    const msg = sessionAccountMismatch({ id: 'work' }, undefined);
    expect(msg).toMatch(/pending headless login is for account 'work', not the default account/);
    expect(msg).toContain('agentbox credentials add claude/work --login --code <CODE>');
  });

  it('refuses two different named accounts', () => {
    expect(sessionAccountMismatch({ id: 'a' }, { id: 'b' })).toMatch(
      /account 'a', not account 'b'/,
    );
  });
});

describe('describeSessionAccount', () => {
  it('names the account', () => {
    expect(describeSessionAccount(undefined)).toBe('the default account');
    expect(describeSessionAccount({ id: 'work' })).toBe("account 'work'");
  });
});
