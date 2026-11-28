'use client';

// Devices page — the PCs enrolled on this hub with `agentbox hub login`, and the
// enrollment codes waiting for the owner. PURE REST CLIENT over /api/v1/devices:
// approve or deny a code (the approve dialog opens filled in when the page is
// opened from the `hub login` link), rename or revoke a device.
//
// Approval is by code, never by a click on a listed row (RFC 8628's rule):
// anyone who can reach the hub can open a code labelled like your laptop, so the
// only proof is the code you can read on your own screen — typed here, or carried
// in the `?code=` link `hub login` printed.

import { useCallback, useEffect, useState } from 'react';
import { Ago } from '@/components/ago';
import { Icons } from '@/components/icons';
import { Badge } from '@/components/ui/badge';
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
import { EmptyBox } from '../../boxes/components/empty-box';
import { SectionLabel } from '../../boxes/components/section-label';

interface Device {
  id: string;
  label: string;
  createdAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
}

interface Pending {
  userCode: string;
  deviceId: string;
  label: string;
  createdAt: string;
  expiresAt: string;
  reenroll: boolean;
  proven: boolean;
  sourceIp: string;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`/api/v1/devices${path}`, {
    credentials: 'same-origin',
    ...init,
    headers: { 'content-type': 'application/json', ...init?.headers },
  });
  const body = (await r.json().catch(() => ({}))) as { error?: { message?: string } };
  if (!r.ok) throw new Error(body.error?.message ?? `request failed (${String(r.status)})`);
  return body as T;
}

function normalizeCode(raw: string): string {
  const s = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return s.length === 8 ? `${s.slice(0, 4)}-${s.slice(4)}` : s;
}

