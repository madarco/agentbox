import { describe, expect, it } from 'vitest';
import { setDefaultCheckpointRefusal, subscriptionOf } from '../lib/backend/accounts';
import { accountIdProblem } from '@agentbox/core';
import { ACCOUNT_ID_RE, parseCreateBox } from '../app/(dashboard)/api/v1/lib/validate';

describe('setDefaultCheckpointRefusal (#437-7)', () => {
  it('refuses a box on a named account, naming it', () => {
    expect(setDefaultCheckpointRefusal({ name: 'b1', accounts: { claude: 'work' } })).toMatch(
      /claude=work/,
    );
  });
  it('allows a default box (no or default-only accounts)', () => {
    expect(setDefaultCheckpointRefusal({ name: 'b1' })).toBeNull();
    expect(setDefaultCheckpointRefusal({ name: 'b1', accounts: { claude: 'default' } })).toBeNull();
  });
});

describe('opts.accounts on create (Phase 3)', () => {
  it('accepts { agent: account } and rejects a bad id', () => {
    const okRes = parseCreateBox({
      projectId: 'p1',
      provider: 'docker',
      agent: 'claude',
      opts: { accounts: { claude: 'work' } },
    });
    expect(okRes.ok && okRes.value.opts?.accounts).toEqual({ claude: 'work' });
    const bad = parseCreateBox({
      projectId: 'p1',
      provider: 'docker',
      agent: 'claude',
      opts: { accounts: { claude: 'Work Laptop' } },
    });
    expect(bad.ok).toBe(false);
  });
});

describe('the browser-safe account-id rule matches core', () => {
  it.each([
    'work',
    'a',
    'team-2',
    'x'.repeat(32),
    'x'.repeat(33),
    'Work',
    '-a',
    'a-',
    'a.b',
    'a/b',
    '',
  ])('%j', (id) => {
    expect(ACCOUNT_ID_RE.test(id)).toBe(accountIdProblem(id) === null);
  });
});

describe('subscriptionOf', () => {
  it("names the agent's own account, default when the box names none", () => {
    expect(subscriptionOf({}, 'claude')).toBe('claude/default');
    expect(subscriptionOf({ accounts: { claude: 'work' } }, 'claude')).toBe('claude/work');
  });

  it('counts a borrowed login under the lender', () => {
    expect(
      subscriptionOf(
        { borrowedCredentials: ['claude'], accounts: { claude: 'personal' } },
        'opencode',
      ),
    ).toBe('claude/personal');
    expect(subscriptionOf({ borrowedCredentials: ['codex'] }, 'pi')).toBe('codex/default');
  });

  it('ignores env: sources, which name no account', () => {
    expect(subscriptionOf({ borrowedCredentials: ['env:OPENAI_API_KEY'] }, 'pi')).toBe(
      'pi/default',
    );
  });
});
