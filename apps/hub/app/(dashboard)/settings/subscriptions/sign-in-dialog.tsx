'use client';

// The hub-driven sign-in of one account (docs/credentials-tui-plan.md, Phase 2):
// starts `POST /api/v1/accounts/:agent/:id/login`, shows the page to open, takes
// the code the browser shows (claude) or waits for the approval (codex device
// auth), then reports the fan-out to the account's boxes. Pure REST client; the
// code goes only in the body of `…/login/code`, never in a URL.

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
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
import type { AccountLoginView } from '@/lib/boxes/backend-types';

const POLL_MS = 1_500;

const LIVE: ReadonlySet<AccountLoginView['state']> = new Set([
  'starting',
  'awaiting-code',
  'awaiting-approval',
  'exchanging',
  'pushing',
]);

async function call(path: string, init?: RequestInit): Promise<AccountLoginView> {
  const r = await fetch(`/api/v1/accounts${path}`, {
    credentials: 'same-origin',
    ...init,
    headers: { 'content-type': 'application/json', ...init?.headers },
  });
  const body = (await r.json().catch(() => ({}))) as unknown;
  if (!r.ok) {
    const message = (body as { error?: { message?: string } }).error?.message;
    throw new Error(message ?? `request failed (${String(r.status)})`);
  }
  return body as AccountLoginView;
}

