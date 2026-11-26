'use client';

// The box page's account rows (hub settings 3c): which LLM account each of the
// box's agents runs on, a selector to move it to another one, and the box's
// recent switches. A setup token or API key restarts the agent with it; a login
// rebuilds a docker box on that account's volume. Both resume the conversation.
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { refreshAccounts, topPct, useAccounts, type Account } from '@/lib/accounts-client';
import type { Box } from '@/lib/boxes/types';
import { DRow } from './d-row';
import { useToasts, ToastStack } from './toasts';

const KIND_TEXT: Record<Account['kind'], string> = {
  login: 'login',
  'setup-token': 'setup token',
  'api-key': 'API key',
};

async function errorOf(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: { message?: string } };
    return body.error?.message ?? `HTTP ${String(res.status)}`;
  } catch {
    return `HTTP ${String(res.status)}`;
  }
}

function optionText(a: Account): string {
  const pct = topPct(a);
  const parts = [a.id, KIND_TEXT[a.kind]];
  if (pct >= 100) parts.push('at its limit');
  return parts.join(' · ');
}

function AgentAccountRow({
  box,
  agent,
  accounts,
  onToast,
}: {
  box: Box;
  agent: string;
  accounts: Account[];
  onToast: ReturnType<typeof useToasts>['push'];
}) {
  const current = box.accounts?.[agent] ?? 'default';
  const [target, setTarget] = useState(current);
  const [busy, setBusy] = useState(false);
  const cloud = box.provider !== 'docker';
  // A cloud box can switch to one login only: `default`, when it was created on it.
  const createdOn = (box.accountSwitches ?? []).find((s) => s.agent === agent)?.from ?? current;
  const blocked = (a: Account) =>
    cloud &&
    a.kind === 'login' &&
    a.id !== current &&
    !(a.id === 'default' && createdOn === 'default');
  const rows = accounts.some((a) => a.id === current)
    ? accounts
    : [{ agent, id: current, kind: 'login', hasSecret: false, boxes: [] } as Account, ...accounts];

  const run = async () => {
    setBusy(true);
    try {
      const res = await fetch(`/api/v1/boxes/${encodeURIComponent(box.id)}/account`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agent, account: target }),
      });
      if (!res.ok) {
        onToast({ variant: 'error', title: 'Switch failed', detail: await errorOf(res) });
        return;
      }
      const r = (await res.json()) as { to: string; how: string; restarted: boolean };
      onToast({
        title: `${agent} now runs on ${r.to}`,
        detail: r.restarted
          ? r.how === 'recreate'
            ? 'The box was rebuilt on that login and the conversation resumed.'
            : 'The agent restarted with the new account and resumed its conversation.'
          : 'The box is not running: the account applies at its next start.',
      });
      void refreshAccounts();
    } catch (err) {
      onToast({
        variant: 'error',
        title: 'Switch failed',
        detail: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <DRow
      k={`${agent} account`}
      v={
        <div className="flex flex-wrap items-center gap-2">
          <Select
            aria-label={`${agent} account`}
            value={target}
            disabled={busy}
            onChange={(e) => setTarget(e.target.value)}
            wrapperClassName="min-w-0 max-w-full"
            className="font-mono"
          >
            {rows.map((a) => (
              <option key={a.id} value={a.id} disabled={blocked(a)}>
                {optionText(a)}
                {blocked(a) ? ' · docker only' : ''}
              </option>
            ))}
          </Select>
          <Button
            size="sm"
            variant="outline"
            disabled={busy || target === current}
            onClick={() => void run()}
          >
            {busy ? 'Switching…' : 'Switch'}
          </Button>
        </div>
      }
    />
  );
}

/** The account rows of the box page's Details card. */
export function AccountRows({ box }: { box: Box }) {
  const { accounts, agents } = useAccounts();
  const { toasts, push, dismiss } = useToasts();
  const boxAgents = (box.agents ?? (box.lastAgent ? [box.lastAgent] : [])).filter((a) =>
    agents.some((g) => g.id === a),
  );
  const history = [...(box.accountSwitches ?? [])].reverse();
  // Until the account list loads (or on a hub that cannot list them), the
  // read-only rows the payload carries.
  const fallback =
    boxAgents.length === 0
      ? box.accountsInfo?.map((a) => (
          <DRow
            key={`acct-${a.agent}`}
            k={`${a.agent} account`}
            v={[a.account, a.kind].filter(Boolean).join(' · ')}
            mono
          />
        ))
      : null;
  return (
    <>
      {fallback}
      {boxAgents.map((agent) => (
        <AgentAccountRow
          key={`acct-${agent}-${box.accounts?.[agent] ?? 'default'}`}
          box={box}
          agent={agent}
          accounts={(accounts ?? []).filter((a) => a.agent === agent)}
          onToast={push}
        />
      ))}
      {history.length > 0 ? (
        <DRow
          k="Account switches"
          v={
            <ul className="space-y-1 font-mono text-[12.5px]">
              {history.map((s) => (
                <li key={`${s.at}-${s.agent}`}>
                  {new Date(s.at).toLocaleString()} · {s.agent}: {s.from} → {s.to}
                  <span className="text-muted-foreground">
                    {' '}
                    ({s.how === 'recreate' ? 'rebuilt' : 'restarted'}
                    {s.reason === 'limit' ? ', at the limit' : ''})
                  </span>
                </li>
              ))}
            </ul>
          }
        />
      ) : null}
      <ToastStack toasts={toasts} dismiss={dismiss} />
    </>
  );
}
