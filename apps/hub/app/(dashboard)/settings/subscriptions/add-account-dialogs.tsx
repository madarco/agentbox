'use client';

// The two "add a subscription" forms of Settings → Subscriptions, each in its own
// dialog: name a new login (then the page hands off to SignInDialog), or paste a
// setup token / API key. Pure REST clients over /api/v1/accounts.

import { useState } from 'react';
import { Icons } from '@/components/icons';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogBody,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogIcon,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { accountsApi, type Account, type AgentKinds } from '@/lib/accounts-client';
import type { AccountKind } from '@/lib/subscriptions';
import { newAccountName } from '@/app/(dashboard)/api/v1/lib/validate';

const KIND_LABEL: Record<AccountKind, string> = {
  login: 'login',
  'setup-token': 'setup token',
  'api-key': 'API key',
};

const NAME_RULE = 'a name is letters, digits, spaces or _';

function Hint({ children }: { children: string | null }) {
  return children ? (
    <div className="mt-1.5 font-mono text-[12px] text-muted-foreground">{children}</div>
  ) : null;
}

/** Pick an agent and a name; submitting starts the hub sign-in for it. */
export function NewLoginDialog({
  agents,
  accounts,
  onClose,
  onSignIn,
}: {
  /** Agents that take a login account (non-empty). */
  agents: AgentKinds[];
  accounts: Account[];
  onClose: () => void;
  onSignIn: (agent: string, account: string) => void;
}) {
  const [agent, setAgent] = useState('');
  const [name, setName] = useState('');
  const chosen = agents.find((a) => a.id === agent) ?? agents[0];
  const typed = name.trim();
  const savedAs = typed ? newAccountName(typed) : null;
  const taken = accounts.some(
    (a) => a.agent === chosen?.id && (a.id === typed || a.id === savedAs),
  );
  const hint = !typed
    ? null
    : taken
      ? `${chosen?.id ?? ''}/${savedAs ?? typed} already exists; renew it from its card`
      : !savedAs
        ? NAME_RULE
        : savedAs !== typed
          ? `saved as ${chosen?.id ?? ''}/${savedAs}`
          : null;

  return (
    <Dialog onClose={onClose}>
      <DialogHeader>
        <DialogIcon>
          <Icons.key />
        </DialogIcon>
        <div>
          <DialogTitle>Sign in with a new account</DialogTitle>
          <DialogDescription>a named login, next to the agent&apos;s default one</DialogDescription>
        </div>
      </DialogHeader>
      <form
        onSubmit={(ev) => {
          ev.preventDefault();
          if (!chosen || !savedAs || taken) return;
          onSignIn(chosen.id, savedAs);
        }}
      >
        <DialogBody className="flex flex-col gap-4">
          <div>
            <Label htmlFor="new-login-agent">Agent</Label>
            <Select
              id="new-login-agent"
              aria-label="Login agent"
              wrapperClassName="w-full"
              value={chosen?.id ?? ''}
              onChange={(ev) => setAgent(ev.target.value)}
            >
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.id}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label htmlFor="new-login-name">Name</Label>
            <Input
              id="new-login-name"
              value={name}
              onChange={(ev) => setName(ev.target.value)}
              placeholder="work max"
              aria-label="Login name"
              className="font-mono"
              autoComplete="off"
              autoFocus
            />
            <Hint>{hint}</Hint>
          </div>
          <div className="text-[12px] text-muted-foreground">
            Signs in on the hub&apos;s machine: open the page it shows, then paste the code back
            here (claude) or approve the device code (codex).
          </div>
        </DialogBody>
        <DialogFooter>
          <Button type="button" size="sm" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={!savedAs || taken}>
            <Icons.key /> Sign in
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

/** Paste a setup token or an API key under a name. */
export function AddKeyDialog({
  agents,
  accounts,
  onClose,
  onAdded,
}: {
  /** Agents that take a pasted kind (non-empty). */
  agents: AgentKinds[];
  accounts: Account[];
  onClose: () => void;
  onAdded: () => void;
}) {
  const [agent, setAgent] = useState('');
  const [kind, setKind] = useState<AccountKind>('setup-token');
  const [name, setName] = useState('');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const chosen = agents.find((a) => a.id === agent) ?? agents[0];
  const kinds: AccountKind[] = (chosen?.kinds ?? []).filter((k) => k !== 'login');
  const chosenKind = kinds.includes(kind) ? kind : kinds[0];
  // What the hub will store: an existing name as typed, a new one normalized.
  const typed = name.trim();
  const existing = accounts.some((a) => a.agent === chosen?.id && a.id === typed);
  const savedAs = typed && !existing ? newAccountName(typed) : null;
  const hint =
    typed && !existing && savedAs !== typed
      ? savedAs
        ? `saved as ${chosen?.id ?? ''}/${savedAs}`
        : NAME_RULE
      : null;

  const submit = async (): Promise<void> => {
    if (!chosen || !chosenKind) return;
    setBusy(true);
    setError(null);
    try {
      await accountsApi('', {
        method: 'POST',
        body: JSON.stringify({
          agent: chosen.id,
          id: typed,
          kind: chosenKind,
          token: token.trim(),
        }),
      });
      onAdded();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog onClose={busy ? () => {} : onClose}>
      <DialogHeader>
        <DialogIcon>
          <Icons.plus />
        </DialogIcon>
        <div>
          <DialogTitle>Add a setup token or API key</DialogTitle>
          <DialogDescription>stored on the hub; never shown again</DialogDescription>
        </div>
      </DialogHeader>
      <form
        onSubmit={(ev) => {
          ev.preventDefault();
          void submit();
        }}
      >
        <DialogBody className="flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor="add-key-agent">Agent</Label>
              <Select
                id="add-key-agent"
                aria-label="Agent"
                wrapperClassName="w-full"
                value={chosen?.id ?? ''}
                disabled={busy}
                onChange={(ev) => setAgent(ev.target.value)}
              >
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.id}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <Label htmlFor="add-key-kind">Kind</Label>
              <Select
                id="add-key-kind"
                aria-label="Kind"
                wrapperClassName="w-full"
                value={chosenKind ?? ''}
                disabled={busy}
                onChange={(ev) => setKind(ev.target.value as AccountKind)}
              >
                {kinds.map((k) => (
                  <option key={k} value={k}>
                    {KIND_LABEL[k]}
                  </option>
                ))}
              </Select>
            </div>
          </div>
          <div>
            <Label htmlFor="add-key-name">Name</Label>
            <Input
              id="add-key-name"
              value={name}
              onChange={(ev) => setName(ev.target.value)}
              placeholder="work max"
              aria-label="Name"
              className="font-mono"
              autoComplete="off"
              disabled={busy}
              autoFocus
            />
            <Hint>{hint}</Hint>
          </div>
          <div>
            <Label htmlFor="add-key-secret">
              {chosenKind === 'api-key' ? 'API key' : 'Setup token'}
            </Label>
            <Input
              id="add-key-secret"
              type="password"
              value={token}
              onChange={(ev) => setToken(ev.target.value)}
              placeholder={chosenKind === 'api-key' ? 'sk-…' : 'sk-ant-oat…'}
              className="font-mono"
              autoComplete="off"
              disabled={busy}
            />
          </div>
          <div className="text-[12px] text-muted-foreground">
            A setup token never renews, so it is the right kind for an account several boxes use at
            once.
          </div>
          {error ? <div className="font-mono text-xs text-red-400">{error}</div> : null}
        </DialogBody>
        <DialogFooter>
          <Button type="button" size="sm" variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            type="submit"
            size="sm"
            disabled={busy || !typed || (!existing && !savedAs) || !token.trim()}
          >
            <Icons.plus /> {busy ? 'Adding…' : 'Add'}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
