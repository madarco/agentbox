'use client';

// Skills page — the hub's skills library (docs/hub-skills-plan.md, Phases 1b
// and 6). PURE REST CLIENT over /api/v1: list, add from a git repository or a
// marketplace plugin, refresh, set the update policy, review and approve a
// pending update, edit SKILL.md, discard; and the waiting proposals from boxes.
// Uploading from and downloading to a PC's folders stays a PC's job
// (`agentbox skills`), since only that PC can read and write them.

import { useCallback, useEffect, useState } from 'react';
import { Ago } from '@/components/ago';
import { Icons } from '@/components/icons';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { fmtBytes } from '@/lib/boxes/format';
import { useStore } from '@/lib/boxes/store';
import { ApprovalActions } from '../approvals/components/approval-actions';
import { EmptyBox } from '../boxes/components/empty-box';
import { SectionLabel } from '../boxes/components/section-label';
import { AddSourceDialog } from './components/add-source-dialog';
import {
  api,
  errText,
  originLabel,
  refreshable,
  short,
  type RefreshOutcome,
  type SkillPolicy,
  type SkillRow,
  type SkillsListing,
} from './components/api';
import { EditorDialog } from './components/editor-dialog';
import { UpdateDialog } from './components/update-dialog';

type Modal =
  | { kind: 'add'; source: 'git' | 'marketplace' }
  | { kind: 'edit'; skill?: SkillRow }
  | { kind: 'update'; skill: SkillRow }
  | null;

const PROPOSAL_COMMANDS = new Set(['skills_propose', 'skills_propose_install']);

function refreshLine(o: RefreshOutcome): string {
  switch (o.status) {
    case 'pending':
      return `${o.name}: update waiting for approval`;
    case 'applied':
      return `${o.name}: updated to ${short(o.to ?? '')}`;
    case 'up-to-date':
      return `${o.name}: up to date`;
    default:
      return `${o.name}: ${o.status}${o.reason ? ` (${o.reason})` : ''}`;
  }
}