export default function DevicesPage() {
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [pending, setPending] = useState<Pending[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // The approve dialog's code (null = closed); a `?code=` link opens it filled in.
  const [approving, setApproving] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<Device | null>(null);
  const [origin, setOrigin] = useState('');

  const load = useCallback(async () => {
    try {
      const [d, p] = await Promise.all([
        api<{ devices: Device[] }>(''),
        api<{ pending: Pending[] }>('/pending'),
      ]);
      setDevices(d.devices);
      setPending(p.pending);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    const code = new URLSearchParams(window.location.search).get('code');
    if (code) setApproving(normalizeCode(code));
    setOrigin(window.location.origin);
    void load();
    // A code opened on the PC shows up here within a few seconds without a reload.
    const t = setInterval(() => void load(), 4000);
    return () => clearInterval(t);
  }, [load]);

  /** True when `fn` succeeded. */
  const act = async (key: string, fn: () => Promise<unknown>): Promise<boolean> => {
    setBusy(key);
    setActionError(null);
    try {
      await fn();
      await load();
      return true;
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setBusy(null);
    }
  };

  const decide = (userCode: string, verb: 'approve' | 'deny') =>
    act(`${verb}:${userCode}`, () =>
      api(`/${verb}`, { method: 'POST', body: JSON.stringify({ userCode }) }),
    );

  const revoke = (d: Device) => {
    if (!window.confirm(`Revoke ${d.label}? Its next request to this hub will be refused.`)) return;
    void act(`revoke:${d.id}`, () =>
      api(`/${encodeURIComponent(d.id)}/revoke`, { method: 'POST' }),
    );
  };

  const rename = (d: Device, label: string) =>
    act(`rename:${d.id}`, () =>
      api(`/${encodeURIComponent(d.id)}`, { method: 'PATCH', body: JSON.stringify({ label }) }),
    );

  // Drop a `?code=` the dialog was opened from, so a reload does not reopen it.
  const closeApprove = () => {
    setApproving(null);
    const url = new URL(window.location.href);
    if (url.searchParams.has('code')) {
      url.searchParams.delete('code');
      window.history.replaceState(window.history.state, '', url);
    }
  };

  const active = devices?.filter((d) => !d.revokedAt) ?? [];
  const revoked = devices?.filter((d) => d.revokedAt) ?? [];

  return (
    <div className="mx-auto w-full max-w-[1080px] px-8 pb-16 pt-8 max-sm:px-4">
      <h1 className="text-[25px] font-semibold leading-tight tracking-[-0.025em]">Devices</h1>
      <div className="mt-1.5 text-sm text-muted-foreground">
        The computers that can use this hub. Each holds its own token from{' '}
        <span className="font-mono text-secondary-foreground">agentbox hub login</span>, so a lost
        laptop is one revocation.
      </div>

      {error ? (
        <div className="mt-6">
          <EmptyBox>
            <div>Couldn’t load devices.</div>
            <div className="mt-1.5 font-mono text-xs text-red-400">{error}</div>
          </EmptyBox>
        </div>
      ) : !devices ? (
        <div className="mt-8 text-sm text-muted-foreground">Loading…</div>
      ) : (
        <>
          {/* An open dialog shows its own error. */}
          {actionError && approving === null && !renaming ? (
            <div className="mt-4 font-mono text-xs text-red-400">{actionError}</div>
          ) : null}

          <SectionLabel>Approve a computer</SectionLabel>
          <Card className="flex items-center gap-4 p-4 px-5 max-sm:flex-wrap">
            <div className="min-w-0 flex-1 text-[13px] text-muted-foreground">
              Enter the code `agentbox hub login` printed on the computer you want to add.
            </div>
            <Button
              size="sm"
              disabled={busy !== null}
              onClick={() => {
                setActionError(null);
                setApproving('');
              }}
            >
              <Icons.check /> Approve a computer
            </Button>
          </Card>

          <SectionLabel
            right={
              pending.length > 0 ? (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy !== null}
                  onClick={() => void act('clear', () => api('/pending', { method: 'DELETE' }))}
                >
                  Deny all
                </Button>
              ) : null
            }
          >
            Waiting
          </SectionLabel>
          {pending.length === 0 ? (
            <EmptyBox>
              <div>No device is waiting.</div>
              <div className="mt-1.5 font-mono text-xs text-muted-foreground">
                Run `agentbox hub login {origin}` on the computer you want to add.
              </div>
            </EmptyBox>
          ) : (
            <Card className="divide-y divide-border/60 overflow-hidden">
              {pending.map((p) => (
                <div key={p.userCode} className="flex items-center gap-4 p-4 px-5 max-sm:flex-wrap">
                  <div className="min-w-0 flex-1">
                    <PendingDetails p={p} />
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy !== null}
                    onClick={() => void decide(p.userCode, 'deny')}
                  >
                    Deny
                  </Button>
                </div>
              ))}
            </Card>
          )}
          <div className="mt-2 text-[12px] text-muted-foreground">
            Codes are not shown here on purpose: approve only one you can read on your own screen.
          </div>

          <SectionLabel
            right={
              <span className="font-mono text-[11px] tracking-normal text-[var(--faint)]">
                {active.length}
              </span>
            }
          >
            Enrolled
          </SectionLabel>
          {active.length === 0 ? (
            <EmptyBox>
              <div>No device is enrolled yet.</div>
            </EmptyBox>
          ) : (
            <DeviceList
              devices={active}
              busy={busy}
              onRename={(d) => {
                setActionError(null);
                setRenaming(d);
              }}
              onRevoke={revoke}
            />
          )}

          {revoked.length > 0 ? (
            <>
              <SectionLabel>Revoked</SectionLabel>
              <DeviceList devices={revoked} busy={busy} />
            </>
          ) : null}
        </>
      )}
      {/* Opened only once the waiting codes are loaded, so a `?code=` link never
          flashes "no waiting code matches" for a valid code. */}
      {approving !== null && devices ? (
        <ApproveDialog
          initial={approving}
          pending={pending}
          busy={busy !== null}
          error={actionError}
          onClose={() => {
            closeApprove();
            setActionError(null);
          }}
          onApprove={async (userCode) => {
            if (await decide(userCode, 'approve')) closeApprove();
          }}
        />
      ) : null}
      {renaming ? (
        <RenameDialog
          device={renaming}
          busy={busy !== null}
          error={actionError}
          onClose={() => {
            setRenaming(null);
            setActionError(null);
          }}
          onRename={async (label) => {
            if (await rename(renaming, label)) setRenaming(null);
          }}
        />
      ) : null}
    </div>
  );
}

