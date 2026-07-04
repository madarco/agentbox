'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Icons, type Icon } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
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
import { gitBranchAction, gitCheckoutAction, gitPullAction, gitPushAction, gitPushHostAction } from '@/lib/boxes/actions';
import type { BoxOpResult, GitInfo } from '@/lib/boxes/backend-types';
import type { Box } from '@/lib/boxes/types';
import { cn } from '@/lib/utils';

// ── toast stack (shadcn toast styling, AgentBox tokens) ──
interface Toast {
  id: number;
  title: string;
  detail?: string;
  variant?: 'error';
}
let _toastId = 0;

function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const dismiss = useCallback((id: number) => setToasts((ts) => ts.filter((t) => t.id !== id)), []);
  const push = useCallback(
    (t: Omit<Toast, 'id'>) => {
      const id = ++_toastId;
      setToasts((ts) => [...ts, { id, ...t }]);
      setTimeout(() => dismiss(id), 4200);
    },
    [dismiss],
  );
  return { toasts, push, dismiss };
}

function ToastStack({ toasts, dismiss }: { toasts: Toast[]; dismiss: (id: number) => void }) {
  return (
    <div className="pointer-events-none fixed bottom-5 right-5 z-[60] flex w-[340px] max-w-[calc(100vw-40px)] flex-col gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          className="anim-pop pointer-events-auto relative flex items-start gap-3 rounded-xl border border-border bg-card p-3.5 pr-9 shadow-[0_16px_40px_-18px_rgba(20,24,30,.35)]"
        >
          <span
            className={cn(
              'mt-0.5 grid h-6 w-6 flex-none place-items-center rounded-md border',
              t.variant === 'error'
                ? 'border-[var(--red-line)] bg-[var(--red-soft)] text-[var(--red)]'
                : 'border-[var(--green-line)] bg-accent text-primary',
            )}
          >
            {t.variant === 'error' ? <Icons.warn className="size-3.5" /> : <Icons.check className="size-3.5" />}
          </span>
          <div className="min-w-0">
            <div className="text-[13px] font-semibold leading-tight">{t.title}</div>
            {t.detail ? (
              <div className="mt-0.5 break-words font-mono text-[11.5px] leading-normal text-muted-foreground">{t.detail}</div>
            ) : null}
          </div>
          <button
            className="absolute right-2.5 top-2.5 grid h-5 w-5 cursor-pointer place-items-center rounded border-0 bg-transparent text-[#a4a9b0] hover:text-foreground"
            onClick={() => dismiss(t.id)}
            aria-label="Dismiss"
          >
            <Icons.x className="size-3" />
          </button>
        </div>
      ))}
    </div>
  );
}

function GitOpRow({ label, desc, children }: { label: string; desc: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-3 px-4.5 p-3.5">
      <div className="min-w-[150px] flex-1">
        <div className="text-[13.5px] font-medium">{label}</div>
        <div className="mt-0.5 font-mono text-[11.5px] text-muted-foreground">{desc}</div>
      </div>
      <div className="flex flex-none flex-wrap gap-1.5">{children}</div>
    </div>
  );
}

// An outline button that shows a spinner while its async op runs.
function OpButton({
  icon: Ic,
  disabled,
  onRun,
  children,
}: {
  icon: Icon;
  disabled?: boolean;
  onRun: () => Promise<void>;
  children: ReactNode;
}) {
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      await onRun();
    } finally {
      setBusy(false);
    }
  };
  return (
    <Button variant="outline" size="sm" disabled={disabled || busy} onClick={run}>
      {busy ? <span className="spin" style={{ width: 12, height: 12 }} /> : <Ic />}
      {children}
    </Button>
  );
}

// First non-empty line of the command output (stdout preferred, else stderr) —
// git puts "Switched to…" on stderr, the host-only landing note on stdout.
function firstLine(stdout?: string, stderr?: string): string | undefined {
  const text = (stdout ?? '').trim() || (stderr ?? '').trim();
  return text ? text.split('\n')[0] : undefined;
}

