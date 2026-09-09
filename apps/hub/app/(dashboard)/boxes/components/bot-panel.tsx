'use client';

/**
 * The two bot-lifecycle actions that live ON a box: back it up, and clone it.
 *
 * The third — restore — is deliberately elsewhere. A bundle outlives the box it
 * came from, which is what a backup is for, so by the time you want to restore
 * one there is usually no box to click; the project page owns it.
 *
 * Backup and clone read as neighbours but are opposites, and the copy has to say
 * so: a BACKUP keeps the identity (that is the point — a restore that mints a new
 * gateway token has restored nothing), a CLONE deliberately discards it so the
 * new box onboards as a second, separate bot.
 *
 * A pure REST client, like every new hub UI: `fetch` against `/api/v1`, no server
 * actions, so it works unchanged against a remote control box.
 */

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
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
import type { Box } from '@/lib/boxes/types';
import { cn } from '@/lib/utils';
import { preferredBackup, readableStamp, type BotBackups } from './bots';
import { JobLogStream } from './job-log-stream';
import { SectionLabel } from './section-label';
import { useToasts, ToastStack, type OnToast } from './toasts';

interface BackupAnswer {
  bot: string;
  stamp: string;
  dir: string;
  state: boolean;
  files: number;
  pruned: string[];
}

/** Read the `{ error: { message } }` envelope, or fall back to the status. */
async function errorOf(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: { message?: string } };
    return body.error?.message ?? `HTTP ${String(res.status)}`;
  } catch {
    return `HTTP ${String(res.status)}`;
  }
}

function BotRow({
  label,
  desc,
  children,
}: {
  label: string;
  desc: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3 px-4.5 p-3.5">
      <div className="min-w-[150px] flex-1">
        <div className="text-[13.5px] font-medium">{label}</div>
        <div className="mt-0.5 text-[11.5px] leading-normal text-muted-foreground">{desc}</div>
      </div>
      <div className="flex flex-none flex-wrap gap-1.5">{children}</div>
    </div>
  );
}

function BusyButton({
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
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={disabled || busy}
      onClick={() => {
        setBusy(true);
        void onRun().finally(() => setBusy(false));
      }}
    >
      {busy ? <span className="spin" style={{ width: 12, height: 12 }} /> : <Ic />}
      {children}
    </Button>
  );
}

