'use client';

import { useEffect, useState } from 'react';
import { Ago } from '@/components/ago';
import { Icons } from '@/components/icons';
import { Card } from '@/components/ui/card';
import { fmtBytes } from '@/lib/boxes/format';
import type { ProjectSeedResult } from '@/lib/boxes/seed-status';
import { EmptyBox } from '../../../boxes/components/empty-box';
import { SectionLabel } from '../../../boxes/components/section-label';

// The seed / custody status is the control box's copy of what a fresh clone
// can't provide (untracked files + env/secrets). It lives outside the SSR'd
// HubState, so it's fetched client-side per the pure-REST-client contract.
export function ProjectSeed({ projectId }: { projectId: string }) {
  const [data, setData] = useState<ProjectSeedResult | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/v1/projects/${encodeURIComponent(projectId)}/seed`, {
          credentials: 'same-origin',
        });
        if (!res.ok) return;
        const j = (await res.json()) as ProjectSeedResult;
        if (!cancelled) setData(j);
      } catch {
        // Best-effort: the rest of the page still renders without seed status.
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  // Only a control box holds custody. On a local hub the section is irrelevant,
  // so hide it entirely rather than showing an empty state.
  if (!loaded || !data || !data.custodyAvailable) return null;

  const seed = data.seed;
  return (
    <>
      <SectionLabel>Seed / custody</SectionLabel>
      {seed ? (
        <Card className="divide-y divide-border/60 overflow-hidden">
          <div className="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] divide-x divide-border/60">
            <Field k="Slug" v={seed.slug} mono />
            <Field
              k="Captured"
              v={seed.capturedAt ? <Ago ms={Date.parse(seed.capturedAt) || Date.now()} /> : '—'}
            />
            <Field k="At commit" v={seed.repoHeadSha ? seed.repoHeadSha.slice(0, 8) : '—'} mono />
            <Field k="Base branch" v={seed.baseBranch ?? '—'} mono />
            <Field
              k="Secrets"
              v={
                <span className="flex items-center gap-1.5">
                  {seed.hasEnv ? (
                    <>
                      <Icons.shield className="size-[14px] text-[var(--green-ink)]" /> present
                    </>
                  ) : (
                    'none'
                  )}
                </span>
              }
            />
            <Field k="Size" v={fmtBytes(seed.totalBytes)} mono />
          </div>
          <div>
            {seed.entries.map((e) => (
              <div key={e.name} className="flex items-center gap-3 px-4 py-2.5">
                <Icons.file className="size-[14px] flex-none text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate font-mono text-[13px] text-secondary-foreground">
                  {e.name}
                </span>
                <span className="font-mono text-[11px] text-muted-foreground">{e.sha256.slice(0, 10)}</span>
                <span className="font-mono text-xs text-muted-foreground">{fmtBytes(e.size)}</span>
                <span className="font-mono text-[11px] text-muted-foreground">
                  <Ago ms={Date.parse(e.updatedAt) || Date.now()} />
                </span>
              </div>
            ))}
          </div>
        </Card>
      ) : (
        <EmptyBox>
          <div>No seed pushed yet.</div>
          <div className="mt-1 text-[12.5px] text-muted-foreground">
            Run <code className="font-mono">agentbox hub project push</code> from the repo to register its
            untracked files and secrets.
          </div>
        </EmptyBox>
      )}
    </>
  );
}

function Field({ k, v, mono }: { k: string; v: React.ReactNode; mono?: boolean }) {
  return (
    <div className="px-4.5 p-4">
      <div className="mb-1.5 font-mono text-[10.5px] uppercase tracking-[.06em] text-[#a4a9b0]">{k}</div>
      <div className={mono ? 'truncate font-mono text-sm font-medium' : 'text-sm font-medium'}>{v}</div>
    </div>
  );
}
