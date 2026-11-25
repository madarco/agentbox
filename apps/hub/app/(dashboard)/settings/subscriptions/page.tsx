'use client';

// Subscriptions page (Settings → Subscriptions) — the named LLM accounts of this hub's machine (logins, setup
// tokens, API keys per agent; docs/llm-accounts-plan.md, Phase 5). PURE REST
// CLIENT over /api/v1/accounts: list, add a pasted key or setup token, relabel,
// remove. A login is interactive and runs on the machine, so it is a command
// to copy, not a form. No secret ever comes back from the API. Each card shows
// one meter per plan-limit window the account reports (hub settings 3b,
// design: control-shadcn/views-env.jsx SubscriptionsPane).

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Icons } from '@/components/icons';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { SubMark, SubMeters, TierBadge, subLine, subName } from '@/components/subscription-meters';
import { refreshAccounts, resetText, useAccounts, type Account } from '@/lib/accounts-client';
import { groupSubscriptions, subscriptionKey, type AccountKind } from '@/lib/subscriptions';
import { cn } from '@/lib/utils';
import { EmptyBox } from '../../boxes/components/empty-box';
import { SectionLabel } from '../../boxes/components/section-label';

type Kind = AccountKind;

const KIND_LABEL: Record<Kind, string> = {
  login: 'login',
  'setup-token': 'setup token',
  'api-key': 'API key',
};

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`/api/v1/accounts${path}`, {
    credentials: 'same-origin',
    ...init,
    headers: { 'content-type': 'application/json', ...init?.headers },
  });
  const body = (await r.json().catch(() => ({}))) as { error?: { message?: string } };
  if (!r.ok) throw new Error(body.error?.message ?? `request failed (${String(r.status)})`);
  return body as T;
}

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
  const { accounts, agents, error } = useAccounts();
  const [weekTokens, setWeekTokens] = useState<Map<string, number> | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  // Add form.
  const [agent, setAgent] = useState('');
  const [kind, setKind] = useState<Kind>('setup-token');
  const [id, setId] = useState('');
  const [label, setLabel] = useState('');
  const [token, setToken] = useState('');

  // Usage is a side fact: the cards render without it.
  useEffect(() => {
    void loadWeekTokens()
      .catch(() => null)
      .then(setWeekTokens);
  }, []);
  const load = refreshAccounts;

  const pastedAgents = agents.filter((a) => a.kinds.some((k) => k !== 'login'));
  const chosen = pastedAgents.find((a) => a.id === agent) ?? pastedAgents[0];
  const pastedKinds: Kind[] = (chosen?.kinds ?? []).filter((k) => k !== 'login');
  const chosenKind = pastedKinds.includes(kind) ? kind : pastedKinds[0];

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

  const relabel = (a: Account) => {
    const next = window.prompt(`Label for ${a.agent}/${a.id} (empty clears it)`, a.label ?? '');
    if (next === null) return;
    void act(`label:${a.agent}/${a.id}`, () =>
      api(enc(a), { method: 'PATCH', body: JSON.stringify({ label: next.trim() || null }) }),
    );
  };

  const remove = (a: Account) =>
    act(`rm:${a.agent}/${a.id}`, async () => {
      await api(enc(a), { method: 'DELETE' });
      setConfirmRemove(null);
    });

  const add = () =>
    act('add', async () => {
      if (!chosen || !chosenKind) return;
      await api('', {
        method: 'POST',
        body: JSON.stringify({
          agent: chosen.id,
          id: id.trim(),
          kind: chosenKind,
          token: token.trim(),
          ...(label.trim() ? { label: label.trim() } : {}),
        }),
      });
      setId('');
      setLabel('');
      setToken('');
    });

  return (
    <div className="mx-auto w-full max-w-[1080px] px-8 pb-16 pt-8 max-sm:px-4">
      <h1 className="text-[25px] font-semibold leading-tight tracking-[-0.025em]">Subscriptions</h1>
      <div className="mt-1.5 text-sm text-muted-foreground">
        The plans and keys boxes run on: several logins, setup tokens or API keys per agent. Choose
        one when you create a box; <span className="font-mono">default</span> is the agent&apos;s
        plain login. A box that borrows another agent&apos;s login counts under that login.
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

          {accounts.length === 0 ? (
            <>
              <SectionLabel>On this machine</SectionLabel>
              <EmptyBox>
                <div>No accounts yet.</div>
                <div className="mt-1.5 font-mono text-xs text-muted-foreground">
                  Sign in with `agentbox claude login`, or add a named one below.
                </div>
              </EmptyBox>
            </>
          ) : (
            groupSubscriptions(accounts).map((g) => (
              <div key={g.title}>
                <SectionLabel
                  right={
                    <span className="font-mono text-[11px] normal-case tracking-normal text-[#a4a9b0]">
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
                      onLabel={() => relabel(a)}
                      onAskRemove={() => setConfirmRemove(subscriptionKey(a))}
                      onKeep={() => setConfirmRemove(null)}
                      onRemove={() => void remove(a)}
                    />
                  ))}
                </div>
              </div>
            ))
          )}

          <SectionLabel>Add a setup token or API key</SectionLabel>
          {pastedAgents.length === 0 ? (
            <EmptyBox>
              <div>No agent here takes a pasted account.</div>
            </EmptyBox>
          ) : (
            <Card className="p-4 px-5">
              <form
                className="flex flex-wrap items-center gap-2"
                onSubmit={(ev) => {
                  ev.preventDefault();
                  void add();
                }}
              >
                <select
                  aria-label="Agent"
                  className="h-8 rounded-md border bg-background px-2 text-[13px]"
                  value={chosen?.id ?? ''}
                  onChange={(ev) => setAgent(ev.target.value)}
                >
                  {pastedAgents.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.id}
                    </option>
                  ))}
                </select>
                <select
                  aria-label="Kind"
                  className="h-8 rounded-md border bg-background px-2 text-[13px]"
                  value={chosenKind ?? ''}
                  onChange={(ev) => setKind(ev.target.value as Kind)}
                >
                  {pastedKinds.map((k) => (
                    <option key={k} value={k}>
                      {KIND_LABEL[k]}
                    </option>
                  ))}
                </select>
                <Input
                  value={id}
                  onChange={(ev) => setId(ev.target.value)}
                  placeholder="name (e.g. ci)"
                  className="w-36 font-mono"
                  autoComplete="off"
                />
                <Input
                  value={label}
                  onChange={(ev) => setLabel(ev.target.value)}
                  placeholder="label (optional)"
                  className="w-40"
                  autoComplete="off"
                />
                <Input
                  type="password"
                  value={token}
                  onChange={(ev) => setToken(ev.target.value)}
                  placeholder={chosenKind === 'api-key' ? 'API key' : 'setup token'}
                  className="min-w-[220px] flex-1 font-mono"
                  autoComplete="off"
                />
                <Button
                  type="submit"
                  size="sm"
                  disabled={busy !== null || !id.trim() || !token.trim()}
                >
                  <Icons.plus /> Add
                </Button>
              </form>
              <div className="mt-3 text-[12px] text-muted-foreground">
                A setup token never renews, so it is the right kind for an account several boxes use
                at once. To add a <span className="font-mono">login</span>, run{' '}
                <span className="font-mono">agentbox claude login --account &lt;name&gt;</span> on
                this machine.
              </div>
            </Card>
          )}
        </>
      )}
    </div>
  );
}