export function BotPanel({ box }: { box: Box }) {
  const router = useRouter();
  const { toasts, push, dismiss } = useToasts();
  const [cloneOpen, setCloneOpen] = useState(false);
  const [latest, setLatest] = useState<{ stamp: string; state: boolean } | null>(null);
  // A synthetic create-job row has no container: neither action can work on it.
  const synthetic = box.id.startsWith('job:');
  const offline = box.status !== 'running';
  const canBackup = box.supportsBackup === true && !synthetic;

  const loadLatest = useCallback(async () => {
    if (!canBackup) return;
    try {
      const r = await fetch(`/api/v1/projects/${encodeURIComponent(box.projectId)}/bots`, {
        credentials: 'same-origin',
      });
      if (!r.ok) return;
      const { bots } = (await r.json()) as { bots: BotBackups[] };
      // Match on the box's own name, which is what `backup` files a bundle under
      // by default. A bundle the user named something else is the project page's
      // business, not this box's.
      const mine = bots.find((b) => b.bot === (box.name ?? ''));
      // `preferredBackup` answers with a RESTORABLE one; fall back to the newest
      // of any kind, so a bot whose only backups are workspace-only still shows
      // when it was last captured rather than reading as never backed up.
      const found = mine ? (preferredBackup(mine) ?? mine.backups[0]) : undefined;
      setLatest(found ? { stamp: found.stamp, state: found.state } : null);
    } catch {
      setLatest(null);
    }
  }, [box.projectId, box.name, canBackup]);

  useEffect(() => {
    void loadLatest();
  }, [loadLatest]);

  if (synthetic) return null;

  const runBackup = async () => {
    let res: Response;
    try {
      res = await fetch(`/api/v1/boxes/${encodeURIComponent(box.id)}/backup`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
    } catch (err) {
      // A hub restart mid-backup rejects the fetch. Without this the rejection
      // went unhandled and the user saw only the spinner stop — no toast, no
      // way to tell a failure from a success.
      push({
        variant: 'error',
        title: 'Backup failed',
        detail: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    if (!res.ok) {
      push({ variant: 'error', title: 'Backup failed', detail: await errorOf(res) });
      return;
    }
    const b = (await res.json()) as BackupAnswer;
    push({
      title: `Backed up ${b.bot}`,
      // Named rather than implied: the difference between a bundle you can
      // restore this bot from and one you can only start a fresh bot from is the
      // whole value of the operation.
      detail: b.state
        ? `${b.stamp} — ${String(b.files)} file(s) + identity`
        : `${b.stamp} — ${String(b.files)} file(s), NO identity captured`,
      ...(b.state ? {} : { variant: 'error' as const }),
    });
    void loadLatest();
    router.refresh();
  };

  return (
    <>
      <SectionLabel>Bot</SectionLabel>
      <Card className="divide-y divide-border/60 overflow-hidden">
        {offline ? (
          <div className="flex items-center gap-2.5 bg-[var(--amber-soft)] px-4.5 p-2.5 text-[12.5px] text-[var(--amber)]">
            <Icons.warn className="size-3.5 flex-none" />
            Box is {box.status} — backing up and cloning both read the live box.
          </div>
        ) : null}
        {canBackup ? (
          <BotRow
            label="Backup"
            desc={
              latest ? (
                <>
                  Last backup {readableStamp(latest.stamp)}
                  {latest.state ? '' : ' (workspace only)'}
                </>
              ) : (
                'Workspace + this bot’s identity: auth token, pairings, history.'
              )
            }
          >
            <BusyButton icon={Icons.shield} disabled={offline} onRun={runBackup}>
              Back up now
            </BusyButton>
          </BotRow>
        ) : null}
        <BotRow
          label="Clone"
          desc="A second box from these files, with a fresh identity of its own. Not a backup."
        >
          <Button variant="outline" size="sm" disabled={offline} onClick={() => setCloneOpen(true)}>
            <Icons.copy />
            Clone&hellip;
          </Button>
        </BotRow>
      </Card>

      {cloneOpen ? (
        <CloneModal box={box} onClose={() => setCloneOpen(false)} onDone={push} />
      ) : null}
      <ToastStack toasts={toasts} dismiss={dismiss} />
    </>
  );
}

/**
 * Clone this box into a new one.
 *
 * The refusal path matters more than the happy one here. `prepareClone` refuses a
 * bot whose per-box secrets are missing, and its message names the exact 0600
 * file to create — so it is rendered verbatim and left on screen, rather than
 * flashed as a toast, because it is a to-do list rather than a notification.
 */
function CloneModal({ box, onClose, onDone }: { box: Box; onClose: () => void; onDone: OnToast }) {
  const router = useRouter();
  const [name, setName] = useState(`${box.name ?? box.task}-clone`);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);

  /** Returns whether the clone actually started, for the caller's toast. */
  const submit = async (): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/v1/boxes/${encodeURIComponent(box.id)}/clone`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: name.trim() || undefined }),
      });
      if (!res.ok) {
        setError(await errorOf(res));
        return false;
      }
      const body = (await res.json()) as { jobId: string };
      setJobId(body.jobId);
      router.refresh();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog onClose={onClose}>
      <DialogHeader>
        <DialogIcon>
          <Icons.copy className="size-4" />
        </DialogIcon>
        <div>
          <DialogTitle>Clone {box.task}</DialogTitle>
          <DialogDescription>
            A new box from this one&rsquo;s workspace files and its <code>agentbox.yaml</code>, with
            a <strong>fresh identity</strong> &mdash; it onboards from scratch and generates its own
            token. To keep this box&rsquo;s identity instead, back it up and restore it.
          </DialogDescription>
        </div>
      </DialogHeader>
      <DialogBody>
        {jobId ? (
          <JobLogStream jobId={jobId} endpoint={`/api/v1/jobs/${jobId}/logs`} />
        ) : (
          <>
            <Label htmlFor="clone-name">New box name</Label>
            <Input
              id="clone-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="my-bot-clone"
            />
            {error ? (
              <div
                className={cn(
                  'mt-3 rounded-lg border border-[var(--red-line)] bg-[var(--red-soft)] p-3',
                  'text-[12.5px] leading-relaxed text-[var(--red)]',
                )}
              >
                {error}
              </div>
            ) : null}
          </>
        )}
      </DialogBody>
      <DialogFooter>
        <Button variant="outline" size="sm" onClick={onClose}>
          {jobId ? 'Close' : 'Cancel'}
        </Button>
        {jobId ? null : (
          <Button
            size="sm"
            disabled={busy || name.trim().length === 0}
            onClick={() => {
              // The RETURNED value, not the `error` state: that one is the render's
              // closure, still null on the first attempt, so a refused clone showed
              // the red box AND a green "Clone started" toast.
              void submit().then((started) => {
                if (started) onDone({ title: 'Clone started' });
              });
            }}
          >
            {busy ? <span className="spin" style={{ width: 12, height: 12 }} /> : <Icons.copy />}
            Clone
          </Button>
        )}
      </DialogFooter>
    </Dialog>
  );
}
