'use client';

// Subscriptions page (Settings → Subscriptions) — the named LLM accounts of this hub's machine (logins, setup
// tokens, API keys per agent; docs/llm-accounts-plan.md, Phase 5). PURE REST
// CLIENT over /api/v1/accounts: list, add a pasted key or setup token, relabel,
// remove. A login is interactive and runs on the machine, so it is a command
// to copy, not a form. No secret ever comes back from the API.

import { useCallback, useEffect, useState } from 'react';
import { Icons } from '@/components/icons';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { EmptyBox } from '../../boxes/components/empty-box';
import { SectionLabel } from '../../boxes/components/section-label';

type Kind = 'login' | 'setup-token' | 'api-key';

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

function identityOf(a: Account): string {
  return [a.identity?.email, a.identity?.org, a.identity?.plan].filter(Boolean).join(' · ');
}

export default function SubscriptionsPage() {
  const [accounts, setAccounts] = useState<Account[] | null>(null);
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
        The LLM accounts boxes can run on: several logins, setup tokens or API keys per agent.
        Choose one when you create a box; <span className="font-mono">default</span> is the
        agent&apos;s plain login.
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

          <SectionLabel
            right={
              <span className="font-mono text-[11px] tracking-normal text-[#a4a9b0]">
                {accounts.length}
              </span>
            }
          >
            On this machine
          </SectionLabel>
          {accounts.length === 0 ? (
            <EmptyBox>
              <div>No accounts yet.</div>
              <div className="mt-1.5 font-mono text-xs text-muted-foreground">
                Sign in with `agentbox claude login`, or add a named one below.
              </div>
            </EmptyBox>
          ) : (
            <Card className="divide-y divide-border/60 overflow-hidden">
              {accounts.map((a) => {
                const key = `${a.agent}/${a.id}`;
                const named = a.id !== 'default';
                return (
                  <div key={key} className="flex items-center gap-4 p-4 px-5 max-sm:flex-wrap">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-[13px]">{key}</span>
                        {a.label ? (
                          <span className="text-[13px] text-secondary-foreground">{a.label}</span>
                        ) : null}
                        <Badge variant="outline">{KIND_LABEL[a.kind]}</Badge>
                        {a.hasSecret ? null : <Badge variant="outline">no secret stored</Badge>}
                      </div>
                      <div className="mt-1 text-[12px] text-muted-foreground">
                        {identityOf(a) || '—'}
                        {a.boxes.length > 0 ? ` · used by ${a.boxes.join(', ')}` : ''}
                      </div>
                    </div>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy !== null}
                      onClick={() => relabel(a)}
                    >
                      <Icons.pencil /> Label
                    </Button>
                    {named ? (
                      confirmRemove === key ? (
                        <>
                          <Button
                            size="sm"
                            variant="destructive"
                            disabled={busy !== null}
                            onClick={() => void remove(a)}
                          >
                            Remove {key}
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => setConfirmRemove(null)}>
                            Keep
                          </Button>
                        </>
                      ) : (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy !== null || a.boxes.length > 0}
                          title={
                            a.boxes.length > 0
                              ? 'Destroy the boxes that use it first'
                              : 'Remove its stored login and config volume'
                          }
                          onClick={() => setConfirmRemove(key)}
                        >
                          <Icons.trash /> Remove
                        </Button>
                      )
                    ) : null}
                  </div>
                );
              })}
            </Card>
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
