'use client';

// System / Build page — "what is running here, and do I need to re-bake?". PURE
// REST CLIENT over /api/v1/system: hub version + build/channel/source, the deploy
// record, each provider's baked base (fingerprint + freshness) and — when one is
// stale — WHICH files changed, plus what this machine carries into a box. The
// actionable part is the provider table: a `stale` row is exactly when
// `agentbox prepare --provider <id>` should be re-run.

import { useEffect, useState } from 'react';
import { Ago } from '@/components/ago';
import { Icons } from '@/components/icons';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { bakeVerdict, type HubBuild, type ProviderBake } from '@/lib/system-info';
import { EmptyBox } from '../boxes/components/empty-box';
import { SectionLabel } from '../boxes/components/section-label';
import { Stat, StatGrid } from '../boxes/components/stat-grid';

interface SystemResponse {
  hub: { version: string | null; commit: string | null; profile: string; apiVersion: string };
  build: HubBuild;
  deploy: {
    provider?: string;
    url?: string;
    publicUrl?: string;
    tunnel?: string;
    autostart?: boolean;
    port?: number;
    bind?: string;
  } | null;
  providers: ProviderBake[];
  hostCarried: CarriedEntry[];
  boxImage: {
    registry: string;
    pullTag?: string;
    stampedFingerprint?: string;
    imageRef?: string;
    bakedAt?: string;
  } | null;
}

interface CarriedEntry {
  agent: string;
  label: string;
  hostPath: string;
  kind: 'skills' | 'config' | 'identity';
  skills?: string[];
}

export default function SystemPage() {
  const [data, setData] = useState<SystemResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetch('/api/v1/system', { credentials: 'same-origin' })
      .then(async (r) => {
        if (!r.ok) throw new Error(`request failed (${String(r.status)})`);
        return (await r.json()) as SystemResponse;
      })
      .then((j) => {
        if (alive) setData(j);
      })
      .catch((err: unknown) => {
        if (alive) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      alive = false;
    };
  }, []);

  const staleCount = (data?.providers ?? []).filter((p) => p.baseStatus === 'stale').length;

  return (
    <div className="mx-auto w-full max-w-[1080px] px-8 pb-16 pt-8 max-sm:px-4">
      <h1 className="text-[25px] font-semibold leading-tight tracking-[-0.025em]">
        System &amp; Build
      </h1>
      <div className="mt-1.5 text-sm text-muted-foreground">
        What this hub is running, and whether any provider base needs re-baking.
      </div>

      {error ? (
        <div className="mt-6">
          <EmptyBox>
            <div>Couldn’t load system info.</div>
            <div className="mt-1.5 font-mono text-xs text-red-400">{error}</div>
          </EmptyBox>
        </div>
      ) : !data ? (
        <div className="mt-8 text-sm text-muted-foreground">Loading…</div>
      ) : (
        <>
          <SectionLabel>Hub</SectionLabel>
          <StatGrid>
            <Stat k="Version" v={data.hub.version ?? 'dev'} mono icon={Icons.server} />
            <Stat k="Channel" v={data.build.channel ?? '—'} mono />
            <Stat k="Profile" v={data.hub.profile} mono />
            <Stat k="API" v={data.hub.apiVersion} mono />
            {data.hub.commit ? <Stat k="Commit" v={data.hub.commit} mono /> : null}
          </StatGrid>
          {data.build.build ? (
            <div className="mt-3 flex items-center gap-2 font-mono text-[12px] text-muted-foreground">
              <Icons.commit className="size-3.5 flex-none text-[#a4a9b0]" />
              {data.build.build}
            </div>
          ) : null}

          {data.deploy ? (
            <>
              <SectionLabel>Deploy</SectionLabel>
              <Card className="overflow-hidden">
                <div className="grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] divide-x divide-border/60">
                  <DeployField k="Provider" v={data.deploy.provider} />
                  <DeployField k="URL" v={data.deploy.url ?? data.deploy.publicUrl} />
                  <DeployField k="Tunnel" v={data.deploy.tunnel ?? 'none'} />
                  <DeployField
                    k="Bind"
                    v={
                      data.deploy.bind
                        ? `${data.deploy.bind}:${String(data.deploy.port ?? 8787)}`
                        : undefined
                    }
                  />
                  <DeployField
                    k="Autostart"
                    v={
                      data.deploy.autostart === undefined
                        ? undefined
                        : data.deploy.autostart
                          ? 'on'
                          : 'off'
                    }
                  />
                </div>
              </Card>
            </>
          ) : null}

          <SectionLabel
            right={
              <div className="flex items-center gap-2.5">
                {staleCount > 0 ? (
                  <Badge className="badge-warn gap-1.5 normal-case tracking-normal">
                    {staleCount} need re-bake
                  </Badge>
                ) : (
                  <span className="font-mono text-[11px] tracking-normal text-[#a4a9b0]">
                    base images
                  </span>
                )}
                {/* This page diagnoses; Settings is where the bake button lives. */}
                <Button href="/settings#providers" variant="outline" size="sm">
                  <Icons.settings />
                  Settings
                </Button>
              </div>
            }
          >
            Providers
          </SectionLabel>
          <Card className="divide-y divide-border/60 overflow-hidden">
            {data.providers.map((p) => (
              <ProviderBakeRow key={p.id} p={p} />
            ))}
          </Card>

          {data.boxImage ? (
            <>
              <SectionLabel
                right={
                  <span className="font-mono text-[11px] tracking-normal text-[#a4a9b0]">
                    what this host pulls
                  </span>
                }
              >
                Box image
              </SectionLabel>
              <Card className="grid grid-cols-2 divide-x divide-y divide-border/60 max-sm:grid-cols-1">
                <DeployField k="Registry" v={data.boxImage.registry} />
                <DeployField k="Pull tag" v={data.boxImage.pullTag} />
                <DeployField k="Stamped fingerprint" v={data.boxImage.stampedFingerprint} />
                <DeployField k="Local image" v={data.boxImage.imageRef} />
              </Card>
            </>
          ) : null}

          <SectionLabel
            right={
              <span className="font-mono text-[11px] tracking-normal text-[#a4a9b0]">
                {data.hostCarried.length} path(s) present
              </span>
            }
          >
            Carried from this machine
          </SectionLabel>
          {data.hostCarried.length === 0 ? (
            <EmptyBox>
              <div>Nothing to carry — no agent config found in this home directory.</div>
            </EmptyBox>
          ) : (
            <Card className="divide-y divide-border/60 overflow-hidden">
              {data.hostCarried.map((c) => (
                <CarriedRow key={`${c.agent}:${c.hostPath}`} c={c} />
              ))}
            </Card>
          )}
        </>
      )}
    </div>
  );
}

