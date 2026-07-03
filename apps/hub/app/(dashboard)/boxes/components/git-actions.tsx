'use client';

import { useCallback, useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Icons } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  gitBranchAction,
  gitCheckoutAction,
  gitPullAction,
  gitPushAction,
  gitPushHostAction,
} from '@/lib/boxes/actions';
import type { BoxOpResult, GitInfo } from '@/lib/boxes/backend-types';
import { SectionLabel } from './section-label';

export function GitActions({ id, running }: { id: string; running: boolean }) {
  const router = useRouter();
  const [git, setGit] = useState<GitInfo | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, startTransition] = useTransition();
  const [checkoutTo, setCheckoutTo] = useState('');
  const [newName, setNewName] = useState('');
  const [newFrom, setNewFrom] = useState('');

  const loadGit = useCallback(async () => {
    try {
      const res = await fetch(`/api/v1/boxes/${encodeURIComponent(id)}/git`, { credentials: 'same-origin' });
      setGit(res.ok ? ((await res.json()) as GitInfo) : { ok: false });
    } catch {
      setGit({ ok: false });
    }
  }, [id]);

  useEffect(() => {
    void loadGit();
  }, [loadGit]);

  // Run a mutation server action, surface the result, then refresh git + the box.
  const run = (label: string, fn: () => Promise<BoxOpResult>) => {
    startTransition(async () => {
      const res = await fn();
      setMsg(res.ok ? { ok: true, text: `${label} done` } : { ok: false, text: `${label} failed: ${res.error}` });
      await loadGit();
      router.refresh();
    });
  };

  const info = git?.ok ? git : null;

  return (
    <>
      <SectionLabel>Git</SectionLabel>
      <Card className="divide-y divide-border/60 overflow-hidden">
        {/* current branch + dirty/ahead/behind */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-sm">
          <Icons.branch />
          <span className="font-mono text-secondary-foreground">{info?.branch ?? '—'}</span>
          {info?.dirty ? <span className="font-mono text-xs text-[var(--amber)]">uncommitted changes</span> : null}
          {info && (info.ahead || info.behind) ? (
            <span className="font-mono text-xs text-muted-foreground">
              {info.ahead ? `↑${String(info.ahead)}` : ''} {info.behind ? `↓${String(info.behind)}` : ''}
            </span>
          ) : null}
        </div>

        {/* remote / host sync actions */}
        <div className="flex flex-wrap gap-1.5 px-4 py-3">
          <Button variant="outline" size="sm" disabled={!running || pending} onClick={() => run('Pull', () => gitPullAction(id))}>
            <Icons.arrowL className="rotate-90" />
            Pull
          </Button>
          <Button variant="outline" size="sm" disabled={!running || pending} onClick={() => run('Push', () => gitPushAction(id))}>
            <Icons.arrowUp />
            Push
          </Button>
          <Button
            variant="outline"
            size="sm"
            title="Land the branch in the host repo only — nothing is published to the remote"
            disabled={!running || pending}
            onClick={() => run('Push to host', () => gitPushHostAction(id))}
          >
            <Icons.server />
            Push to host
          </Button>
        </div>

        {/* change branch */}
        <form
          className="flex flex-wrap items-center gap-1.5 px-4 py-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (checkoutTo.trim()) run('Checkout', () => gitCheckoutAction(id, checkoutTo.trim()));
          }}
        >
          <Input
            className="h-[30px] w-48 flex-1 text-xs"
            placeholder="switch to branch…"
            value={checkoutTo}
            onChange={(e) => setCheckoutTo(e.target.value)}
            disabled={!running || pending}
          />
          <Button type="submit" variant="outline" size="sm" disabled={!running || pending || !checkoutTo.trim()}>
            Checkout
          </Button>
        </form>

        {/* new agentbox/* branch (create + switch) */}
        <form
          className="flex flex-wrap items-center gap-1.5 px-4 py-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (newName.trim()) run('New branch', () => gitBranchAction(id, newName.trim(), newFrom.trim() || undefined));
          }}
        >
          <Input
            className="h-[30px] w-40 text-xs"
            placeholder="new branch name…"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            disabled={!running || pending}
          />
          <Input
            className="h-[30px] w-32 text-xs"
            placeholder="from (HEAD)"
            value={newFrom}
            onChange={(e) => setNewFrom(e.target.value)}
            disabled={!running || pending}
          />
          <Button type="submit" variant="outline" size="sm" disabled={!running || pending || !newName.trim()}>
            <Icons.plus />
            Create
          </Button>
        </form>

        {msg ? (
          <div className={`px-4 py-2 font-mono text-xs ${msg.ok ? 'text-[var(--green-ink)]' : 'text-[var(--red)]'}`}>
            {msg.text}
          </div>
        ) : null}
      </Card>
    </>
  );
}
