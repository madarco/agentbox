'use client';

// A box's library skills (docs/hub-skills-plan.md, Phase 6): what the box was
// last served and whether it is behind the library, "Sync now", and a per-box
// on/off/inherit for every library skill (a box-scope skill binding, which
// outranks the project, workspace and global ones and the create flags).
// Pure /api/v1 client: GET /boxes/{id}/skills, POST /boxes/{id}/skills/sync,
// GET /skills, GET|PUT /skill-bindings?scope=box&scopeId={id}.

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Icons } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Select } from '@/components/ui/select';
import { cn } from '@/lib/utils';
import {
  api,
  errText,
  short,
  type BindingMode,
  type BoxSkills,
  type SkillsListing,
  type SyncOutcome,
} from '../../settings/skills/components/api';
import { SectionLabel } from './section-label';

type Choice = 'inherit' | BindingMode;

interface Loaded {
  box: BoxSkills;
  library: SkillsListing;
  bindings: Record<string, BindingMode>;
}

export function SkillsPanel({ id, running }: { id: string; running: boolean }) {
  // A box still being created (or whose create failed) is a synthetic `job:` row:
  // it has no skills and isn't a valid binding scope, same guard as BotPanel.
  if (id.startsWith('job:')) return null;
  return <BoxSkills id={id} running={running} />;
}

function BoxSkills({ id, running }: { id: string; running: boolean }) {
  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; bad?: boolean } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const enc = encodeURIComponent(id);

  const load = useCallback(async () => {
    try {
      const [box, library, b] = await Promise.all([
        api<BoxSkills>(`/boxes/${enc}/skills`),
        api<SkillsListing>('/skills'),
        api<{ bindings: Record<string, BindingMode> }>(`/skill-bindings?scope=box&scopeId=${enc}`),
      ]);
      setData({ box, library, bindings: b.bindings });
      setError(null);
    } catch (err) {
      setError(errText(err));
    }
  }, [enc]);

  useEffect(() => {
    void load();
  }, [load]);

  const sync = async () => {
    setBusy('sync');
    setNotice(null);
    try {
      const r = await api<SyncOutcome>(`/boxes/${enc}/skills/sync`, { method: 'POST' });
      setNotice({
        text:
          r.status === 'synced'
            ? `Synced${r.detail ? `: ${r.detail}` : ''}. Agents pick changes up at their next session.`
            : r.status === 'not-running'
              ? 'The box is not running; it syncs when it starts.'
              : `Sync failed: ${r.detail ?? ''}`,
        bad: r.status === 'failed',
      });
      await load();
    } catch (err) {
      setNotice({ text: errText(err), bad: true });
    } finally {
      setBusy(null);
    }
  };

  const bind = async (name: string, choice: Choice) => {
    setBusy(`bind:${name}`);
    setNotice(null);
    try {
      await api(`/skill-bindings?scope=box&scopeId=${enc}`, {
        method: 'PUT',
        body: JSON.stringify({ bindings: { [name]: choice === 'inherit' ? null : choice } }),
      });
      setNotice({
        text: `Saved. ${running ? 'Sync now to apply it to the running box.' : 'The box applies it when it starts.'}`,
      });
      await load();
    } catch (err) {
      setNotice({ text: errText(err), bad: true });
    } finally {
      setBusy(null);
    }
  };

  // A hub with custody off (or an older hub) has no skills: hide the section.
  if (error && !data) {
    if (/custody is not enabled|not found|404/i.test(error)) return null;
    return (
      <>
        <SectionLabel>Skills</SectionLabel>
        <div className="font-mono text-xs text-red-400">{error}</div>
      </>
    );
  }
  if (!data) return null;
  if (!data.library.seeded && data.box.skills.length === 0) return null;

  const held = new Map(data.box.skills.map((s) => [s.name, s]));
  const names = [
    ...new Set([...data.library.skills.map((s) => s.name), ...data.box.skills.map((s) => s.name)]),
  ].sort();
  const behind = data.box.skills.filter((s) => s.behind).length;

  return (
    <>
      <SectionLabel
        right={
          <span className="font-mono text-[11px] tracking-normal text-[var(--faint)]">
            {data.box.skills.length} in box
            {behind > 0 ? <span className="text-[var(--amber)]"> · {behind} behind</span> : null}
          </span>
        }
      >
        Skills
      </SectionLabel>
      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-center gap-3 border-b border-border/60 px-4 py-2.5">
          <span className="min-w-0 flex-1 text-xs text-muted-foreground">
            {data.box.recordedAt
              ? 'Library skills this box was served. On/off here overrides the project, workspace and global choices.'
              : 'This box has not pulled skills from this hub yet.'}{' '}
            <Link href="/settings/skills" className="text-primary hover:underline">
              Library
            </Link>
          </span>
          <Button
            size="sm"
            variant="outline"
            disabled={busy !== null || !running}
            onClick={() => void sync()}
            title={
              running ? 'Run agentbox-ctl skills sync in the box' : 'The box syncs when it starts'
            }
          >
            <Icons.refresh /> {busy === 'sync' ? 'Syncing…' : 'Sync now'}
          </Button>
        </div>
        {notice ? (
          <div
            className={cn(
              'border-b border-border/60 px-4 py-2 font-mono text-xs',
              notice.bad ? 'text-red-400' : 'text-[var(--green-ink)]',
            )}
          >
            {notice.text}
          </div>
        ) : null}
        <div className="divide-y divide-border/60">
          {names.length === 0 ? (
            <div className="px-4 py-3 text-xs text-muted-foreground">The library is empty.</div>
          ) : (
            names.map((name) => {
              const h = held.get(name);
              const inLibrary = data.library.skills.some((s) => s.name === name);
              const choice: Choice = data.bindings[name] ?? 'inherit';
              return (
                <div key={name} className="flex items-center gap-3 px-4 py-2.5">
                  <span
                    className={cn(
                      'badge-dot',
                      h ? (h.behind ? 'bg-[var(--amber)]' : 'bg-[var(--green)]') : 'bg-border',
                    )}
                    aria-hidden
                  />
                  <span className="min-w-0 flex-1 truncate font-mono text-[13px] text-secondary-foreground">
                    {name}
                  </span>
                  <span className="font-mono text-[11px] text-[var(--faint)]">
                    {!h
                      ? 'not in box'
                      : !inLibrary
                        ? 'discarded · removed at next sync'
                        : h.behind
                          ? `behind · ${short(h.version)} → ${short(h.current ?? '')}`
                          : short(h.version)}
                    {h?.pending ? ' · update waiting' : ''}
                  </span>
                  {inLibrary ? (
                    <Select
                      aria-label={`${name} in this box`}
                      value={choice}
                      disabled={busy !== null}
                      onChange={(e) => void bind(name, e.target.value as Choice)}
                      size="sm"
                      className="bg-card text-secondary-foreground"
                    >
                      <option value="inherit">inherit</option>
                      <option value="include">on</option>
                      <option value="exclude">off</option>
                    </Select>
                  ) : null}
                </div>
              );
            })
          )}
        </div>
      </Card>
    </>
  );
}