function DeployField({ k, v }: { k: string; v?: string }) {
  return (
    <div className="px-4.5 p-4">
      <div className="mb-1.5 font-mono text-[10.5px] uppercase tracking-[.06em] text-[#a4a9b0]">
        {k}
      </div>
      <div className="truncate font-mono text-sm font-medium" title={v ?? undefined}>
        {v ?? '—'}
      </div>
    </div>
  );
}

function ProviderBakeRow({ p }: { p: ProviderBake }) {
  const verdict = bakeVerdict(p);
  return (
    <div className="flex flex-col gap-2 p-4 px-5">
      <div className="flex items-center gap-2.5">
        <span className="text-[14px] font-semibold">{p.label}</span>
        <StatusBadge p={p} />
        {p.fingerprint ? (
          <span
            className="ml-auto font-mono text-[11px] text-[#a4a9b0]"
            title="build-context fingerprint"
          >
            {p.fingerprint}
          </span>
        ) : null}
      </div>
      <div
        className={cn(
          'flex items-start gap-1.5 text-[12.5px]',
          verdict.tone === 'warn' ? 'text-amber-500' : 'text-muted-foreground',
        )}
      >
        {verdict.tone === 'warn' ? <Icons.warn className="mt-0.5 size-3.5 flex-none" /> : null}
        <span>{p.baseStaleReason ?? verdict.text}</span>
      </div>
      {p.baseStatus === 'stale' ? <StaleDiff p={p} /> : null}
      {p.baked ? (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[11px] text-[#a4a9b0]">
          {p.cliVersion ? <span>baked with {p.cliVersion}</span> : null}
          {p.bakedAt ? (
            <span>
              baked <Ago ms={Date.parse(p.bakedAt)} />
            </span>
          ) : null}
          {p.imageRef ? (
            <span className="truncate" title={p.imageRef}>
              {p.imageRef}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function StatusBadge({ p }: { p: ProviderBake }) {
  if (p.baseStatus === 'stale')
    return <Badge className="badge-warn gap-1.5 normal-case">stale — re-bake</Badge>;
  if (!p.baked || p.baseStatus === 'unprepared')
    return <Badge className="gap-1.5 normal-case">not baked</Badge>;
  // Baked, but the live fingerprint couldn't be computed to verify freshness —
  // don't imply it's confirmed-fresh with the green run pill.
  if (p.baseStatus === 'unknown')
    return <Badge className="gap-1.5 normal-case">baked · unverified</Badge>;
  return (
    <Badge className="badge-run gap-1.5 normal-case">
      <span className="badge-dot" />
      baked
    </Badge>
  );
}

/**
 * One path this machine hands to a box. Only present paths reach here, so the
 * absence of a row is itself the answer to "why doesn't my box have X?".
 */
function CarriedRow({ c }: { c: CarriedEntry }) {
  const icon =
    c.kind === 'skills' ? <Icons.book /> : c.kind === 'identity' ? <Icons.key /> : <Icons.file />;
  return (
    <div className="px-5 py-3">
      <div className="flex items-center gap-3">
        <span className="flex size-3.5 flex-none items-center justify-center text-[#a4a9b0]">
          {icon}
        </span>
        <span className="text-[13px] font-medium">{c.label}</span>
        {c.skills ? (
          <Badge>
            {c.skills.length} skill{c.skills.length === 1 ? '' : 's'}
          </Badge>
        ) : null}
        <span className="ml-auto truncate font-mono text-[11px] text-[#a4a9b0]" title={c.hostPath}>
          {c.hostPath}
        </span>
      </div>
      {c.skills && c.skills.length > 0 ? (
        <div className="mt-1.5 pl-6.5 font-mono text-[11px] leading-relaxed text-[#a4a9b0]">
          {c.skills.join(', ')}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The "why is this stale?" disclosure.
 *
 * A base baked before per-file manifests were recorded has nothing to diff
 * against; saying so beats inventing a cause from mtimes or from the aggregate
 * hash, neither of which knows which file actually moved.
 */
function StaleDiff({ p }: { p: ProviderBake }) {
  const d = p.bakeDiff;
  if (!d) return null;
  const changed = d.changed ?? [];
  const added = d.added ?? [];
  const removed = d.removed ?? [];
  const total = changed.length + added.length + removed.length;
  return (
    <details className="mt-2">
      <summary className="cursor-pointer font-mono text-[11px] text-[#a4a9b0] hover:text-secondary-foreground">
        why is this stale?
      </summary>
      <div className="mt-2 rounded-lg border border-border/60 bg-background px-3.5 py-2.5">
        {!d.hasManifest ? (
          <div className="text-[12.5px] text-muted-foreground">
            No file manifest was recorded for this bake, so the changed files can&apos;t be
            identified. Re-bake to enable the diff.
          </div>
        ) : total === 0 ? (
          <div className="text-[12.5px] text-muted-foreground">
            Every file matches — the difference is in how the fingerprint was folded (e.g. a
            different <span className="font-mono">box.claudeInstall</span>).
          </div>
        ) : (
          <div className="flex flex-col gap-1 font-mono text-[11px]">
            {changed.map((f) => (
              <div key={f.rel} className="flex items-center gap-2">
                <span className="flex-none text-[var(--amber-fg,#b45309)]">~</span>
                <span className="truncate">{f.rel}</span>
                <span className="ml-auto flex-none text-[#a4a9b0]">
                  {f.from.slice(0, 7)} → {f.to.slice(0, 7)}
                </span>
              </div>
            ))}
            {added.map((rel) => (
              <div key={rel} className="flex items-center gap-2">
                <span className="flex-none text-primary">+</span>
                <span className="truncate">{rel}</span>
                <span className="ml-auto flex-none text-[#a4a9b0]">added</span>
              </div>
            ))}
            {removed.map((rel) => (
              <div key={rel} className="flex items-center gap-2">
                <span className="flex-none text-destructive">-</span>
                <span className="truncate">{rel}</span>
                <span className="ml-auto flex-none text-[#a4a9b0]">removed</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </details>
  );
}