export function GitActions({ box }: { box: Box }) {
  const router = useRouter();
  const { toasts, push, dismiss } = useToasts();
  const [git, setGit] = useState<GitInfo | null>(null);
  const [modal, setModal] = useState<'change' | 'new' | null>(null);
  const offline = box.status !== 'running';

  const loadGit = useCallback(async () => {
    try {
      const r = await fetch(`/api/v1/boxes/${encodeURIComponent(box.id)}/git`, { credentials: 'same-origin' });
      setGit(r.ok ? ((await r.json()) as GitInfo) : null);
    } catch {
      setGit(null);
    }
  }, [box.id]);

  useEffect(() => {
    void loadGit();
  }, [loadGit]);

  // Live branch (box.branch from the dashboard snapshot goes stale after a checkout).
  const branch = git?.ok && git.branch ? git.branch : box.branch || '—';

  const refresh = () => {
    void loadGit();
    router.refresh();
  };

  const runOp = async (title: string, fn: () => Promise<BoxOpResult>) => {
    const res = await fn();
    if (res.ok) {
      push({ title, detail: firstLine(res.stdout, res.stderr) });
      refresh();
    } else {
      push({ variant: 'error', title: `${title} failed`, detail: res.error });
    }
  };

  return (
    <>
      <Card className={cn('divide-y divide-border/60 overflow-hidden', offline ? 'opacity-90' : '')}>
        {offline ? (
          <div className="flex items-center gap-2.5 bg-[var(--amber-soft)] px-4.5 p-2.5 text-[12.5px] text-[var(--amber)]">
            <Icons.warn className="size-3.5 flex-none" />
            Box is {box.status} — git operations need a running box.
          </div>
        ) : null}
        <GitOpRow label="Sync" desc={`origin ↔ ${branch}`}>
          <OpButton icon={Icons.arrowL} disabled={offline} onRun={() => runOp('Pulled from origin', () => gitPullAction(box.id))}>
            Pull
          </OpButton>
          <OpButton icon={Icons.ext} disabled={offline} onRun={() => runOp('Pushed to origin', () => gitPushAction(box.id))}>
            Push
          </OpButton>
          <OpButton
            icon={Icons.host}
            disabled={offline}
            onRun={() => runOp('Pushed to host', () => gitPushHostAction(box.id))}
          >
            Push to host
          </OpButton>
        </GitOpRow>
        <GitOpRow label="Branch" desc={`currently on ${branch}`}>
          <Button variant="outline" size="sm" disabled={offline} onClick={() => setModal('change')}>
            <Icons.branch />
            Change branch
          </Button>
          <Button variant="outline" size="sm" disabled={offline} onClick={() => setModal('new')}>
            <Icons.plus />
            New branch
          </Button>
        </GitOpRow>
      </Card>

      {modal === 'change' ? (
        <ChangeBranchModal box={box} branch={branch} onClose={() => setModal(null)} onDone={push} onRefresh={refresh} />
      ) : null}
      {modal === 'new' ? (
        <NewBranchModal box={box} onClose={() => setModal(null)} onDone={push} onRefresh={refresh} />
      ) : null}
      <ToastStack toasts={toasts} dismiss={dismiss} />
    </>
  );
}

type OnDone = (t: Omit<Toast, 'id'>) => void;

// Sentinel select value that switches the field to free-text entry.
const MANUAL = '__manual__';

// A branch picker: a Select of the box project's branches (local + remote) with
// a manual-entry escape hatch, so an arbitrary ref/SHA stays reachable. Falls
// back to a plain text Input when the branch list is unavailable (hosted path
// 503) or empty — the field never blocks a checkout/base ref.
//
// `headLabel` (New branch base ref) adds a leading empty-value option meaning
// "the box's current HEAD"; without it (Change branch) a disabled placeholder
// forces an explicit pick.
function BranchField({
  boxId,
  value,
  onChange,
  id,
  headLabel,
  currentBranch,
}: {
  boxId: string;
  value: string;
  onChange: (v: string) => void;
  id: string;
  headLabel?: string;
  currentBranch?: string;
}) {
  const [branches, setBranches] = useState<string[] | null>(null); // null = loading
  const [current, setCurrent] = useState<string | null>(currentBranch ?? null);
  const [manual, setManual] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await fetch(`/api/v1/boxes/${encodeURIComponent(boxId)}/branches`, { credentials: 'same-origin' });
        const j = r.ok ? ((await r.json()) as { current?: string | null; branches?: string[] }) : null;
        if (cancelled) return;
        if (j && Array.isArray(j.branches) && j.branches.length > 0) {
          setBranches(j.branches);
          // The caller's notion of "current" wins (the box's own branch for a
          // checkout); only fall back to the repo HEAD the endpoint reports.
          if (!currentBranch && typeof j.current === 'string') setCurrent(j.current);
        } else {
          // No usable list (empty repo or hosted path) — drop to free text.
          setBranches([]);
          setManual(true);
        }
      } catch {
        if (!cancelled) {
          setBranches([]);
          setManual(true);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [boxId, currentBranch]);

  if (branches === null) {
    return (
      <Select id={id} value="" disabled wrapperClassName="w-full">
        <option value="">Loading branches…</option>
      </Select>
    );
  }

  if (manual) {
    return (
      <>
        <Input
          id={id}
          className="font-mono text-[13px]"
          autoFocus
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={headLabel ? 'HEAD' : 'feature-x'}
        />
        {branches.length > 0 ? (
          <button
            type="button"
            onClick={() => {
              setManual(false);
              onChange('');
            }}
            className="mt-1.5 cursor-pointer text-xs text-secondary-foreground underline-offset-2 hover:underline"
          >
            ← Back to branch list
          </button>
        ) : null}
      </>
    );
  }

  return (
    <Select
      id={id}
      value={value}
      wrapperClassName="w-full"
      onChange={(e) => {
        if (e.target.value === MANUAL) {
          setManual(true);
          onChange('');
          return;
        }
        onChange(e.target.value);
      }}
    >
      {headLabel ? (
        <option value="">{headLabel}</option>
      ) : (
        <option value="" disabled>
          Select a branch…
        </option>
      )}
      <option value={MANUAL}>Other / type manually…</option>
      <option disabled>────────────</option>
      {branches.map((b) => (
        <option key={b} value={b}>
          {b}
          {b === current ? ' (current)' : ''}
        </option>
      ))}
    </Select>
  );
}