function SubscriptionCard({
  account: a,
  weekTokens,
  weekLoaded,
  busy,
  confirming,
  onLabel,
  onAskRemove,
  onKeep,
  onRemove,
}: {
  account: Account;
  weekTokens: number | undefined;
  weekLoaded: boolean;
  busy: boolean;
  confirming: boolean;
  onLabel: () => void;
  onAskRemove: () => void;
  onKeep: () => void;
  onRemove: () => void;
}) {
  const key = subscriptionKey(a);
  const named = a.id !== 'default';
  const n = a.boxes.length;
  const atLimit = a.limits?.atLimit === true;
  // The first window to reset that is full, for the at-limit note.
  const reset = resetText(
    a.limits?.windows
      .filter((w) => w.pct >= 100 && w.resetsAt)
      .map((w) => w.resetsAt!)
      .sort()[0],
  );
  return (
    <Card className={cn('p-4', atLimit && 'border-[var(--amber-line)]')}>
      <div className="flex items-center gap-3 max-sm:flex-wrap">
        <SubMark account={a} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-[13.5px] font-semibold">
            <span className="truncate">{subName(a)}</span>
            <TierBadge account={a} />
            {a.hasSecret ? null : <Badge className="px-1.5 py-0 text-[10.5px]">no secret</Badge>}
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
          <Button
            size="icon-sm"
            variant="ghost"
            disabled={busy}
            aria-label={`Label ${key}`}
            title="Set its label"
            onClick={onLabel}
          >
            <Icons.pencil />
          </Button>
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
      <div className="mt-3.5 empty:hidden">
        <SubMeters account={a} />
      </div>
      {atLimit && n ? (
        <div className="mt-3 flex items-start gap-2 border-t border-[var(--amber-line)] pt-2.5 text-xs text-[#6a4e0c]">
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
              href={`/usage?subscription=${encodeURIComponent(key)}`}
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
