import { describe, expect, it } from 'vitest';
import {
  borrowingAgentIds,
  setDefaultCheckpointRefusal,
  subscriptionOf,
} from '../lib/backend/accounts';
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

  const specs = (agent: string) =>
    agent === 'claude'
      ? {}
      : {
          modelAuth: {
            sources: [
              { kind: 'agent' as const, agent: 'claude', label: 'Claude' },
              { kind: 'agent' as const, agent: 'codex', label: 'Codex' },
              { kind: 'env' as const, envKey: 'ANTHROPIC_API_KEY', label: 'Anthropic key' },
            ],
          },
        };

  it('counts a borrowed login under the lender', () => {
    expect(
      subscriptionOf(
        { borrowedCredentials: ['claude'], accounts: { claude: 'personal' } },
        'opencode',
        specs,
      ),
    ).toBe('claude/personal');
    expect(subscriptionOf({ borrowedCredentials: ['codex'] }, 'pi', specs)).toBe('codex/default');
  });

  it('keeps an agent that does not consume the borrowed login on its own', () => {
    // A box that borrows codex for pi, where claude runs on its own login.
    expect(
      subscriptionOf(
        { borrowedCredentials: ['codex'], accounts: { claude: 'work' } },
        'claude',
        specs,
      ),
    ).toBe('claude/work');
  });

  it('ignores env: sources, which name no account', () => {
    expect(subscriptionOf({ borrowedCredentials: ['env:OPENAI_API_KEY'] }, 'pi', specs)).toBe(
      'pi/default',
    );
  });

  it("stays on the agent's own key when the box mixes a lender with an env key", () => {
    expect(
      subscriptionOf(
        { borrowedCredentials: ['codex', 'env:ANTHROPIC_API_KEY'], accounts: { codex: 'team' } },
        'pi',
        specs,
      ),
    ).toBe('pi/default');
  });

  it("stays on the agent's own key with two lenders", () => {
    expect(
      subscriptionOf(
        { borrowedCredentials: ['claude', 'codex'], accounts: { pi: 'own' } },
        'pi',
        specs,
      ),
    ).toBe('pi/own');
  });

  it('ignores a source the agent does not declare when counting', () => {
    // env:OPENAI_API_KEY is some other agent's source in this box.
    expect(
      subscriptionOf({ borrowedCredentials: ['codex', 'env:OPENAI_API_KEY'] }, 'pi', specs),
    ).toBe('codex/default');
  });
});

describe('borrowingAgentIds', () => {
  it('lists the agents with an agent model-auth source', () => {
    expect(
      borrowingAgentIds([
        { id: 'claude' },
        { id: 'pi', modelAuth: { sources: [{ kind: 'agent', agent: 'codex', label: 'x' }] } },
        { id: 'k', modelAuth: { sources: [{ kind: 'env', envKey: 'K', label: 'k' }] } },
      ]),
    ).toEqual(['pi']);
    expect(borrowingAgentIds()).toContain('opencode');
  });
});