export default function SkillsPage() {
  const { state } = useStore();
  const [listing, setListing] = useState<SkillsListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; bad?: boolean; blocked?: string } | null>(
    null,
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [modal, setModal] = useState<Modal>(null);

  const load = useCallback(async () => {
    try {
      setListing(await api<SkillsListing>('/skills'));
      setError(null);
    } catch (err) {
      setError(errText(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (key: string, fn: () => Promise<string | null>) => {
    setBusy(key);
    setNotice(null);
    try {
      const text = await fn();
      if (text) setNotice({ text });
      await load();
    } catch (err) {
      setNotice({ text: errText(err), bad: true });
    } finally {
      setBusy(null);
    }
  };

  const refreshOne = (s: SkillRow, allowFindings = false) =>
    run(`refresh:${s.name}`, async () => {
      const o = await api<RefreshOutcome>(`/skills/${encodeURIComponent(s.name)}/refresh`, {
        method: 'POST',
        body: JSON.stringify(allowFindings ? { allowFindings: true } : {}),
      });
      if (o.status === 'blocked') {
        setNotice({ text: refreshLine(o), bad: true, blocked: s.name });
        return null;
      }
      return refreshLine(o);
    });

  const refreshAll = () =>
    run('refresh-all', async () => {
      const targets = listing?.skills.filter((s) => refreshable(s.origin)) ?? [];
      if (targets.length === 0) return 'No git or marketplace skills to refresh.';
      const settled = await Promise.allSettled(
        targets.map((s) =>
          api<RefreshOutcome>(`/skills/${encodeURIComponent(s.name)}/refresh`, {
            method: 'POST',
            body: '{}',
          }),
        ),
      );
      return settled
        .map((r, i) =>
          r.status === 'fulfilled'
            ? refreshLine(r.value)
            : `${targets[i]!.name}: failed (${errText(r.reason)})`,
        )
        .join(' · ');
    });

  const setPolicy = (s: SkillRow, policy: SkillPolicy) =>
    run(`policy:${s.name}`, async () => {
      await api(`/skills/${encodeURIComponent(s.name)}`, {
        method: 'PATCH',
        body: JSON.stringify({ policy }),
      });
      return null;
    });

  const discard = (s: SkillRow) => {
    if (
      !window.confirm(
        `Discard ${s.name} from the hub? All ${String(s.versions)} stored version(s) are deleted, and running boxes drop it at their next sync. PCs keep their own copies.`,
      )
    ) {
      return;
    }
    void run(`discard:${s.name}`, async () => {
      await api(`/skills/${encodeURIComponent(s.name)}`, { method: 'DELETE' });
      return `Discarded ${s.name}.`;
    });
  };

  const total = listing?.skills.reduce((n, s) => n + s.tarballBytes, 0) ?? 0;
  const pendingCount = listing?.skills.filter((s) => s.pending).length ?? 0;
  const proposals = state.approvals.filter((a) => a.command && PROPOSAL_COMMANDS.has(a.command));
  const boxName = (id: string) => state.boxes.find((b) => b.id === id)?.task ?? id;

  return (
    <div className="mx-auto w-full max-w-[1080px] px-8 pb-16 pt-8 max-sm:px-4">
      <div className="flex items-start gap-4 max-md:flex-col">
        <div className="min-w-0">
          <h1 className="text-[25px] font-semibold leading-tight tracking-[-0.025em]">Skills</h1>
          <div className="mt-1.5 text-sm text-muted-foreground">
            The skills library every box on this hub gets. Add skills from git or a marketplace
            here, or from a PC with{' '}
            <span className="font-mono text-secondary-foreground">agentbox skills</span>.
          </div>
        </div>
        <div className="ml-auto flex flex-none flex-wrap gap-2 max-md:ml-0">
          <Button variant="outline" onClick={() => setModal({ kind: 'add', source: 'git' })}>
            <Icons.repo /> Add from git
          </Button>
          <Button
            variant="outline"
            onClick={() => setModal({ kind: 'add', source: 'marketplace' })}
          >
            <Icons.grid /> Add from marketplace
          </Button>
          <Button onClick={() => setModal({ kind: 'edit' })}>
            <Icons.plus /> New skill
          </Button>
        </div>
      </div>

      {proposals.length > 0 ? (
        <div className="mt-6 overflow-hidden rounded-xl border border-[var(--amber-line)] bg-[var(--amber-soft)]">
          <div className="flex items-center gap-2 border-b border-[var(--amber-line)] px-4 py-2.5">
            <Icons.shield className="size-4 flex-none text-[var(--amber)]" />
            <span className="text-[13.5px] font-semibold">
              {proposals.length} skill proposal{proposals.length === 1 ? '' : 's'} from boxes
            </span>
            <span className="text-[12.5px] text-muted-foreground">
              — written by an agent in a box; nothing reaches the library until you approve.
            </span>
          </div>
          <div className="divide-y divide-[var(--amber-line)]">
            {proposals.map((a) => (
              <div key={a.id} className="flex items-start gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] text-secondary-foreground">{a.message}</div>
                  {a.detail ? (
                    <div className="mt-0.5 line-clamp-2 text-[11.5px] text-muted-foreground">
                      {a.detail}
                    </div>
                  ) : null}
                  <div className="mt-0.5 font-mono text-[11px] text-[#a4a9b0]">
                    box {boxName(a.boxId)} · <Ago ms={a.createdAt} />
                  </div>
                </div>
                <div className="flex-none pt-0.5">
                  <ApprovalActions id={a.id} url={a.url} />
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}

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
          {notice ? (
            <div
              className={`mt-4 flex flex-wrap items-center gap-2 font-mono text-xs ${notice.bad ? 'text-red-400' : 'text-[var(--green-ink)]'}`}
            >
              <span>{notice.text}</span>
              {notice.blocked ? (
                <Button
                  size="sm"
                  variant="destructive"
                  onClick={() => {
                    const s = listing.skills.find((x) => x.name === notice.blocked);
                    if (s) void refreshOne(s, true);
                  }}
                >
                  Fetch anyway
                </Button>
              ) : null}
            </div>
          ) : null}
          <SectionLabel
            right={
              <span className="flex items-center gap-3 font-mono text-[11px] tracking-normal text-[#a4a9b0]">
                {pendingCount > 0 ? (
                  <span className="text-[var(--amber)]">{pendingCount} update(s) waiting</span>
                ) : null}
                <span>
                  {listing.skills.length} · {fmtBytes(total)}
                </span>
                <button
                  className="cursor-pointer border-0 bg-transparent p-0 font-mono text-[11px] text-primary hover:underline disabled:opacity-50"
                  disabled={busy !== null}
                  onClick={() => void refreshAll()}
                >
                  {busy === 'refresh-all' ? 'refreshing…' : 'refresh all'}
                </button>
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
                Add from git above, or upload from a PC with{' '}
                <span className="text-secondary-foreground">agentbox skills --upload-all</span>
              </div>
            </EmptyBox>
          ) : (
            <Card className="divide-y divide-border/60 overflow-hidden">
              {listing.skills.map((s) => (
                <SkillItem
                  key={s.name}
                  s={s}
                  busy={busy}
                  onEdit={() => setModal({ kind: 'edit', skill: s })}
                  onReview={() => setModal({ kind: 'update', skill: s })}
                  onRefresh={() => void refreshOne(s)}
                  onPolicy={(p) => void setPolicy(s, p)}
                  onDiscard={() => discard(s)}
                />
              ))}
            </Card>
          )}
        </>
      )}

      {modal?.kind === 'add' ? (
        <AddSourceDialog
          initial={modal.source}
          onClose={() => setModal(null)}
          onAdded={() => void load()}
        />
      ) : null}
      {modal?.kind === 'edit' ? (
        <EditorDialog
          {...(modal.skill ? { skill: modal.skill } : {})}
          onClose={() => setModal(null)}
          onSaved={() => void load()}
        />
      ) : null}
      {modal?.kind === 'update' ? (
        <UpdateDialog
          skill={modal.skill}
          onClose={() => setModal(null)}
          onApproved={() => {
            setNotice({ text: `Approved the update to ${modal.skill.name}; running boxes sync.` });
            void load();
          }}
        />
      ) : null}
    </div>
  );
}

function SkillItem({
  s,
  busy,
  onEdit,
  onReview,
  onRefresh,
  onPolicy,
  onDiscard,
}: {
  s: SkillRow;
  busy: string | null;
  onEdit: () => void;
  onReview: () => void;
  onRefresh: () => void;
  onPolicy: (p: SkillPolicy) => void;
  onDiscard: () => void;
}) {
  const kind = s.origin?.kind ?? 'upload';
  return (
    <div className="flex items-start gap-4 p-4 px-5 max-sm:flex-wrap">
      <Icons.book className="mt-0.5 size-4 flex-none text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate font-mono text-[13.5px] font-medium">{s.name}</span>
          <Badge className="px-1.5 py-0 text-[10px] normal-case">
            {kind === 'folder' ? 'linked' : kind}
          </Badge>
          {s.versions > 1 ? (
            <Badge className="px-1.5 py-0 text-[10px] normal-case">{s.versions} versions</Badge>
          ) : null}
          {s.pending ? (
            <button
              className="cursor-pointer rounded-md border border-[var(--amber-line)] bg-[var(--amber-soft)] px-1.5 py-0 font-mono text-[10px] text-[var(--amber)]"
              onClick={onReview}
            >
              update waiting · {short(s.pending.version)}
            </button>
          ) : null}
        </div>
        <div className="mt-0.5 line-clamp-2 text-[12.5px] text-muted-foreground">
          {s.description}
        </div>
        <div
          className="mt-1 truncate font-mono text-[11px] text-[#a4a9b0]"
          title={originLabel(s.origin)}
        >
          {fmtBytes(s.size)} · {s.files} file{s.files === 1 ? '' : 's'} · from{' '}
          {s.source.host ?? 'unknown PC'} · updated <Ago ms={Date.parse(s.updatedAt)} /> ·{' '}
          {short(s.current)}
        </div>
        {kind === 'git' || kind === 'marketplace' ? (
          <div className="mt-0.5 truncate font-mono text-[11px] text-[#a4a9b0]">
            {originLabel(s.origin)}
          </div>
        ) : null}
      </div>
      <div className="flex flex-none flex-wrap items-center justify-end gap-1.5">
        <select
          aria-label={`Update policy for ${s.name}`}
          title="How a new version reaches boxes"
          value={s.policy ?? 'auto'}
          disabled={busy !== null}
          onChange={(e) => onPolicy(e.target.value as SkillPolicy)}
          className="h-[30px] rounded-md border border-border bg-card px-1.5 text-xs text-secondary-foreground"
        >
          <option value="auto">auto-update</option>
          <option value="manual">approve updates</option>
        </select>
        {s.pending ? (
          <Button size="sm" onClick={onReview}>
            Review update
          </Button>
        ) : null}
        {refreshable(s.origin) ? (
          <Button
            size="sm"
            variant="outline"
            title="Fetch the source again"
            disabled={busy !== null}
            onClick={onRefresh}
          >
            <Icons.refresh /> {busy === `refresh:${s.name}` ? 'Fetching…' : 'Refresh'}
          </Button>
        ) : null}
        <Button size="sm" variant="outline" disabled={busy !== null} onClick={onEdit}>
          <Icons.pencil /> Edit
        </Button>
        <Button size="sm" variant="destructive" disabled={busy !== null} onClick={onDiscard}>
          {busy === `discard:${s.name}` ? 'Discarding…' : 'Discard'}
        </Button>
      </div>
    </div>
  );
}
