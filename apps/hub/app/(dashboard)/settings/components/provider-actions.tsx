'use client';

// Providers settings — install (credentials) + bake (image) a sandbox provider
// entirely over the public REST API. This is a PURE HTTP CLIENT: every mutation
// is a `fetch('/api/v1/...')`, never a server action, so it keeps working when
// the hub runs remotely (see docs/hub-provider-install-plan.md). Bake progress
// streams over the same per-job SSE the create modal uses, via JobLogStream.

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Icons } from '@/components/icons';
import { cn } from '@/lib/utils';
import { useStore } from '@/lib/boxes/store';
import type { ProviderOption } from '@/lib/boxes/types';
import { JobLogStream } from '../../boxes/components/job-log-stream';

interface CredField {
  key: string;
  label: string;
  placeholder?: string;
  optional?: boolean;
}

// Per-provider credential fields (token/key only — no interactive browser flow).
const CRED_FIELDS: Record<string, CredField[]> = {
  docker: [],
  e2b: [{ key: 'apiKey', label: 'API key', placeholder: 'e2b_…' }],
  daytona: [{ key: 'apiKey', label: 'API key', placeholder: 'dtn_…' }],
  hetzner: [{ key: 'token', label: 'API token', placeholder: 'project read+write token' }],
  vercel: [
    { key: 'token', label: 'Access token', placeholder: 'vercel token' },
    { key: 'teamId', label: 'Team ID', placeholder: 'team_… (optional)', optional: true },
    { key: 'projectId', label: 'Project ID', placeholder: 'prj_… (optional)', optional: true },
  ],
};

export function ProvidersSection() {
  const { state } = useStore();
  // Base freshness (`baseStatus`) is off the getData()/SSE hot path — fetch it
  // once here via the opt-in endpoint and merge onto the store providers, so a
  // baked-but-stale provider can nag "needs re-bake". A refresh (after a bake)
  // re-runs this effect since `state.providers` changes identity.
  const [freshness, setFreshness] = useState<Record<string, Pick<ProviderOption, 'baseStatus' | 'baseStaleReason'>>>(
    {},
  );
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/v1/providers?freshness=1', { credentials: 'same-origin' });
        if (!res.ok) return;
        // The success envelope returns the collection directly (see api/v1/lib/envelope.ok).
        const j = (await res.json()) as { providers?: ProviderOption[] };
        if (cancelled) return;
        const map: Record<string, Pick<ProviderOption, 'baseStatus' | 'baseStaleReason'>> = {};
        for (const p of j.providers ?? []) {
          map[p.id] = { baseStatus: p.baseStatus, baseStaleReason: p.baseStaleReason };
        }
        setFreshness(map);
      } catch {
        // Freshness is best-effort; leave the badge on its non-stale state.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [state.providers]);
  return (
    <Card className="divide-y divide-border/60 overflow-hidden">
      {state.providers.map((p) => (
        <ProviderRow key={p.id} provider={{ ...p, ...freshness[p.id] }} />
      ))}
    </Card>
  );
}

function statusBadge(p: ProviderOption) {
  if (p.configured) {
    // Baked but the runtime build context has changed since — surface a re-bake nag.
    if (p.baseStatus === 'stale') {
      return (
        <Badge className="badge-warn gap-1.5 normal-case" title={p.baseStaleReason}>
          stale — re-bake
        </Badge>
      );
    }
    // Docker: configured stays true (create self-heals) but the base image
    // hasn't been built yet — the first create will bake it.
    if (p.baseStatus === 'unprepared') {
      return <Badge className="gap-1.5 normal-case">needs bake</Badge>;
    }
    return (
      <Badge className="badge-run gap-1.5 normal-case">
        <span className="badge-dot" />
        ready
      </Badge>
    );
  }
  if (p.hasCredentials) return <Badge className="gap-1.5 normal-case">needs bake</Badge>;
  return <Badge className="gap-1.5 normal-case">needs credentials</Badge>;
}

// A fixed-length dot mask shown in a field that already has a saved value — a
// placeholder signal (the API never returns the real secret), never submitted.
const MASK = '••••••••••••';

