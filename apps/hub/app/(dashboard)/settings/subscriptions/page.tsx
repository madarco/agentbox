'use client';

// Subscriptions page (Settings → Subscriptions) — the named LLM accounts of this hub's machine (logins, setup
// tokens, API keys per agent; docs/llm-accounts-plan.md, Phase 5). PURE REST
// CLIENT over /api/v1/accounts: list, add a pasted key or setup token, remove.
// Both adds open in a dialog (add-account-dialogs.tsx); the page itself holds no form.
// A login is signed in (added or renewed) from here through the hub's own
// sign-in (`…/login`, SignInDialog). No secret ever comes back from the API. Each card shows
// one meter per plan-limit window the account reports (hub settings 3b,
// design: control-shadcn/views-env.jsx SubscriptionsPane).

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Icons } from '@/components/icons';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { SubMark, SubMeters, TierBadge, subLine, subName } from '@/components/subscription-meters';
import {
  accountsApi as api,
  refreshAccounts,
  resetText,
  useAccounts,
  type Account,
} from '@/lib/accounts-client';
import { groupSubscriptions, subscriptionKey } from '@/lib/subscriptions';
import { useStore } from '@/lib/boxes/store';
import { cn } from '@/lib/utils';
import { EmptyBox } from '../../boxes/components/empty-box';
import { SectionLabel } from '../../boxes/components/section-label';
import { AddKeyDialog, NewLoginDialog } from './add-account-dialogs';
import { SignInDialog } from './sign-in-dialog';

const enc = (a: Account): string => `/${encodeURIComponent(a.agent)}/${encodeURIComponent(a.id)}`;

