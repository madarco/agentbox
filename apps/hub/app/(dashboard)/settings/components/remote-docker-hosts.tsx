'use client';

// Remote-docker host aliases, nested inside the Remote Docker provider row.
// A PURE HTTP CLIENT like the rest of the Providers settings: list / add / remove
// / bake are all `fetch('/api/v1/hosts…')`, bake progress streams over the same
// per-job SSE the create modal + provider bake use. No server actions.

import { useCallback, useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Icons } from '@/components/icons';
import { JobLogStream } from '../../boxes/components/job-log-stream';

// Matches GET /api/v1/hosts (RemoteDockerHostView in lib/boxes/backend-types.ts).
// Defined inline to keep this a browser-only module.
interface RemoteDockerHost {
  alias: string;
  ssh: string;
  baked: boolean;
  bakedImageRef?: string;
  default: boolean;
}

// Mirror the server's alias rule (parseHostUpsert / api/v1/lib/validate.ts).
const ALIAS_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function errMessage(j: unknown, status: number): string {
  const m = (j as { error?: { message?: string } } | null)?.error?.message;
  return m ?? `request failed (${status})`;
}

export function RemoteDockerHosts({ onCount }: { onCount?: (n: number) => void }) {
  const [hosts, setHosts] = useState<RemoteDockerHost[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [warn, setWarn] = useState<string | null>(null);
  // One bake at a time — the hub serializes prepare jobs.
  const [bake, setBake] = useState<{ alias: string; jobId: string } | null>(null);
  const [bakeError, setBakeError] = useState<string | null>(null);
  const [busyAlias, setBusyAlias] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      const res = await fetch('/api/v1/hosts', { credentials: 'same-origin' });
      if (!res.ok) {
        setLoadError(errMessage(await res.json().catch(() => null), res.status));
        return;
      }
      const j = (await res.json()) as { hosts?: RemoteDockerHost[] };
      const list = j.hosts ?? [];
      setHosts(list);
      setLoadError(null);
      onCount?.(list.length);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }, [onCount]);

  useEffect(() => {
    void load();
  }, [load]);

  const startBake = async (alias: string): Promise<void> => {
    setBakeError(null);
    setBusyAlias(alias);
    try {
      const res = await fetch(`/api/v1/hosts/${encodeURIComponent(alias)}/bake`, {
        method: 'POST',
        credentials: 'same-origin',
      });
      const j = (await res.json().catch(() => null)) as { jobId?: string } | null;
      if (!res.ok || !j?.jobId) {
        setBakeError(`${alias}: ${errMessage(j, res.status)}`);
        return;
      }
      setBake({ alias, jobId: j.jobId });
    } catch (err) {
      setBakeError(`${alias}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusyAlias(null);
    }
  };

  const remove = async (alias: string): Promise<void> => {
    if (!window.confirm(`Remove host "${alias}"? Boxes created on it become unreachable. The remote machine is untouched.`))
      return;
    setRemoveError(null);
    setWarn(null);
    setBusyAlias(alias);
    try {
      const res = await fetch(`/api/v1/hosts/${encodeURIComponent(alias)}`, {
        method: 'DELETE',
        credentials: 'same-origin',
      });
      if (!res.ok) {
        setRemoveError(errMessage(await res.json().catch(() => null), res.status));
        return;
      }
      const j = (await res.json().catch(() => null)) as { boxesAffected?: string[] } | null;
      const affected = j?.boxesAffected ?? [];
      if (affected.length > 0) {
        setWarn(`Removed ${alias}. ${affected.length} box(es) are now unreachable: ${affected.join(', ')}`);
      }
      await load();
    } catch (err) {
      setRemoveError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyAlias(null);
    }
  };

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border/70 bg-card/50 p-3">
      {loadError ? <div className="text-xs text-red-400">Could not load hosts: {loadError}</div> : null}

      {hosts && hosts.length === 0 ? (
        <div className="text-[12.5px] text-muted-foreground">
          No hosts yet — add a machine you can SSH into to run boxes on its Docker engine.
        </div>
      ) : null}

      {hosts?.map((h) => (
        <div key={h.alias} className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="text-[13px] font-semibold">{h.alias}</span>
                {h.default ? <Badge className="normal-case">default</Badge> : null}
                {!h.baked ? <Badge className="badge-warn normal-case">not baked</Badge> : null}
              </div>
              <div className="truncate font-mono text-[11.5px] text-muted-foreground">{h.ssh}</div>
            </div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busyAlias === h.alias || !!bake}
              onClick={() => void startBake(h.alias)}
              title="Bake the box image on this host"
            >
              <Icons.refresh className="size-3.5" />
              {bake?.alias === h.alias ? 'Baking…' : h.baked ? 'Re-bake' : 'Bake'}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="destructive"
              disabled={busyAlias === h.alias || bake?.alias === h.alias}
              onClick={() => void remove(h.alias)}
            >
              <Icons.trash className="size-3.5" />
              Remove
            </Button>
          </div>
          {bake?.alias === h.alias ? (
            <JobLogStream
              jobId={bake.jobId}
              endpoint={`/api/v1/jobs/${encodeURIComponent(bake.jobId)}/logs`}
              onDone={() => {
                setBake(null);
                void load();
              }}
            />
          ) : null}
        </div>
      ))}

      {bakeError ? <div className="text-xs text-red-400">{bakeError}</div> : null}
      {removeError ? <div className="text-xs text-red-400">{removeError}</div> : null}
      {warn ? <div className="text-xs text-amber-400">{warn}</div> : null}

      <div className="mt-1">
        <Button type="button" size="sm" onClick={() => setAddOpen(true)}>
          <Icons.plus className="size-3.5" />
          Add host
        </Button>
      </div>

      {addOpen ? (
        <AddHostDialog
          firstHost={(hosts?.length ?? 0) === 0}
          onClose={() => setAddOpen(false)}
          onAdded={() => {
            setAddOpen(false);
            void load();
          }}
        />
      ) : null}
    </div>
  );
}

function AddHostDialog({
  firstHost,
  onClose,
  onAdded,
}: {
  firstHost: boolean;
  onClose: () => void;
  onAdded: () => void;
}) {
  const [alias, setAlias] = useState('');
  const [ssh, setSsh] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (): Promise<void> => {
    const a = alias.trim();
    const s = ssh.trim();
    if (!ALIAS_RE.test(a)) {
      setError('Alias must be a plain name (letters, digits, ., _, -; no @, :, /).');
      return;
    }
    if (!s) {
      setError('SSH connection is required.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/v1/hosts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        // The first host becomes the default so plain `agentbox claude` can use it.
        body: JSON.stringify({ alias: a, ssh: s, default: firstHost }),
      });
      if (!res.ok) {
        setError(errMessage(await res.json().catch(() => null), res.status));
        return;
      }
      onAdded();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog onClose={onClose}>
      <DialogHeader>
        <DialogTitle>Add Remote Docker host</DialogTitle>
      </DialogHeader>
      <DialogBody className="flex flex-col gap-3">
        <p className="text-[12.5px] text-muted-foreground">
          Register a machine you can SSH into — AgentBox runs boxes on its Docker engine. The host
          is probed (ssh + docker) before it&apos;s saved.
        </p>
        <div className="flex flex-col gap-1">
          <label className="text-[11.5px] font-medium text-muted-foreground">Alias</label>
          <Input
            value={alias}
            placeholder="buildbox"
            autoFocus
            onChange={(e) => setAlias(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-[11.5px] font-medium text-muted-foreground">SSH connection</label>
          <Input
            value={ssh}
            placeholder="user@host  (or an ~/.ssh/config alias)"
            className="font-mono text-xs"
            onChange={(e) => setSsh(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submit();
            }}
          />
        </div>
        {error ? <div className="text-xs text-red-400">{error}</div> : null}
      </DialogBody>
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button type="button" onClick={() => void submit()} disabled={busy}>
          {busy ? 'Adding…' : 'Add host'}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