export function SignInDialog({
  agent,
  account,
  mode,
  onClose,
  onFinished,
}: {
  agent: string;
  account: string;
  mode: 'add' | 'renew';
  onClose: () => void;
  /** The login is stored (the list should refresh). */
  onFinished: () => void;
}) {
  const base = `/${encodeURIComponent(agent)}/${encodeURIComponent(account)}/login`;
  const [view, setView] = useState<AccountLoginView | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [sending, setSending] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const finished = useRef(false);
  const live = view ? LIVE.has(view.state) : failure === null;

  // Start (or join the sign-in already in flight).
  useEffect(() => {
    let gone = false;
    setView(null);
    setFailure(null);
    call(base, { method: 'POST', body: JSON.stringify({ mode }) })
      .then((v) => {
        // Closed while the start was still answering: cancel what it started.
        if (gone) {
          if (v.state === 'starting' || v.state.startsWith('awaiting')) {
            void call(base, { method: 'DELETE' }).catch(() => undefined);
          }
          return;
        }
        setView(v);
      })
      .catch(
        (err: unknown) => !gone && setFailure(err instanceof Error ? err.message : String(err)),
      );
    return () => {
      gone = true;
    };
  }, [base, mode, attempt]);

  // Follow it while it runs. A failed poll (a blip, a hub restart) is shown
  // and retried: the sign-in itself goes on regardless.
  const [pollError, setPollError] = useState<string | null>(null);
  const [pollTick, setPollTick] = useState(0);
  useEffect(() => {
    if (!view || !LIVE.has(view.state)) return;
    const t = setTimeout(() => {
      call(`${base}?session=${encodeURIComponent(view.session)}`)
        .then((v) => {
          setPollError(null);
          setView(v);
        })
        .catch((err: unknown) => {
          setPollError(err instanceof Error ? err.message : String(err));
          setPollTick((n) => n + 1);
        });
    }, POLL_MS);
    return () => clearTimeout(t);
  }, [base, view, pollTick]);

  useEffect(() => {
    if (finished.current) return;
    if (view?.state === 'pushing' || view?.state === 'done') {
      finished.current = true;
      onFinished();
    }
  }, [view, onFinished]);

  const close = useCallback(() => {
    // Leaving mid-way cancels the login container rather than leaving it waiting
    // (with no view yet, the start's own answer cancels it; see above).
    if (view && (view.state === 'starting' || view.state.startsWith('awaiting'))) {
      void call(base, { method: 'DELETE' }).catch(() => undefined);
    }
    onClose();
  }, [base, view, onClose]);

  const submit = async () => {
    if (!view || !code.trim()) return;
    setSending(true);
    try {
      const v = await call(`${base}/code`, {
        method: 'POST',
        body: JSON.stringify({ code: code.trim(), session: view.session }),
      });
      setView(v);
      if (v.state !== 'awaiting-code') setCode('');
    } catch (err) {
      setFailure(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  };

  const who = view?.identity?.email ?? view?.identity?.org;
  return (
    <Dialog onClose={close} className="max-w-[560px]">
      <DialogHeader>
        <DialogIcon>
          <Icons.key />
        </DialogIcon>
        <div className="min-w-0">
          <DialogTitle>
            {mode === 'add' ? 'Add' : 'Renew'} {agent}/{account}
          </DialogTitle>
          <DialogDescription>
            Signs in on the hub&apos;s machine; the login replaces the stored one and goes to every
            box on the account.
          </DialogDescription>
        </div>
      </DialogHeader>
      <DialogBody className="flex flex-col gap-3 text-[13px]" aria-live="polite">
        {failure ? (
          <div className="font-mono text-xs text-red-400">{failure}</div>
        ) : !view || view.state === 'starting' ? (
          <Progress>
            Preparing the sign-in. The first one on this machine builds the image, which can take a
            few minutes.
          </Progress>
        ) : view.state === 'awaiting-code' ? (
          <>
            {view.url ? (
              <Step n={1}>
                Open this page and approve access:
                <OpenLink url={view.url} />
              </Step>
            ) : null}
            <Step n={view.url ? 2 : 1}>
              {view.input?.kind === 'secret'
                ? `Enter your ${view.input.label}:`
                : 'Paste the code the page shows:'}
              <form
                className="mt-2 flex gap-2"
                onSubmit={(ev) => {
                  ev.preventDefault();
                  void submit();
                }}
              >
                <Input
                  type="password"
                  value={code}
                  onChange={(ev) => setCode(ev.target.value)}
                  aria-label="Sign-in code"
                  placeholder="code"
                  className="flex-1 font-mono"
                  autoComplete="off"
                  autoFocus
                />
                <Button type="submit" size="sm" disabled={sending || !code.trim()}>
                  {sending ? 'Checking…' : 'Sign in'}
                </Button>
              </form>
            </Step>
            {view.lastError ? (
              <div className="font-mono text-xs text-[var(--amber-ink)]">{view.lastError}</div>
            ) : null}
          </>
        ) : view.state === 'awaiting-approval' ? (
          <>
            <Step n={1}>
              Open this page and sign in:
              {view.url ? <OpenLink url={view.url} /> : null}
            </Step>
            {view.userCode ? (
              <Step n={2}>
                Enter this one-time code:
                <div className="mt-1.5 select-all font-mono text-lg tracking-widest">
                  {view.userCode}
                </div>
              </Step>
            ) : null}
            <Progress>Waiting for you to approve in the browser…</Progress>
          </>
        ) : view.state === 'exchanging' ? (
          <Progress>Finishing the sign-in…</Progress>
        ) : view.state === 'pushing' ? (
          <Progress>Signed in{who ? ` as ${who}` : ''}. Pushing the login to its boxes…</Progress>
        ) : view.state === 'done' ? (
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center gap-2">
              <Icons.check className="size-4 text-primary" />
              Signed in{who ? ` as ${who}` : ''}.
            </div>
            <div className="font-mono text-xs text-muted-foreground">
              {view.renew?.error
                ? `The login is stored, but the push to its boxes failed: ${view.renew.error}`
                : view.renew && view.renew.pushed + view.renew.failed > 0
                  ? `Pushed to ${String(view.renew.pushed)} target(s)${view.renew.failed > 0 ? `, ${String(view.renew.failed)} failed` : ''}.`
                  : 'No box runs on this account yet.'}
            </div>
          </div>
        ) : (
          <div className="font-mono text-xs text-red-400">{view.error ?? 'the sign-in failed'}</div>
        )}
        {pollError ? (
          <div className="font-mono text-[11px] text-muted-foreground">
            Lost touch with the hub ({pollError}); retrying.
          </div>
        ) : null}
      </DialogBody>
      <DialogFooter>
        {!live && view?.state !== 'done' ? (
          <Button size="sm" variant="ghost" onClick={() => setAttempt((n) => n + 1)}>
            <Icons.refresh /> Try again
          </Button>
        ) : null}
        <Button size="sm" variant={view?.state === 'done' ? 'default' : 'ghost'} onClick={close}>
          {view?.state === 'done' ? 'Done' : live ? 'Cancel' : 'Close'}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

function Step({ n, children }: { n: number; children: ReactNode }) {
  return (
    <div className="flex gap-2.5">
      <span className="grid size-5 flex-none place-items-center rounded-full border border-border font-mono text-[11px]">
        {n}
      </span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

function OpenLink({ url }: { url: string }) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="mt-1.5 flex items-center gap-1.5 break-all font-mono text-xs text-primary underline-offset-2 hover:underline"
    >
      <Icons.ext className="size-3.5 flex-none" />
      {url}
    </a>
  );
}

function Progress({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center gap-2 text-muted-foreground">
      <span className="size-3.5 flex-none animate-spin rounded-full border-2 border-current border-t-transparent" />
      <span>{children}</span>
    </div>
  );
}