function ProviderRow({ provider: p }: { provider: ProviderOption }) {
  const router = useRouter();
  const fields = CRED_FIELDS[p.id] ?? [];
  // Required fields re-mask when emptied; optional ones (e.g. vercel team/project) don't.
  const maskableKeys = new Set(fields.filter((f) => !f.optional).map((f) => f.key));
  const [values, setValues] = useState<Record<string, string>>({});
  // Start required fields masked when the provider already has credentials.
  const [masked, setMasked] = useState<Record<string, boolean>>(() =>
    p.hasCredentials
      ? Object.fromEntries(fields.filter((f) => !f.optional).map((f) => [f.key, true]))
      : {},
  );
  const [savingCreds, setSavingCreds] = useState(false);
  const [credError, setCredError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(!p.hasCredentials && fields.length > 0);
  // A bake in flight: from a live job (p.jobId, survives navigation) or one we
  // just started here.
  const [jobId, setJobId] = useState<string | null>(p.jobId ?? null);
  const [baking, setBaking] = useState(false);
  const [bakeError, setBakeError] = useState<string | null>(null);

  const saveCreds = async (): Promise<void> => {
    setSavingCreds(true);
    setCredError(null);
    try {
      const body: Record<string, string> = {};
      for (const f of fields) {
        if (masked[f.key]) continue; // the dot mask is a placeholder, not a value
        const v = (values[f.key] ?? '').trim();
        if (v) body[f.key] = v;
      }
      const res = await fetch(`/api/v1/providers/${encodeURIComponent(p.id)}/credentials`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        setCredError(j?.error?.message ?? `request failed (${res.status})`);
        return;
      }
      setValues({});
      // Re-mask the required fields now that they have a saved value.
      setMasked(Object.fromEntries([...maskableKeys].map((k) => [k, true])));
      setShowForm(false);
      router.refresh(); // hasCredentials flips in getData
    } catch (err) {
      setCredError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingCreds(false);
    }
  };

  const bake = async (): Promise<void> => {
    setBaking(true);
    setBakeError(null);
    try {
      const res = await fetch(`/api/v1/providers/${encodeURIComponent(p.id)}/prepare`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        // Re-bake an already-configured provider with force; first bake is plain.
        body: JSON.stringify(p.configured ? { force: true } : {}),
      });
      const j = (await res.json().catch(() => null)) as
        | { jobId?: string; error?: { message?: string } }
        | null;
      if (!res.ok || !j?.jobId) {
        setBakeError(j?.error?.message ?? `request failed (${res.status})`);
        return;
      }
      setJobId(j.jobId);
    } catch (err) {
      setBakeError(err instanceof Error ? err.message : String(err));
    } finally {
      setBaking(false);
    }
  };

  const canBake = p.id === 'docker' || p.hasCredentials;
  const hasFields = fields.length > 0;

  return (
    <div className="flex flex-col gap-3 p-4 px-5">
      {/* Whole header row toggles the credential form (cloud providers). The
          Re-bake button stops propagation so it never toggles. */}
      <div
        className={cn('flex items-center gap-3', hasFields && 'cursor-pointer')}
        onClick={hasFields ? () => setShowForm((s) => !s) : undefined}
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-[14px] font-semibold">
            {p.label}
            {statusBadge(p)}
          </div>
          {p.reason ? <div className="mt-0.5 text-[12.5px] text-muted-foreground">{p.reason}</div> : null}
        </div>
        <div className="flex flex-none items-center gap-2" onClick={(e) => e.stopPropagation()}>
          <Button
            type="button"
            size="sm"
            variant={p.configured ? 'outline' : 'default'}
            disabled={!canBake || baking || !!jobId}
            onClick={() => void bake()}
            title={canBake ? undefined : 'Add credentials first'}
          >
            <Icons.refresh className="size-3.5" />
            {jobId ? 'Baking…' : baking ? 'Starting…' : p.configured ? 'Re-bake' : 'Bake image'}
          </Button>
        </div>
        {hasFields ? (
          <Icons.chevR
            className={cn(
              'size-4 flex-none text-muted-foreground transition-transform',
              showForm && 'rotate-90',
            )}
          />
        ) : (
          // Keep the Re-bake button aligned with the chevron'd rows.
          <span className="size-4 flex-none" aria-hidden />
        )}
      </div>

      {showForm && fields.length > 0 ? (
        <div className="flex flex-col gap-2 rounded-lg border border-border/70 bg-card/50 p-3">
          {fields.map((f) => (
            <div key={f.key} className="flex flex-col gap-1">
              <label className="text-[11.5px] font-medium text-muted-foreground">
                {f.label}
                {f.optional ? ' (optional)' : ''}
              </label>
              <Input
                type="password"
                autoComplete="off"
                value={masked[f.key] ? MASK : (values[f.key] ?? '')}
                placeholder={f.placeholder}
                onFocus={() => {
                  // Clear the "already saved" mask on focus so a fresh value can be typed.
                  if (masked[f.key]) {
                    setMasked((m) => ({ ...m, [f.key]: false }));
                    setValues((v) => ({ ...v, [f.key]: '' }));
                  }
                }}
                onBlur={() => {
                  // Restore the mask if a previously-saved field was left empty.
                  if (maskableKeys.has(f.key) && !(values[f.key] ?? '').trim()) {
                    setMasked((m) => ({ ...m, [f.key]: true }));
                  }
                }}
                onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                className="font-mono text-xs"
              />
            </div>
          ))}
          <div className="mt-1 flex items-center gap-2">
            <Button type="button" size="sm" disabled={savingCreds} onClick={() => void saveCreds()}>
              {savingCreds ? 'Saving…' : 'Save credentials'}
            </Button>
            {credError ? <span className="text-xs text-red-400">{credError}</span> : null}
          </div>
        </div>
      ) : null}

      {bakeError ? <div className="text-xs text-red-400">{bakeError}</div> : null}

      {jobId ? (
        <JobLogStream
          jobId={jobId}
          endpoint={`/api/v1/jobs/${encodeURIComponent(jobId)}/logs`}
          onDone={() => {
            setJobId(null);
            router.refresh(); // configured flips true in getData
          }}
        />
      ) : null}
    </div>
  );
}
