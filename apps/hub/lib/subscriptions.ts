// Subscription naming and grouping for the hub web (hub settings Phase 3a).
// A subscription is one named LLM account of one agent, keyed `agent/account`
// — the same key `GET /api/v1/usage` groups and filters by. Pure; shared by
// the Subscriptions and Usage pages.

export type AccountKind = 'login' | 'setup-token' | 'api-key';

export interface SubscriptionAccount {
  agent: string;
  id: string;
  label?: string;
  kind: AccountKind;
}

/** The company whose plan an agent's login spends. */
const VENDOR: Record<string, string> = { claude: 'Anthropic', codex: 'OpenAI' };

export function vendorOf(agent: string): string {
  return VENDOR[agent] ?? agent;
}

export function subscriptionKey(a: { agent: string; id: string }): string {
  return `${a.agent}/${a.id}`;
}

/** `Personal · Anthropic`; an API key says so, since it bills per token, not a plan. */
export function subscriptionLabel(a: SubscriptionAccount): string {
  const name = a.label ?? a.id;
  return a.kind === 'api-key'
    ? `${name} · ${vendorOf(a.agent)} API key`
    : `${name} · ${vendorOf(a.agent)}`;
}

/**
 * The label for a usage key, from the account list; a key with no stored
 * account (a default never captured, a removed one) reads as the key itself.
 */
export function usageKeyLabel(key: string, accounts: readonly SubscriptionAccount[]): string {
  const a = accounts.find((x) => subscriptionKey(x) === key);
  return a ? subscriptionLabel(a) : key;
}

export interface SubscriptionGroup<A extends SubscriptionAccount> {
  title: string;
  accounts: A[];
}

/**
 * The page's sections: one per vendor for logins and setup tokens (Anthropic,
 * OpenAI, then any other agent's), and API keys of every agent last. Empty
 * groups are dropped.
 */
export function groupSubscriptions<A extends SubscriptionAccount>(
  accounts: readonly A[],
): SubscriptionGroup<A>[] {
  const plans = new Map<string, A[]>();
  const keys: A[] = [];
  for (const a of accounts) {
    if (a.kind === 'api-key') {
      keys.push(a);
      continue;
    }
    const v = vendorOf(a.agent);
    plans.set(v, [...(plans.get(v) ?? []), a]);
  }
  const order = (v: string): number => {
    const i = Object.values(VENDOR).indexOf(v);
    return i >= 0 ? i : Object.keys(VENDOR).length;
  };
  const groups = [...plans.entries()]
    .sort(([x], [y]) => order(x) - order(y) || x.localeCompare(y))
    .map(([title, list]) => ({ title, accounts: list }));
  if (keys.length > 0) groups.push({ title: 'API keys', accounts: keys });
  return groups;
}
