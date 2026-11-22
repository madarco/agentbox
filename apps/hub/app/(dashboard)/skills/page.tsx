'use client';

// Skills page — the hub's skills library (docs/hub-skills-plan.md, Phase 1b).
// PURE REST CLIENT over /api/v1/skills: list what the hub stores and discard a
// skill. Uploading and downloading are a PC's job (`agentbox skills`), since
// they read and write that PC's skill folders.

import { useCallback, useEffect, useState } from 'react';
import { Ago } from '@/components/ago';
import { Icons } from '@/components/icons';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { fmtBytes } from '@/lib/boxes/format';
import { EmptyBox } from '../boxes/components/empty-box';
import { SectionLabel } from '../boxes/components/section-label';

/** One row of `GET /api/v1/skills` (the hub's `SkillSummary`). */
interface SkillRow {
  name: string;
  description: string;
  current: string;
  size: number;
  files: number;
  tarballBytes: number;
  updatedAt: string;
  source: { host?: string; machineId?: string; path?: string };
  versions: number;
}

interface Listing {
  seeded: boolean;
  skills: SkillRow[];
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`/api/v1/skills${path}`, { credentials: 'same-origin', ...init });
  const body = (await r.json().catch(() => ({}))) as { error?: { message?: string } };
  if (!r.ok) throw new Error(body.error?.message ?? `request failed (${String(r.status)})`);
  return body as T;
}

export default function SkillsPage() {
  const [listing, setListing] = useState<Listing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setListing(await api<Listing>(''));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const discard = async (s: SkillRow) => {
    if (
      !window.confirm(
        `Discard ${s.name} from the hub? All ${String(s.versions)} stored version(s) are deleted. PCs keep their own copies.`,
      )
    ) {
      return;
    }
    setBusy(s.name);
    setActionError(null);
    try {
      await api(`/${encodeURIComponent(s.name)}`, { method: 'DELETE' });
      await load();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const total = listing?.skills.reduce((n, s) => n + s.tarballBytes, 0) ?? 0;

  return (
    <div className="mx-auto w-full max-w-[1080px] px-8 pb-16 pt-8 max-sm:px-4">
      <h1 className="text-[25px] font-semibold leading-tight tracking-[-0.025em]">Skills</h1>
      <div className="mt-1.5 text-sm text-muted-foreground">
        The skills library this hub keeps for every PC that uses it. It is seeded from the first PC
        automatically; after that, add or bring skills down with{' '}
        <span className="font-mono text-secondary-foreground">agentbox skills</span> on a PC.
      </div>

      {error ? (
        <div className="mt-6">
          <EmptyBox>
            <div>Couldn’t load the skills library.</div>
            <div className="mt-1.5 font-mono text-xs text-red-400">{error}</div>
          </EmptyBox>
        </div>
      ) : !listing ? (
        <div className="mt-8 text-sm text-muted-foreground">Loading…</div>
      ) : (
        <>
          {actionError ? (
            <div className="mt-4 font-mono text-xs text-red-400">{actionError}</div>
          ) : null}
          <SectionLabel
            right={
              <span className="font-mono text-[11px] tracking-normal text-[#a4a9b0]">
                {listing.skills.length} · {fmtBytes(total)}
              </span>
            }
          >
            Library
          </SectionLabel>
          {listing.skills.length === 0 ? (
            <EmptyBox>
              <div>
                {listing.seeded
                  ? 'The library is empty. Every skill was discarded; it is not re-seeded automatically.'
                  : 'No skills yet. The first PC that creates a box against this hub seeds it.'}
              </div>
              <div className="mt-1.5 font-mono text-xs text-muted-foreground">
                Upload from a PC with{' '}
                <span className="text-secondary-foreground">agentbox skills --upload-all</span>
              </div>
            </EmptyBox>
          ) : (
            <Card className="divide-y divide-border/60 overflow-hidden">
              {listing.skills.map((s) => (
                <SkillItem key={s.name} s={s} busy={busy} onDiscard={() => void discard(s)} />
              ))}
            </Card>
          )}
        </>
      )}
    </div>
  );
}

function SkillItem({
  s,
  busy,
  onDiscard,
}: {
  s: SkillRow;
  busy: string | null;
  onDiscard: () => void;
}) {
  return (
    <div className="flex items-start gap-4 p-4 px-5 max-sm:flex-wrap">
      <Icons.book className="mt-0.5 size-4 flex-none text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-mono text-[13.5px] font-medium">{s.name}</span>
          {s.versions > 1 ? (
            <Badge className="px-1.5 py-0 text-[10px] normal-case">{s.versions} versions</Badge>
          ) : null}
        </div>
        <div className="mt-0.5 line-clamp-2 text-[12.5px] text-muted-foreground">
          {s.description}
        </div>
        <div className="mt-1 truncate font-mono text-[11px] text-[#a4a9b0]" title={s.current}>
          {fmtBytes(s.size)} · {s.files} file{s.files === 1 ? '' : 's'} · from{' '}
          {s.source.host ?? 'unknown PC'} · updated <Ago ms={Date.parse(s.updatedAt)} /> ·{' '}
          {s.current.slice(0, 12)}
        </div>
      </div>
      <Button size="sm" variant="destructive" disabled={busy !== null} onClick={onDiscard}>
        {busy === s.name ? 'Discarding…' : 'Discard'}
      </Button>
    </div>
  );
}
