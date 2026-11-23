'use client';

// The pending-update view: what approving a skill's pending version changes,
// file by file, plus the hub's secret scan of that version, then Approve.
// Pure /api/v1 client: GET /skills/{name}/diff, POST /skills/{name}/approve.

import { useEffect, useState } from 'react';
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
import { cn } from '@/lib/utils';
import { api, errText, short, type SkillDiff, type SkillDiffFile, type SkillRow } from './api';
import { Findings } from './findings';
import { hunks, lineDiff } from './line-diff';

const STATUS_MARK: Record<SkillDiffFile['status'], string> = {
  added: '+',
  removed: '−',
  modified: '~',
};

function FileDiff({ f }: { f: SkillDiffFile }) {
  const [open, setOpen] = useState(f.path === 'SKILL.md' || f.status !== 'modified');
  const body =
    f.modeOnly || f.binary
      ? null
      : f.status === 'added'
        ? lineDiff('', f.after ?? '')
        : f.status === 'removed'
          ? lineDiff(f.before ?? '', '')
          : f.before !== undefined && f.after !== undefined
            ? lineDiff(f.before, f.after)
            : null;
  const note = f.modeOnly
    ? 'mode changed'
    : f.binary
      ? 'binary'
      : body === null
        ? 'too large to show'
        : null;
  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <button
        className="flex w-full cursor-pointer items-center gap-2 border-0 bg-background px-3 py-2 text-left font-mono text-xs"
        onClick={() => setOpen((o) => !o)}
      >
        <span
          className={cn(
            'w-3 flex-none text-center',
            f.status === 'added' && 'text-[var(--green-ink)]',
            f.status === 'removed' && 'text-[var(--red)]',
            f.status === 'modified' && 'text-[var(--amber)]',
          )}
        >
          {STATUS_MARK[f.status]}
        </span>
        <span className="min-w-0 flex-1 truncate text-secondary-foreground">{f.path}</span>
        {note ? <span className="text-muted-foreground">{note}</span> : null}
        {body ? (
          <Icons.chevR
            className={cn('size-3 flex-none transition-transform', open && 'rotate-90')}
          />
        ) : null}
      </button>
      {open && body ? (
        <pre className="m-0 max-h-[360px] overflow-auto border-t border-border bg-card py-1 font-mono text-[11.5px] leading-[1.55]">
          {hunks(body).map((l, i) =>
            l.op === '…' ? (
              <div key={i} className="px-3 text-muted-foreground">
                ⋯ {l.skipped} unchanged line{l.skipped === 1 ? '' : 's'}
              </div>
            ) : (
              <div
                key={i}
                className={cn(
                  'whitespace-pre-wrap break-all px-3',
                  l.op === '+' && 'bg-[var(--green-soft)] text-[var(--green-ink)]',
                  l.op === '-' && 'bg-[var(--red-soft)] text-[var(--red)]',
                )}
              >
                {l.op} {l.text}
              </div>
            ),
          )}
        </pre>
      ) : null}
    </div>
  );
}

export function UpdateDialog({
  skill,
  onClose,
  onApproved,
}: {
  skill: SkillRow;
  onClose: () => void;
  onApproved: () => void;
}) {
  const [diff, setDiff] = useState<SkillDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = skill.pending;

  useEffect(() => {
    if (!pending) return;
    const q = new URLSearchParams({ from: skill.current, to: pending.version });
    api<SkillDiff>(`/skills/${encodeURIComponent(skill.name)}/diff?${q.toString()}`)
      .then(setDiff)
      .catch((err: unknown) => setError(errText(err)));
  }, [skill.name, skill.current, pending]);

  const approve = async () => {
    setBusy(true);
    setError(null);
    try {
      // Pin the version reviewed here: a refresh that moved `pending` meanwhile is refused.
      await api(`/skills/${encodeURIComponent(skill.name)}/approve`, {
        method: 'POST',
        body: JSON.stringify({ version: pending?.version }),
      });
      onApproved();
      onClose();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog onClose={onClose} className="max-w-[860px]">
      <DialogHeader>
        <DialogIcon>
          <Icons.refresh />
        </DialogIcon>
        <div className="min-w-0">
          <DialogTitle>Update {skill.name}</DialogTitle>
          <DialogDescription>
            {short(skill.current)} → {pending ? short(pending.version) : '—'}
            {pending?.commit ? ` · commit ${pending.commit.slice(0, 12)}` : ''}
          </DialogDescription>
        </div>
      </DialogHeader>
      <DialogBody className="flex max-h-[65vh] flex-col gap-3 overflow-y-auto">
        {!pending ? (
          <div className="text-sm text-muted-foreground">No update is waiting for this skill.</div>
        ) : error && !diff ? (
          <div className="font-mono text-xs text-red-400">{error}</div>
        ) : !diff ? (
          <div className="text-sm text-muted-foreground">Loading the diff…</div>
        ) : (
          <>
            <Findings findings={diff.findings} />
            <div className="font-mono text-[11px] uppercase tracking-[.1em] text-[#a4a9b0]">
              {diff.files.length} file{diff.files.length === 1 ? '' : 's'} changed
            </div>
            {diff.files.map((f) => (
              <FileDiff key={f.path} f={f} />
            ))}
          </>
        )}
      </DialogBody>
      <DialogFooter className="items-center">
        {error && diff ? (
          <span className="mr-auto font-mono text-xs text-red-400">{error}</span>
        ) : (
          <span className="mr-auto text-xs text-muted-foreground">
            Approving makes it current; running boxes that hold it sync now. An agent picks it up at
            its next session.
          </span>
        )}
        <Button variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button disabled={!pending || busy} onClick={() => void approve()}>
          {busy ? 'Approving…' : 'Approve update'}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
