'use client';

// The `?subscription=<agent>/<account>` filter both Usage views share. It lives
// in the URL so a Subscriptions card links straight to it and the sidebar's
// plain Usage link clears it.

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { subscriptionKey, subscriptionLabel, type SubscriptionAccount } from '@/lib/subscriptions';

/** Every subscription key with recorded usage, whatever the page's filters. */
async function fetchUsedSubscriptions(): Promise<string[]> {
  const r = await fetch('/api/v1/usage?by=account&limit=1000', { credentials: 'same-origin' });
  if (!r.ok) return [];
  const body = (await r.json()) as { groups?: Array<{ keys: { account?: string | null } }> };
  return (body.groups ?? []).flatMap((g) => (g.keys.account ? [g.keys.account] : []));
}

async function fetchAccounts(): Promise<SubscriptionAccount[]> {
  const r = await fetch('/api/v1/accounts', { credentials: 'same-origin' });
  if (!r.ok) return [];
  return ((await r.json()) as { accounts?: SubscriptionAccount[] }).accounts ?? [];
}

export interface SubscriptionFilter {
  subscription: string | undefined;
  setSubscription: (key: string | undefined) => void;
  /** `[key, label]`, sorted by label. */
  options: Array<[string, string]>;
  accounts: SubscriptionAccount[];
  /** The URL names a subscription this hub has no account and no usage for. */
  unknown: boolean;
}

export function useSubscriptionFilter(): SubscriptionFilter {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const subscription = params.get('subscription')?.trim() || undefined;
  // Null until loaded: an unknown subscription is only known once both are in.
  const [accounts, setAccounts] = useState<SubscriptionAccount[] | null>(null);
  const [usedKeys, setUsedKeys] = useState<string[] | null>(null);

  useEffect(() => {
    void fetchAccounts()
      .catch(() => [])
      .then(setAccounts);
    void fetchUsedSubscriptions()
      .catch(() => [])
      .then(setUsedKeys);
  }, []);

  const setSubscription = useCallback(
    (key: string | undefined) => {
      const q = new URLSearchParams(params.toString());
      if (key) q.set('subscription', key);
      else q.delete('subscription');
      const qs = q.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [params, pathname, router],
  );

  const known = useMemo(() => accounts ?? [], [accounts]);
  // Every stored account, plus keys that only have usage (a default never
  // captured here, a removed account) and the one in the URL.
  const options = useMemo(() => {
    const opts = new Map<string, string>(
      known.map((a) => [subscriptionKey(a), subscriptionLabel(a)]),
    );
    for (const k of usedKeys ?? []) if (!opts.has(k)) opts.set(k, k);
    if (subscription && !opts.has(subscription)) opts.set(subscription, subscription);
    return [...opts.entries()].sort(([, x], [, y]) => x.localeCompare(y));
  }, [known, usedKeys, subscription]);

  const unknown =
    subscription !== undefined &&
    accounts !== null &&
    usedKeys !== null &&
    !accounts.some((a) => subscriptionKey(a) === subscription) &&
    !usedKeys.includes(subscription);

  return { subscription, setSubscription, options, accounts: known, unknown };
}
