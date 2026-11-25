'use client';

// Subscriptions page (Settings → Subscriptions) — the named LLM accounts of this hub's machine (logins, setup
// tokens, API keys per agent; docs/llm-accounts-plan.md, Phase 5). PURE REST
// CLIENT over /api/v1/accounts: list, add a pasted key or setup token, relabel,
// remove. A login is interactive and runs on the machine, so it is a command
// to copy, not a form. No secret ever comes back from the API.

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Icons } from '@/components/icons';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { EmptyBox } from '../../boxes/components/empty-box';
import { SectionLabel } from '../../boxes/components/section-label';
import {
  groupSubscriptions,
  subscriptionKey,
  vendorOf,
  type AccountKind,
} from '@/lib/subscriptions';

type Kind = AccountKind;

interface Account {
  agent: string;
  id: string;
  label?: string;
  kind: Kind;
  identity?: { email?: string; org?: string; plan?: string };
  hasSecret: boolean;
  boxes: string[];
}

interface AgentKinds {
  id: string;
  kinds: Kind[];
}

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
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [weekTokens, setWeekTokens] = useState<Map<string, number> | null>(null);
  const [agents, setAgents] = useState<AgentKinds[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  // Add form.
  const [agent, setAgent] = useState('');
  const [kind, setKind] = useState<Kind>('setup-token');
  const [id, setId] = useState('');
  const [label, setLabel] = useState('');
  const [token, setToken] = useState('');

  const load = useCallback(async () => {
    try {
      const r = await api<{ accounts: Account[]; agents: AgentKinds[] }>('');
      setAccounts(r.accounts);
      setAgents(r.agents);
      setError(null);
      // Usage is a side fact: the cards render without it.
      setWeekTokens(await loadWeekTokens().catch(() => null));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

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
                    <span className="font-mono text-[11px] tracking-normal text-[#a4a9b0]">
                      {g.accounts.length}
                    </span>
                  }
                >
                  {g.title}
                </SectionLabel>
                <div className="grid grid-cols-2 gap-3 max-md:grid-cols-1">
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
  return (
    <Card className="flex flex-col gap-3 p-4 px-5">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[14px] font-medium">{a.label ?? a.id}</div>
          <div className="mt-0.5 font-mono text-[11.5px] text-muted-foreground">{key}</div>
        </div>
        {a.identity?.plan ? <Badge>{a.identity.plan}</Badge> : null}
        <Badge variant="outline">{KIND_LABEL[a.kind]}</Badge>
      </div>
      <dl className="grid grid-cols-[88px_1fr] gap-x-3 gap-y-1 text-[12.5px]">
        <dt className="text-muted-foreground">Account</dt>
        <dd className="min-w-0 truncate">
          {[a.identity?.email, a.identity?.org].filter(Boolean).join(' · ') ||
            (a.kind === 'api-key' ? `${vendorOf(a.agent)} API key` : '—')}
          {a.hasSecret ? null : <span className="text-muted-foreground"> · no secret stored</span>}
        </dd>
        <dt className="text-muted-foreground">Boxes</dt>
        <dd className="min-w-0 truncate" title={a.boxes.join(', ')}>
          {named
            ? a.boxes.length > 0
              ? a.boxes.join(', ')
              : 'none'
            : 'every box without a named account'}
        </dd>
        <dt className="text-muted-foreground">Last 7 days</dt>
        <dd>
          {weekLoaded ? (
            <Link
              href={`/usage?subscription=${encodeURIComponent(key)}`}
              className="tabular-nums underline-offset-2 hover:underline"
              title={`${(weekTokens ?? 0).toLocaleString()} tokens — open in Usage`}
            >
              {fmtTokens(weekTokens ?? 0)} tokens
            </Link>
          ) : (
            <span className="text-muted-foreground">—</span>
          )}
        </dd>
      </dl>
      <div className="flex flex-wrap items-center gap-1.5">
        <Button size="sm" variant="ghost" disabled={busy} onClick={onLabel}>
          <Icons.pencil /> Label
        </Button>
        {named ? (
          confirming ? (
            <>
              <Button size="sm" variant="destructive" disabled={busy} onClick={onRemove}>
                Remove {key}
              </Button>
              <Button size="sm" variant="ghost" onClick={onKeep}>
                Keep
              </Button>
            </>
          ) : (
            <Button
              size="sm"
              variant="outline"
              disabled={busy || a.boxes.length > 0}
              title={
                a.boxes.length > 0
                  ? 'Destroy the boxes that use it first'
                  : 'Remove its stored login and config volume'
              }
              onClick={onAskRemove}
            >
              <Icons.trash /> Remove
            </Button>
          )
        ) : null}
      </div>
    </Card>
  );
}
