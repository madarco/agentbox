'use client';

/**
 * The bots this project holds a backup of, and the button that brings one back.
 *
 * Restore lives HERE rather than on a box because a bundle outlives the box it
 * came from — that is the point of a backup — so by the time you want one there
 * is usually no box left to click. The project is what still exists.
 *
 * Self-hides when the project has no bots, which is every project until someone
 * backs a bot up.
 *
 * A pure REST client: `fetch` against `/api/v1`, no server actions.
 */

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Icons } from '@/components/icons';
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
import { JobLogStream } from '../../../boxes/components/job-log-stream';
import { SectionLabel } from '../../../boxes/components/section-label';
import { cn } from '@/lib/utils';

interface Backup {
  stamp: string;
  agent?: string;
  state: boolean;
  boxName?: string;
  provider?: string;
}
interface Bot {
  bot: string;
  latest?: string;
  backups: Backup[];
}

function readableStamp(stamp: string): string {
  const d = new Date(
    stamp.replace(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})Z$/, '$1T$2:$3:$4Z'),
  );
  return Number.isNaN(d.getTime()) ? stamp : d.toLocaleString();
}

async function errorOf(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: { message?: string } };
    return body.error?.message ?? `HTTP ${String(res.status)}`;
  } catch {
    return `HTTP ${String(res.status)}`;
  }
}

export function ProjectBots({ projectId }: { projectId: string }) {
  const [bots, setBots] = useState<Bot[]>([]);
  const [restoring, setRestoring] = useState<Bot | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/v1/projects/${encodeURIComponent(projectId)}/bots`, {
        credentials: 'same-origin',
      });
      if (!r.ok) {
        setBots([]);
        return;
      }
      const { bots: found } = (await r.json()) as { bots: Bot[] };
      setBots(found);
    } catch {
      setBots([]);
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (bots.length === 0) return null;

  return (
    <>
      <SectionLabel>Bot backups</SectionLabel>
      <Card className="divide-y divide-border/60 overflow-hidden">
        {bots.map((b) => {
          const newest = b.backups.find((x) => x.stamp === b.latest) ?? b.backups[0];
          // A bundle with no state half restores a workspace and a FRESH
          // identity, which is what clone already does — the route refuses it, so
          // the button must not offer it either.
          const restorable = b.backups.some((x) => x.state);
          return (
            <div key={b.bot} className="flex flex-wrap items-center gap-3 px-4.5 p-3.5">
              <div className="min-w-[180px] flex-1">
                <div className="font-mono text-[13.5px] font-medium">{b.bot}</div>
                <div className="mt-0.5 text-[11.5px] text-muted-foreground">
                  {b.backups.length} backup{b.backups.length === 1 ? '' : 's'}
                  {newest ? ` · newest ${readableStamp(newest.stamp)}` : ''}
                  {restorable ? '' : ' · workspace only, no identity captured'}
                </div>
              </div>
              <Button
                variant="outline"
                size="sm"
                disabled={!restorable}
                title={
                  restorable
                    ? undefined
                    : 'These backups captured no agent state, so there is no identity to restore.'
                }
                onClick={() => setRestoring(b)}
              >
                <Icons.refresh />
                Restore&hellip;
              </Button>
            </div>
          );
        })}
      </Card>
      {restoring ? (
        <RestoreModal
          projectId={projectId}
          bot={restoring}
          onClose={() => {
            setRestoring(null);
            void load();
          }}
        />
      ) : null}
    </>
  );
}

/**
 * Restore one bot: pick a backup, name the box, watch the create.
 *
 * The refusals this can hit are the interesting output — the source box still
 * running, a destination another box occupies — so they are rendered in place and
 * left on screen rather than flashed, because each one names a thing the user has
 * to go and do.
 */
function RestoreModal({
  projectId,
  bot,
  onClose,
}: {
  projectId: string;
  bot: Bot;
  onClose: () => void;
}) {
  const router = useRouter();
  const restorable = bot.backups.filter((b) => b.state);
  const [stamp, setStamp] = useState(
    restorable.find((b) => b.stamp === bot.latest)?.stamp ?? restorable[0]?.stamp ?? '',
  );
  const [name, setName] = useState(bot.bot);
  const [force, setForce] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/v1/projects/${encodeURIComponent(projectId)}/restore`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          bot: bot.bot,
          stamp: stamp || undefined,
          name: name.trim() || undefined,
          ...(force ? { force: true } : {}),
        }),
      });
      if (!res.ok) {
        setError(await errorOf(res));
        return;
      }
      const body = (await res.json()) as { jobId: string };
      setJobId(body.jobId);
      router.refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog onClose={onClose}>
      <DialogHeader>
        <DialogIcon>
          <Icons.refresh className="size-4" />
        </DialogIcon>
        <div>
          <DialogTitle>Restore {bot.bot}</DialogTitle>
          <DialogDescription>
            A new box from this backup, with <strong>the same identity</strong> &mdash; same auth
            token, same pairings, same history. It is refused while the box this backup came from is
            still running: two live gateways cannot share one identity.
          </DialogDescription>
        </div>
      </DialogHeader>
      <DialogBody>
        {jobId ? (
          <JobLogStream jobId={jobId} endpoint={`/api/v1/jobs/${jobId}/logs`} />
        ) : (
          <>
            <Label htmlFor="restore-stamp">Backup</Label>
            <Select
              id="restore-stamp"
              value={stamp}
              onChange={(e) => setStamp(e.target.value)}
              className="mb-3"
            >
              {restorable.map((b) => (
                <option key={b.stamp} value={b.stamp}>
                  {readableStamp(b.stamp)}
                  {b.stamp === bot.latest ? ' (latest)' : ''}
                  {b.provider ? ` — from ${b.provider}` : ''}
                </option>
              ))}
            </Select>
            <Label htmlFor="restore-name">New box name</Label>
            <Input id="restore-name" value={name} onChange={(e) => setName(e.target.value)} />
            <label className="mt-3 flex items-center gap-2 text-[12.5px] text-muted-foreground">
              <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} />
              Restore even if the source box is still running, or the destination is not empty
            </label>
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
          <Button size="sm" disabled={busy || stamp.length === 0} onClick={() => void submit()}>
            {busy ? <span className="spin" style={{ width: 12, height: 12 }} /> : <Icons.refresh />}
            Restore
          </Button>
        )}
      </DialogFooter>
    </Dialog>
  );
}