function fmtTokens(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k`;
  return String(n);
}

/** Tokens per subscription over the last 7 days, keyed `agent/account`; null = history off. */
async function loadWeekTokens(): Promise<Map<string, number> | null> {
  const r = await fetch('/api/v1/usage?by=account&since=7d&limit=1000', {
    credentials: 'same-origin',
  });
  if (!r.ok) return null;
  const body = (await r.json()) as {
    groups: Array<{ keys: { account?: string | null }; totalTokens: number }>;
  };
  const m = new Map<string, number>();
  for (const g of body.groups) if (g.keys.account) m.set(g.keys.account, g.totalTokens);
  return m;
}

export default function SubscriptionsPage() {
  const { accounts, agents, error, storeError } = useAccounts();
  const [weekTokens, setWeekTokens] = useState<Map<string, number> | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  // The add dialog open, and the sign-in in progress (add or renew).
  const [adding, setAdding] = useState<'login' | 'key' | null>(null);
  const [signIn, setSignIn] = useState<{
    agent: string;
    account: string;
    mode: 'add' | 'renew';
  } | null>(null);
  const { state: hub } = useStore();
  const onSignedIn = useCallback(() => void refreshAccounts(), []);
  /** A box's detail page from the name the evidence carries, when the hub knows it. */
  const boxHref = (name: string): string | undefined => {
    const b = hub.boxes.find((x) => x.name === name || x.id === name);
    return b ? `/boxes/${encodeURIComponent(b.id)}` : undefined;
  };

  // Usage is a side fact: the cards render without it.
  useEffect(() => {
    void loadWeekTokens()
      .catch(() => null)
      .then(setWeekTokens);
  }, []);
  const load = refreshAccounts;

  const pastedAgents = agents.filter((a) => a.kinds.some((k) => k !== 'login'));
  const loginAgents = agents.filter((a) => a.kinds.includes('login'));

  const act = async (key: string, fn: () => Promise<unknown>): Promise<void> => {
    setBusy(key);
    setActionError(null);
    try {
      await fn();
      await load();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const remove = (a: Account) =>
    act(`rm:${a.agent}/${a.id}`, async () => {
      await api(enc(a), { method: 'DELETE' });
      setConfirmRemove(null);
    });

  // The global default for new boxes (`<agent>.account`); `default` clears the
  // setting, so the agent's own login is the default again.
  const makeDefault = (a: Account) =>
    act(`default:${a.agent}/${a.id}`, () =>
      api('/default', {
        method: 'PUT',
        body: JSON.stringify({
          agent: a.agent,
          account: a.id === 'default' ? null : a.id,
          scope: 'global',
        }),
      }),
    );

  return (
    <div className="mx-auto w-full max-w-[1080px] px-8 pb-16 pt-8 max-sm:px-4">
      <div className="flex items-start gap-4 max-md:flex-col">
        <div className="min-w-0 flex-1">
          <h1 className="text-[25px] font-semibold leading-tight tracking-[-0.025em]">
            Subscriptions
          </h1>
          <div className="mt-1.5 text-sm text-muted-foreground">
            The plans and keys boxes run on: several logins, setup tokens or API keys per agent.
            Choose one when you create a box; <span className="font-mono">default</span> is the
            agent&apos;s plain login. A box that borrows another agent&apos;s login counts under
            that login.
          </div>
        </div>
        {accounts ? (
          <div className="flex flex-none flex-wrap items-center gap-2 pt-1">
            <Button
              size="sm"
              variant="outline"
              disabled={pastedAgents.length === 0 || busy !== null}
              title={pastedAgents.length === 0 ? 'No agent here takes a pasted account' : undefined}
              onClick={() => setAdding('key')}
            >
              <Icons.plus /> Add a setup token or API key
            </Button>
            <Button
              size="sm"
              disabled={loginAgents.length === 0 || busy !== null || signIn !== null}
              title={loginAgents.length === 0 ? 'No agent here takes a login account' : undefined}
              onClick={() => setAdding('login')}
            >
              <Icons.key /> Sign in with a new account
            </Button>
          </div>
        ) : null}
      </div>

      {error ? (
        <div className="mt-6">
          <EmptyBox>
            <div>Couldn’t load accounts.</div>
            <div className="mt-1.5 font-mono text-xs text-red-400">{error}</div>
          </EmptyBox>
        </div>
      ) : !accounts ? (
        <div className="mt-8 text-sm text-muted-foreground">Loading…</div>
      ) : (
        <>
          {actionError ? (
            <div className="mt-4 font-mono text-xs text-red-400">{actionError}</div>
          ) : null}
          {storeError ? (
            <div className="mt-4 font-mono text-xs text-amber-400">
              {storeError}. Only the default logins are listed.
            </div>
          ) : null}

          {accounts.length === 0 ? (
            <>
              <SectionLabel>On this machine</SectionLabel>
              <EmptyBox>
                <div>No accounts yet.</div>
                <div className="mt-1.5 font-mono text-xs text-muted-foreground">
                  Sign in with `agentbox claude login`, or add a named one with the buttons above.
                </div>
              </EmptyBox>
            </>
          ) : (
            groupSubscriptions(accounts).map((g) => (
              <div key={g.title}>
                <SectionLabel
                  right={
                    <span className="font-mono text-[11px] normal-case tracking-normal text-[var(--faint)]">
                      {g.title === 'API keys'
                        ? 'pay as you go'
                        : `${String(g.accounts.length)} ${g.accounts.length === 1 ? 'account' : 'accounts'}`}
                    </span>
                  }
                >
                  {g.title}
                </SectionLabel>
                <div className="flex flex-col gap-2.5">
                  {g.accounts.map((a) => (
                    <SubscriptionCard
                      key={subscriptionKey(a)}
                      account={a}
                      weekTokens={weekTokens?.get(subscriptionKey(a))}
                      weekLoaded={weekTokens !== null}
                      busy={busy !== null}
                      confirming={confirmRemove === subscriptionKey(a)}
                      boxHref={boxHref}
                      onRenew={
                        a.kind === 'login'
                          ? () => setSignIn({ agent: a.agent, account: a.id, mode: 'renew' })
                          : undefined
                      }
                      onMakeDefault={
                        agents.some((x) => x.id === a.agent) ? () => void makeDefault(a) : undefined
                      }
                      onAskRemove={() => setConfirmRemove(subscriptionKey(a))}
                      onKeep={() => setConfirmRemove(null)}
                      onRemove={() => void remove(a)}
                    />
                  ))}
                </div>
              </div>
            ))
          )}
        </>
      )}
      {adding === 'login' && accounts ? (
        <NewLoginDialog
          agents={loginAgents}
          accounts={accounts}
          onClose={() => setAdding(null)}
          onSignIn={(agent, account) => {
            setAdding(null);
            setSignIn({ agent, account, mode: 'add' });
          }}
        />
      ) : null}
      {adding === 'key' && accounts ? (
        <AddKeyDialog
          agents={pastedAgents}
          accounts={accounts}
          onClose={() => setAdding(null)}
          onAdded={() => {
            setAdding(null);
            void load();
          }}
        />
      ) : null}
      {signIn ? (
        <SignInDialog
          key={`${signIn.agent}/${signIn.account}`}
          agent={signIn.agent}
          account={signIn.account}
          mode={signIn.mode}
          onClose={() => {
            setSignIn(null);
            void refreshAccounts();
          }}
          onFinished={onSignedIn}
        />
      ) : null}
    </div>
  );
}

function SubscriptionCard({
  account: a,
  weekTokens,
  weekLoaded,
  busy,
  confirming,
  boxHref,
  onRenew,
  onMakeDefault,
  onAskRemove,
  onKeep,
  onRemove,
}: {
  account: Account;
  weekTokens: number | undefined;
  weekLoaded: boolean;
  busy: boolean;
  confirming: boolean;
  boxHref: (name: string) => string | undefined;
  /** A login's sign-in again (absent for a pasted kind). */
  onRenew: (() => void) | undefined;
  /** Absent for an agent with no `<agent>.account` setting. */
  onMakeDefault: (() => void) | undefined;
  onAskRemove: () => void;
  onKeep: () => void;
  onRemove: () => void;
}) {
  const key = subscriptionKey(a);
  const named = a.id !== 'default';
  const n = a.boxes.length;
  const atLimit = a.limits?.atLimit === true;
  const revoked = a.auth?.state === 'revoked';
  const failingHref = revoked && a.auth?.box ? boxHref(a.auth.box) : undefined;
  // The first window to reset that is full, for the at-limit note.
  const reset = resetText(
    a.limits?.windows
      .filter((w) => w.pct >= 100 && w.resetsAt)
      .map((w) => w.resetsAt!)
      .sort()[0],
  );
  return (
    <Card
      className={cn(
        'p-4',
        atLimit && 'border-[var(--amber-line)]',
        revoked && 'border-[var(--red-line)]',
      )}
    >
      <div className="flex items-center gap-3 max-sm:flex-wrap">
        <SubMark account={a} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-[13.5px] font-semibold">
            <span className="truncate">{subName(a)}</span>
            <TierBadge account={a} />
            {a.default?.global ? (
              <Badge
                className="px-1.5 py-0 text-[10.5px]"
                title={`New ${a.agent} boxes use this account unless a project picks another`}
              >
                Default
              </Badge>
            ) : null}
            {a.hasSecret ? null : <Badge className="px-1.5 py-0 text-[10.5px]">no secret</Badge>}
            {revoked ? (
              <Badge
                className="badge-err px-1.5 py-0 text-[10.5px]"
                title={a.auth?.detail ?? 'The login was refused; sign it in again'}
              >
                Revoked
              </Badge>
            ) : a.auth?.state === 'expiring' ? (
              <Badge
                className="badge-warn px-1.5 py-0 text-[10.5px]"
                title={
                  a.auth.since
                    ? `Expires ${new Date(a.auth.since).toLocaleDateString()}`
                    : undefined
                }
              >
                Expiring
              </Badge>
            ) : null}
          </div>
          <div className="mt-0.5 truncate font-mono text-[11.5px] text-muted-foreground">
            {subLine(a)}
          </div>
        </div>
        <div className="flex flex-none items-center gap-2.5">
          <span
            className="font-mono text-[11.5px] text-muted-foreground"
            title={a.boxes.join(', ') || undefined}
          >
            {n ? `${String(n)} ${n === 1 ? 'box' : 'boxes'}` : 'no boxes'}
          </span>
          {a.limits ? (
            <Badge className={atLimit ? 'badge-pause' : 'badge-run'}>
              <span className="badge-dot" style={{ animation: 'none' }} />
              {atLimit ? 'at limit' : 'ok'}
            </Badge>
          ) : null}
          {onRenew ? (
            <Button
              size="sm"
              variant={revoked ? 'default' : 'ghost'}
              disabled={busy}
              title="Sign in again, then push the new login to every box on this account"
              onClick={onRenew}
            >
              <Icons.refresh /> Renew
            </Button>
          ) : null}
          {a.default?.global || !onMakeDefault ? null : (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              title={`Use this account for new ${a.agent} boxes (projects that pick their own keep it)`}
              onClick={onMakeDefault}
            >
              Make default
            </Button>
          )}
          {named && !confirming ? (
            <Button
              size="icon-sm"
              variant="ghost"
              disabled={busy || n > 0}
              aria-label={`Remove ${key}`}
              title={
                n > 0
                  ? 'Destroy the boxes that use it first'
                  : 'Remove its stored login and config volume'
              }
              onClick={onAskRemove}
            >
              <Icons.trash />
            </Button>
          ) : null}
        </div>
      </div>
      {confirming ? (
        <div className="mt-3 flex items-center gap-2">
          <Button size="sm" variant="destructive" disabled={busy} onClick={onRemove}>
            Remove {key}
          </Button>
          <Button size="sm" variant="ghost" onClick={onKeep}>
            Keep
          </Button>
        </div>
      ) : null}
      {revoked ? (
        <div className="mt-3 flex items-start gap-2 border-t border-[var(--red-line)] pt-2.5 text-xs text-[var(--red)]">
          <Icons.warn className="mt-px size-3.5 flex-none" />
          <span>
            {a.auth?.box ? (
              <>
                Seen failing in{' '}
                {failingHref ? (
                  <Link href={failingHref} className="font-mono underline underline-offset-2">
                    {a.auth.box}
                  </Link>
                ) : (
                  <span className="font-mono">{a.auth.box}</span>
                )}
                {a.auth.since ? ` (${new Date(a.auth.since).toLocaleString()})` : ''}.{' '}
              </>
            ) : null}
            {onRenew
              ? 'Renew signs it in again and pushes the new login to its boxes.'
              : 'Replace its token with a new one.'}
          </span>
        </div>
      ) : null}
      <div className="mt-3.5 empty:hidden">
        <SubMeters account={a} />
      </div>
      {atLimit && n ? (
        <div className="mt-3 flex items-start gap-2 border-t border-[var(--amber-line)] pt-2.5 text-xs text-[var(--amber-ink)]">
          <Icons.warn className="mt-px size-3.5 flex-none" />
          <span>
            {a.boxes.join(', ')} {n === 1 ? 'runs' : 'run'} on this account, which is at its limit
            {reset ? ` (${reset})` : ''}.
          </span>
        </div>
      ) : null}
      <div className="mt-3 flex items-center gap-2 font-mono text-[11px] text-muted-foreground">
        <span>{key}</span>
        <span className="ml-auto">
          {weekLoaded ? (
            <Link
              href={`/usage?view=tokens&subscription=${encodeURIComponent(key)}`}
              className="tabular-nums underline-offset-2 hover:text-foreground hover:underline"
              title={`${(weekTokens ?? 0).toLocaleString()} tokens in the last 7 days. Open in Usage`}
            >
              {fmtTokens(weekTokens ?? 0)} tokens, last 7 days
            </Link>
          ) : null}
        </span>
      </div>
    </Card>
  );
}