function ChangeBranchModal({
  box,
  branch,
  onClose,
  onDone,
  onRefresh,
}: {
  box: Box;
  branch: string;
  onClose: () => void;
  onDone: OnDone;
  onRefresh: () => void;
}) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = value.trim().length > 0;

  const submit = () => {
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    void (async () => {
      const res = await gitCheckoutAction(box.id, value.trim());
      if (res.ok) {
        onDone({ title: 'Branch changed', detail: firstLine(res.stdout, res.stderr) });
        onClose();
        onRefresh();
      } else {
        setError(res.error);
        setBusy(false);
      }
    })();
  };

  return (
    <Dialog onClose={onClose} className="max-w-[440px]">
      <DialogHeader>
        <DialogIcon>
          <Icons.branch />
        </DialogIcon>
        <div>
          <DialogTitle>Change branch</DialogTitle>
          <DialogDescription>
            {box.id} · currently on {branch}
          </DialogDescription>
        </div>
      </DialogHeader>
      <DialogBody>
        <Label htmlFor="gb-branch">Branch</Label>
        <BranchField boxId={box.id} id="gb-branch" value={value} onChange={setValue} currentBranch={branch} />
        <p className="mt-1.5 text-xs text-muted-foreground">
          The branch must exist and not be checked out in another worktree.
        </p>
        {error ? <p className="mt-2 break-words font-mono text-xs text-destructive">{error}</p> : null}
      </DialogBody>
      <DialogFooter>
        <Button variant="outline" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button onClick={submit} disabled={!ready || busy}>
          {busy ? <span className="spin" /> : <Icons.check />}
          {busy ? 'Checking out…' : 'Change branch'}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

function NewBranchModal({
  box,
  onClose,
  onDone,
  onRefresh,
}: {
  box: Box;
  onClose: () => void;
  onDone: OnDone;
  onRefresh: () => void;
}) {
  const [name, setName] = useState('');
  const [from, setFrom] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = name.trim().length > 0;

  const submit = () => {
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    void (async () => {
      const res = await gitBranchAction(box.id, name.trim(), from.trim() || undefined);
      if (res.ok) {
        onDone({ title: 'Branch created', detail: firstLine(res.stdout, res.stderr) });
        onClose();
        onRefresh();
      } else {
        setError(res.error);
        setBusy(false);
      }
    })();
  };

  return (
    <Dialog onClose={onClose} className="max-w-[440px]">
      <DialogHeader>
        <DialogIcon>
          <Icons.branch />
        </DialogIcon>
        <div>
          <DialogTitle>New branch</DialogTitle>
          <DialogDescription>{box.id} · branching in the box workspace</DialogDescription>
        </div>
      </DialogHeader>
      <DialogBody>
        <div className="mb-4">
          <Label htmlFor="nb-name">Name</Label>
          <Input
            id="nb-name"
            className="font-mono text-[13px]"
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit();
            }}
            placeholder="my-branch"
          />
          <p className="mt-1.5 text-xs text-muted-foreground">
            An <span className="font-mono">agentbox/</span> prefix is added when missing.
          </p>
        </div>
        <Label htmlFor="nb-from">
          Base ref <span className="font-normal text-[#a4a9b0]">(optional)</span>
        </Label>
        <BranchField boxId={box.id} id="nb-from" value={from} onChange={setFrom} headLabel="Current HEAD (default)" />
        <p className="mt-1.5 text-xs text-muted-foreground">Defaults to the box's current HEAD.</p>
        {error ? <p className="mt-2 break-words font-mono text-xs text-destructive">{error}</p> : null}
      </DialogBody>
      <DialogFooter>
        <Button variant="outline" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button onClick={submit} disabled={!ready || busy}>
          {busy ? <span className="spin" /> : <Icons.plus />}
          {busy ? 'Creating…' : 'Create branch'}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
