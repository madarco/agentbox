'use client';

// Devices page — the PCs enrolled on this hub with `agentbox hub login`, and the
// enrollment codes waiting for the owner. PURE REST CLIENT over /api/v1/devices:
// approve or deny a code (the one `hub login` printed is highlighted when the
// page is opened from its link), rename or revoke a device.
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
import { Input } from '@/components/ui/input';
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
  const [typed, setTyped] = useState('');
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
    if (code) setTyped(normalizeCode(code));
    setOrigin(window.location.origin);
    void load();
    // A code opened on the PC shows up here within a few seconds without a reload.
    const t = setInterval(() => void load(), 4000);
    return () => clearInterval(t);
  }, [load]);

  const act = async (key: string, fn: () => Promise<unknown>): Promise<void> => {
    setBusy(key);
    setActionError(null);
    try {
      await fn();
      await load();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
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

  const rename = (d: Device) => {
    const label = window.prompt('Device name', d.label);
    if (!label || label === d.label) return;
    void act(`rename:${d.id}`, () =>
      api(`/${encodeURIComponent(d.id)}`, { method: 'PATCH', body: JSON.stringify({ label }) }),
    );
  };

  const match = pending.find((p) => p.userCode === normalizeCode(typed));
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
          {actionError ? (
            <div className="mt-4 font-mono text-xs text-red-400">{actionError}</div>
          ) : null}

          <SectionLabel>Approve a computer</SectionLabel>
          <Card className="p-4 px-5">
            <div className="text-[13px] text-muted-foreground">
              Enter the code `agentbox hub login` printed on the computer you want to add.
            </div>
            <form
              className="mt-3 flex items-center gap-2 max-sm:flex-wrap"
              onSubmit={(ev) => {
                ev.preventDefault();
                if (match) void decide(match.userCode, 'approve');
              }}
            >
              <Input
                value={typed}
                onChange={(ev) => setTyped(ev.target.value)}
                placeholder="XXXX-XXXX"
                className="w-40 font-mono uppercase tracking-wider"
                autoComplete="off"
              />
              <Button type="submit" size="sm" disabled={busy !== null || !match}>
                <Icons.check /> Approve
              </Button>
            </form>
            {match ? (
              <div className="mt-3 text-[13px]">
                <PendingDetails p={match} />
              </div>
            ) : normalizeCode(typed).length === 9 ? (
              <div className="mt-3 text-[12px] text-red-400">
                No waiting code matches. It may have expired; run `hub login` again.
              </div>
            ) : null}
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
            <DeviceList devices={active} busy={busy} onRename={rename} onRevoke={revoke} />
          )}

          {revoked.length > 0 ? (
            <>
              <SectionLabel>Revoked</SectionLabel>
              <DeviceList devices={revoked} busy={busy} />
            </>
          ) : null}
        </>
      )}
    </div>
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