function ApproveDialog({
  initial,
  pending,
  busy,
  error,
  onClose,
  onApprove,
}: {
  initial: string;
  pending: Pending[];
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onApprove: (userCode: string) => Promise<void>;
}) {
  const [typed, setTyped] = useState(initial);
  const match = pending.find((p) => p.userCode === normalizeCode(typed));
  return (
    <Dialog onClose={busy ? () => {} : onClose}>
      <DialogHeader>
        <DialogIcon>
          <Icons.host />
        </DialogIcon>
        <div>
          <DialogTitle>Approve a computer</DialogTitle>
          <DialogDescription>the code `agentbox hub login` printed</DialogDescription>
        </div>
      </DialogHeader>
      <form
        onSubmit={(ev) => {
          ev.preventDefault();
          if (match) void onApprove(match.userCode);
        }}
      >
        <DialogBody className="flex flex-col gap-3">
          <div>
            <Label htmlFor="device-code">Code</Label>
            <Input
              id="device-code"
              value={typed}
              onChange={(ev) => setTyped(ev.target.value)}
              placeholder="XXXX-XXXX"
              className="font-mono uppercase tracking-wider"
              autoComplete="off"
              autoFocus
              disabled={busy}
            />
          </div>
          {match ? (
            <div className="rounded-lg border border-border bg-background p-3 text-[13px]">
              <PendingDetails p={match} />
            </div>
          ) : normalizeCode(typed).length === 9 ? (
            <div className="text-[12px] text-red-400">
              No waiting code matches. It may have expired; run `hub login` again.
            </div>
          ) : (
            <div className="text-[12px] text-muted-foreground">
              Approve only a code you can read on your own screen.
            </div>
          )}
          {error ? <div className="font-mono text-xs text-red-400">{error}</div> : null}
        </DialogBody>
        <DialogFooter>
          <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={busy || !match}>
            <Icons.check /> {busy ? 'Approving…' : 'Approve'}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

function RenameDialog({
  device,
  busy,
  error,
  onClose,
  onRename,
}: {
  device: Device;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onRename: (label: string) => Promise<void>;
}) {
  const [label, setLabel] = useState(device.label);
  const next = label.trim();
  return (
    <Dialog onClose={busy ? () => {} : onClose}>
      <DialogHeader>
        <DialogIcon>
          <Icons.pencil />
        </DialogIcon>
        <div>
          <DialogTitle>Rename device</DialogTitle>
          <DialogDescription>{device.id}</DialogDescription>
        </div>
      </DialogHeader>
      <form
        onSubmit={(ev) => {
          ev.preventDefault();
          if (next && next !== device.label) void onRename(next);
        }}
      >
        <DialogBody className="flex flex-col gap-3">
          <div>
            <Label htmlFor="device-label">Name</Label>
            <Input
              id="device-label"
              value={label}
              onChange={(ev) => setLabel(ev.target.value)}
              autoComplete="off"
              autoFocus
              disabled={busy}
            />
          </div>
          {error ? <div className="font-mono text-xs text-red-400">{error}</div> : null}
        </DialogBody>
        <DialogFooter>
          <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={busy || !next || next === device.label}>
            {busy ? 'Saving…' : 'Save'}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

function PendingDetails({ p }: { p: Pending }) {
  return (
    <>
      <div className="truncate text-[13.5px] font-medium">{p.label}</div>
      <div className="truncate font-mono text-[11px] text-[var(--faint)]" title={p.deviceId}>
        {p.deviceId} · from {p.sourceIp || 'unknown address'} · opened{' '}
        <Ago ms={Date.parse(p.createdAt)} />
        {p.reenroll && p.proven ? ' · re-login from this enrolled computer' : ''}
      </div>
      {p.reenroll && !p.proven ? (
        <div className="mt-0.5 text-[12px] text-red-400">
          Claims an enrolled computer&apos;s id without its token. Approving replaces that
          computer&apos;s token: approve only if you just ran `hub login` there.
        </div>
      ) : null}
    </>
  );
}

function DeviceList({
  devices,
  busy,
  onRename,
  onRevoke,
}: {
  devices: Device[];
  busy: string | null;
  onRename?: (d: Device) => void;
  onRevoke?: (d: Device) => void;
}) {
  return (
    <Card className="divide-y divide-border/60 overflow-hidden">
      {devices.map((d) => (
        <div key={d.id} className="flex items-center gap-4 p-4 px-5 max-sm:flex-wrap">
          <Icons.host className="size-4 flex-none text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13.5px] font-medium">{d.label}</div>
            <div className="truncate font-mono text-[11px] text-[var(--faint)]" title={d.id}>
              {d.id}
            </div>
          </div>
          <div className="w-32 text-right text-[12px] text-muted-foreground">
            {d.revokedAt ? (
              <Badge className="px-1.5 py-0 text-[10px] normal-case">
                revoked <Ago ms={Date.parse(d.revokedAt)} />
              </Badge>
            ) : d.lastSeenAt ? (
              <>
                seen <Ago ms={Date.parse(d.lastSeenAt)} />
              </>
            ) : (
              'never used'
            )}
          </div>
          {onRename ? (
            <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => onRename(d)}>
              <Icons.pencil /> Rename
            </Button>
          ) : null}
          {onRevoke ? (
            <Button
              size="sm"
              variant="destructive"
              disabled={busy !== null}
              onClick={() => onRevoke(d)}
            >
              Revoke
            </Button>
          ) : null}
        </div>
      ))}
    </Card>
  );
}
