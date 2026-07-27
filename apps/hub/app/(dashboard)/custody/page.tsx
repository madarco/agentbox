'use client';

// Custody page — a read-only window on what the control box holds in custody:
// agent credentials, project seeds, provider bake records, and per-box SSH keys.
// PURE REST CLIENT: one fetch of /api/v1/custody, which returns metadata only
// (path, size, sha256, mtime) — never a credential value. Grouped by scope with a
// scope filter to drill in.

import { useEffect, useMemo, useState } from 'react';
import { Ago } from '@/components/ago';
import { Icons } from '@/components/icons';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import {
  CUSTODY_SCOPES,
  fmtBytes,
  groupCustody,
  shortSha,
  type CustodyEntry,
  type CustodyScope,
} from '@/lib/custody-view';
import { EmptyBox } from '../boxes/components/empty-box';
import { SectionLabel } from '../boxes/components/section-label';
import { Stat, StatGrid } from '../boxes/components/stat-grid';

interface CustodyResponse {
  enabled: boolean;
  entries: CustodyEntry[];
}

export default function CustodyPage() {
  const [data, setData] = useState<CustodyResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scope, setScope] = useState<CustodyScope | null>(null);

  useEffect(() => {
    let alive = true;
    fetch('/api/v1/custody', { credentials: 'same-origin' })
      .then(async (r) => {
        if (!r.ok) throw new Error(`request failed (${String(r.status)})`);
        return (await r.json()) as CustodyResponse;
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

  const groups = useMemo(() => groupCustody(data?.entries ?? []), [data]);
  const total = groups.reduce((n, g) => n + g.count, 0);
  const shown = scope ? groups.filter((g) => g.scope === scope) : groups;

  return (
    <div className="mx-auto w-full max-w-[1080px] px-8 pb-16 pt-8 max-sm:px-4">
      <h1 className="text-[25px] font-semibold leading-tight tracking-[-0.025em]">Custody</h1>
      <div className="mt-1.5 text-sm text-muted-foreground">
        What the control box holds so a box created from either side is usable from both. Paths, hashes and sizes only —{' '}
        <span className="text-secondary-foreground">values never leave the box</span>.
      </div>

      {error ? (
        <div className="mt-6">
          <EmptyBox>
            <div>Couldn’t load custody.</div>
            <div className="mt-1.5 font-mono text-xs text-red-400">{error}</div>
          </EmptyBox>
        </div>
      ) : data && !data.enabled ? (
        <div className="mt-6">
          <EmptyBox>
            <div>Custody isn’t enabled on this hub.</div>
            <div className="mt-1.5 font-mono text-xs text-muted-foreground">
              Custody runs on a deployed control box (a hub with an admin token). A localhost hub keeps credentials on
              your machine directly.
            </div>
          </EmptyBox>
        </div>
      ) : !data ? (
        <div className="mt-8 text-sm text-muted-foreground">Loading…</div>
      ) : (
        <>
          <SectionLabel right={<span className="font-mono text-[11px] tracking-normal text-[#a4a9b0]">{total} entries</span>}>
            Overview
          </SectionLabel>
          <StatGrid>
            {groups.map((g) => (
              <Stat key={g.scope} k={g.label} v={`${String(g.count)}${g.count ? ` · ${fmtBytes(g.size)}` : ''}`} />
            ))}
          </StatGrid>

          <div className="mt-6 flex flex-wrap items-center gap-1.5">
            <ScopePill active={scope === null} onClick={() => setScope(null)} label="All" count={total} />
            {CUSTODY_SCOPES.map((s) => {
              const g = groups.find((x) => x.scope === s)!;
              return <ScopePill key={s} active={scope === s} onClick={() => setScope(s)} label={g.label} count={g.count} />;
            })}
          </div>

          {shown.every((g) => g.count === 0) ? (
            <div className="mt-6">
              <EmptyBox>
                <div>Nothing in custody{scope ? ` under ${scope}` : ''} yet.</div>
                <div className="mt-1.5 font-mono text-xs text-muted-foreground">
                  Agent credentials arrive from `agentbox hub credentials push`; seeds, bake records and box keys are
                  written as boxes are created.
                </div>
              </EmptyBox>
            </div>
          ) : (
            shown
              .filter((g) => g.count > 0)
              .map((g) => (
                <div key={g.scope}>
                  <SectionLabel right={<span className="font-mono text-[11px] tracking-normal text-[#a4a9b0]">{g.count}</span>}>
                    {g.label}
                  </SectionLabel>
                  <div className="mb-3 text-[12.5px] text-muted-foreground">{g.blurb}</div>
                  <Card className="divide-y divide-border/60 overflow-hidden">
                    {g.subgroups.map((sub) => (
                      <div key={sub.key} className="p-4 px-5">
                        <div className="mb-2 flex items-center gap-2">
                          <Icons.folder className="size-[15px] flex-none text-muted-foreground" />
                          <span className="font-mono text-[13px] font-medium">{sub.key}</span>
                          <Badge className="px-1.5 py-0 text-[10px] normal-case">{sub.entries.length}</Badge>
                          <span className="ml-auto font-mono text-[11px] text-[#a4a9b0]">{fmtBytes(sub.size)}</span>
                        </div>
                        <div className="divide-y divide-border/40">
                          {sub.entries.map((e) => (
                            <div key={e.path} className="flex items-center gap-3 py-1.5 max-sm:flex-wrap">
                              <Icons.file className="size-3.5 flex-none text-[#a4a9b0]" />
                              <span className="min-w-0 flex-1 truncate font-mono text-[12px]" title={e.path}>
                                {e.path.split('/').slice(2).join('/') || e.path}
                              </span>
                              <span className="font-mono text-[11px] text-[#a4a9b0]" title={e.sha256}>
                                {shortSha(e.sha256)}
                              </span>
                              <span className="w-16 text-right font-mono text-[11px] text-muted-foreground">{fmtBytes(e.size)}</span>
                              <span className="w-24 text-right font-mono text-[11px] text-muted-foreground">
                                <Ago ms={Date.parse(e.updatedAt)} />
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </Card>
                </div>
              ))
          )}
        </>
      )}
    </div>
  );
}

function ScopePill({
  active,
  onClick,
  label,
  count,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[12.5px] transition-colors',
        active
          ? 'border-transparent bg-accent font-medium text-accent-foreground'
          : 'border-border text-secondary-foreground hover:bg-secondary hover:text-foreground',
      )}
    >
      {label}
      <span className={cn('font-mono text-[11px]', active ? 'text-primary' : 'text-[#a4a9b0]')}>{count}</span>
    </button>
  );
}
