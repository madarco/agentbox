import { describe, expect, it } from 'vitest';
import {
  groupSubscriptions,
  subscriptionLabel,
  usageKeyLabel,
  type SubscriptionAccount,
} from '../lib/subscriptions';

const acc = (agent: string, id: string, kind: SubscriptionAccount['kind'], label?: string) => ({
  agent,
  id,
  kind,
  ...(label ? { label } : {}),
});

describe('subscriptions', () => {
  it('groups logins by vendor (Anthropic, OpenAI, others) and API keys last', () => {
    const groups = groupSubscriptions([
      acc('pi', 'k', 'api-key'),
      acc('codex', 'default', 'login'),
      acc('opencode', 'x', 'setup-token'),
      acc('claude', 'ci', 'setup-token'),
      acc('claude', 'default', 'login'),
    ]);
    expect(groups.map((g) => [g.title, g.accounts.map((a) => `${a.agent}/${a.id}`)])).toEqual([
      ['Anthropic', ['claude/ci', 'claude/default']],
      ['OpenAI', ['codex/default']],
      ['opencode', ['opencode/x']],
      ['API keys', ['pi/k']],
    ]);
    expect(groupSubscriptions([])).toEqual([]);
  });

  it('labels a subscription like the cards, and an unknown usage key as itself', () => {
    const list = [acc('claude', 'personal', 'login', 'Personal'), acc('codex', 'k', 'api-key')];
    expect(subscriptionLabel(list[0]!)).toBe('Personal · Anthropic');
    expect(subscriptionLabel(list[1]!)).toBe('k · OpenAI API key');
    expect(usageKeyLabel('claude/personal', list)).toBe('Personal · Anthropic');
    expect(usageKeyLabel('pi/default', list)).toBe('pi/default');
  });
});
