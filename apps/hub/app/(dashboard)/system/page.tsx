'use client';

// System / Build page — "what is running here, and do I need to re-bake?". PURE
// REST CLIENT over /api/v1/system: hub version + build/channel/source, the deploy
// record, each provider's baked base (fingerprint + freshness), and the box-image
// build-context manifest. The actionable part is the provider table: a `stale` row
// is exactly when `agentbox prepare --provider <id>` should be re-run.

import { useEffect, useState } from 'react';
import { Ago } from '@/components/ago';
import { Icons } from '@/components/icons';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { bakeVerdict, groupImageContents, type HubBuild, type ProviderBake } from '@/lib/system-info';
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
  imageContextKeys: string[];
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
      <h1 className="text-[25px] font-semibold leading-tight tracking-[-0.025em]">System &amp; Build</h1>
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
                    v={data.deploy.bind ? `${data.deploy.bind}:${String(data.deploy.port ?? 8787)}` : undefined}
                  />
                  <DeployField k="Autostart" v={data.deploy.autostart === undefined ? undefined : data.deploy.autostart ? 'on' : 'off'} />
                </div>
              </Card>
            </>
          ) : null}

          <SectionLabel
            right={
              staleCount > 0 ? (
                <Badge className="badge-warn gap-1.5 normal-case tracking-normal">{staleCount} need re-bake</Badge>
              ) : (
                <span className="font-mono text-[11px] tracking-normal text-[#a4a9b0]">base images</span>
              )
            }
          >
            Providers
          </SectionLabel>
          <Card className="divide-y divide-border/60 overflow-hidden">
            {data.providers.map((p) => (
              <ProviderBakeRow key={p.id} p={p} />
            ))}
          </Card>

          <SectionLabel right={<span className="font-mono text-[11px] tracking-normal text-[#a4a9b0]">what a re-bake picks up</span>}>
            Box image contents
          </SectionLabel>
          {groupImageContents(data.imageContextKeys).map((group) => (
            <div key={group.category} className="mb-4">
              <div className="mb-2 font-mono text-[11px] uppercase tracking-[.08em] text-[#a4a9b0]">{group.category}</div>
              <Card className="divide-y divide-border/60 overflow-hidden">
                {group.files.map((f) => (
                  <div key={f.path} className="flex items-center gap-3 px-5 py-2.5">
                    <Icons.file className="size-3.5 flex-none text-[#a4a9b0]" />
                    <span className="text-[13px]">{f.label}</span>
                    <span className="ml-auto truncate font-mono text-[11px] text-[#a4a9b0]" title={f.path}>
                      {f.path}
                    </span>
                  </div>
                ))}
              </Card>
            </div>
          ))}
        </>
      )}
    </div>
  );
}

function DeployField({ k, v }: { k: string; v?: string }) {
  return (
    <div className="px-4.5 p-4">
      <div className="mb-1.5 font-mono text-[10.5px] uppercase tracking-[.06em] text-[#a4a9b0]">{k}</div>
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
          <span className="ml-auto font-mono text-[11px] text-[#a4a9b0]" title="build-context fingerprint">
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
      {p.baked ? (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[11px] text-[#a4a9b0]">
          {p.cliVersion ? <span>baked with {p.cliVersion}</span> : null}
          {p.bakedAt ? (
            <span>
              baked <Ago ms={Date.parse(p.bakedAt)} />
            </span>
          ) : null}
          {p.imageRef ? <span className="truncate" title={p.imageRef}>{p.imageRef}</span> : null}
        </div>
      ) : null}
    </div>
  );
}

function StatusBadge({ p }: { p: ProviderBake }) {
  if (p.baseStatus === 'stale') return <Badge className="badge-warn gap-1.5 normal-case">stale — re-bake</Badge>;
  if (!p.baked || p.baseStatus === 'unprepared') return <Badge className="gap-1.5 normal-case">not baked</Badge>;
  return (
    <Badge className="badge-run gap-1.5 normal-case">
      <span className="badge-dot" />
      baked
    </Badge>
  );
}
