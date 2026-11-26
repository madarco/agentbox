'use client';

// Skills page — the hub's skills library (docs/hub-skills-plan.md, Phases 1b
// and 6; docs/hub-settings-plan.md, Phase 2). PURE REST CLIENT over /api/v1:
// list, add from a git repository or a marketplace plugin, refresh, set the
// update policy, review and approve a pending update, edit SKILL.md, discard;
// the waiting proposals from boxes; and the library next to one machine's skill
// dirs (`/skill-machines/{id}/compare`), with Pull to Hub and Send to <machine>
// run on that machine by its relay.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Ago } from '@/components/ago';
import { Icons } from '@/components/icons';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { fmtBytes } from '@/lib/boxes/format';
import { useStore } from '@/lib/boxes/store';
import { ApprovalActions } from '../../approvals/components/approval-actions';
import { EmptyBox } from '../../boxes/components/empty-box';
import { AddSourceDialog } from './components/add-source-dialog';
import {
  api,
  errText,
  originLabel,
  refreshable,
  short,
  type CompareRow,
  type PullResult,
  type RefreshOutcome,
  type SendResult,
  type SkillCompare,
  type SkillMachine,
  type SkillPolicy,
  type SkillRow,
  type SkillsListing,
} from './components/api';
import { pullBlocker, resultLine, rowMoves, statusLabel, syncPlan } from './components/pc-sync';
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

  const [machines, setMachines] = useState<SkillMachine[] | null>(null);
  const [machineId, setMachineId] = useState<string | null>(null);
  const [compare, setCompare] = useState<SkillCompare | null>(null);
  const [query, setQuery] = useState('');
  const [agent, setAgent] = useState('');

  // Only the newest comparison may land: switching machines quickly must never
  // leave one machine's rows under another machine's id.
  const compareSeq = useRef(0);
  const loadCompare = useCallback(async (id: string | null) => {
    const seq = ++compareSeq.current;
    if (!id) {
      setCompare(null);
      return;
    }
    let next: SkillCompare;
    try {
      next = await api<SkillCompare>(`/skill-machines/${encodeURIComponent(id)}/compare`);
    } catch (err) {
      next = {
        machine: { id, label: id, self: false, online: false },
        error: errText(err),
        rows: [],
        outOfSync: 0,
      };
    }
    if (seq !== compareSeq.current) return;
    setCompare(next);
  }, []);

  const load = useCallback(async () => {
    try {
      setListing(await api<SkillsListing>('/skills'));
      setError(null);
    } catch (err) {
      setError(errText(err));
    }
    await loadCompare(machineId);
  }, [loadCompare, machineId]);
  // `run` reloads with the newest `load`, not the one captured at the click: a
  // reload after an action must compare the machine selected NOW.
  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  }, [load]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void api<{ machines: SkillMachine[]; defaultId: string | null }>('/skill-machines')
      .then((r) => {
        setMachines(r.machines);
        setMachineId((cur) => cur ?? r.defaultId);
      })
      .catch(() => setMachines([]));
  }, []);

  const run = async (key: string, fn: () => Promise<string | null>) => {
    setBusy(key);
    setNotice(null);
    try {
      const text = await fn();
      if (text) setNotice({ text });
      await loadRef.current();
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

  /** Untick = skip for good (stored on the Hub); tick = sync it again. */
  const toggleSkip = (name: string, skip: boolean) =>
    run(`skip:${name}`, async () => {
      await api(`/skill-skips/${encodeURIComponent(name)}`, { method: skip ? 'PUT' : 'DELETE' });
      return skip
        ? `${name} is skipped: never pulled, sent or put in boxes.`
        : `${name} syncs again.`;
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

  // A comparison of another machine (the one before a switch) is never shown or acted on.
  const current = compare && compare.machine.id === machineId ? compare : null;
  const machine = current?.machine ?? machines?.find((m) => m.id === machineId) ?? null;
  const machineLabel = machine?.label ?? 'this machine';
  const pcOnline = Boolean(machine?.online) && current !== null && !current.error;

  /** POST a pull or send to the selected machine; one notice line per skill. */
  const post = async (
    kind: 'pull' | 'send',
    names: string[],
    opts: { overwrite?: boolean; allowFindings?: boolean } = {},
  ): Promise<{ lines: string[]; bad: boolean }> => {
    if (!machineId || names.length === 0) return { lines: [], bad: false };
    const r = await api<{ results: (PullResult | SendResult)[] }>(
      `/skill-machines/${encodeURIComponent(machineId)}/${kind}`,
      { method: 'POST', body: JSON.stringify({ names, ...opts }) },
    );
    return {
      lines: r.results.map((x) => resultLine(x, machineLabel)),
      bad: r.results.some((x) => x.status === 'failed' || x.status === 'skipped'),
    };
  };

  /** On another PC each skill waits for a yes there (mirrored to Approvals). */
  const waitingNotice = () => {
    if (machine && !machine.self) {
      setNotice({
        text: `Waiting for confirm on ${machineLabel} (also in Approvals). An unanswered confirm counts as a no after two minutes.`,
      });
    }
  };

  const finish = (lines: string[], bad: boolean): string | null => {
    if (!bad) return lines.join(' · ');
    setNotice({ text: lines.join(' · '), bad: true });
    return null;
  };

  const move = (
    kind: 'pull' | 'send',
    names: string[],
    opts: { overwrite?: boolean; allowFindings?: boolean } = {},
  ) =>
    run(`${kind}:${names.length === 1 ? names[0]! : '*'}`, async () => {
      waitingNotice();
      const r = await post(kind, names, opts);
      return finish(r.lines, r.bad);
    });

  const pullOne = (row: CompareRow) => {
    const findings = row.pc?.findings.length ?? 0;
    if (
      findings > 0 &&
      !window.confirm(
        `${row.name} has ${String(findings)} secret-scan finding(s) on ${machineLabel} (${row
          .pc!.findings.slice(0, 3)
          .map((f) => `${f.rule} in ${f.path}:${String(f.line)}`)
          .join(', ')}). Upload it to the Hub anyway? Every box gets it.`,
      )
    ) {
      return;
    }
    if (
      row.status === 'differs' &&
      !window.confirm(`Replace the Hub's ${row.name} with the copy on ${machineLabel}?`)
    ) {
      return;
    }
    void move('pull', [row.name], findings > 0 ? { allowFindings: true } : {});
  };

  const sendOne = (row: CompareRow) => {
    if (
      row.status === 'differs' &&
      !window.confirm(
        `Replace ${row.name} in ~/.agents/skills on ${machineLabel} with the Hub's version?${row.pc && !row.pc.dirs.includes('.agents/skills') ? ` Its copy in ~/${row.pc.dirs[0] ?? ''} is kept; an agent reading that folder keeps the old one until you remove it.` : ''}`,
      )
    ) {
      return;
    }
    void move('send', [row.name], row.status === 'differs' ? { overwrite: true } : {});
  };

  const syncAll = () => {
    if (!current) return;
    const plan = syncPlan(current.rows);
    const parts = [
      plan.pull.length ? `pull ${plan.pull.join(', ')} to the Hub` : '',
      plan.send.length ? `send ${plan.send.join(', ')} to ${machineLabel}` : '',
      plan.overwrite.length ? `(replacing ${machineLabel}'s ${plan.overwrite.join(', ')})` : '',
      plan.skipped.length
        ? `and leave ${plan.skipped.map((x) => `${x.name} (${x.reason})`).join(', ')}`
        : '',
    ].filter(Boolean);
    if (plan.pull.length + plan.send.length === 0) {
      setNotice({
        text: `Nothing to sync automatically: ${plan.skipped.map((x) => `${x.name} (${x.reason})`).join(', ')}`,
        bad: true,
      });
      return;
    }
    if (!window.confirm(`Sync all: ${parts.join(' ')}?`)) return;
    void run('sync-all', async () => {
      waitingNotice();
      const steps = [
        await post('pull', plan.pull),
        await post(
          'send',
          plan.send.filter((n) => !plan.overwrite.includes(n)),
        ),
        await post('send', plan.overwrite, { overwrite: true }),
      ];
      return finish(
        steps.flatMap((x) => x.lines),
        steps.some((x) => x.bad),
      );
    });
  };

  // One row per skill name: the library's skills, plus the machine's own ones.
  const byName = useMemo(
    () => new Map((current?.rows ?? []).map((r) => [r.name, r] as const)),
    [current],
  );
  const rows = useMemo(() => {
    const out: { name: string; skill?: SkillRow; cmp?: CompareRow }[] = (listing?.skills ?? []).map(
      (s) => ({
        name: s.name,
        skill: s,
        ...(byName.get(s.name) ? { cmp: byName.get(s.name)! } : {}),
      }),
    );
    for (const r of current?.rows ?? []) {
      if (!listing?.skills.some((s) => s.name === r.name)) out.push({ name: r.name, cmp: r });
    }
    // A skipped name neither side shows right now (the machine is offline, or the
    // skill was removed) keeps a row, so its skip can still be cleared here.
    for (const name of listing?.skipped ?? []) {
      if (!out.some((r) => r.name === name)) out.push({ name });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }, [listing, current, byName]);
  const agents = useMemo(
    () => [...new Set(rows.flatMap((r) => r.cmp?.agents ?? []))].sort(),
    [rows],
  );
  const q = query.trim().toLowerCase();
  const visible = rows.filter(
    (r) =>
      (!agent || (r.cmp?.agents ?? []).includes(agent)) &&
      (!q ||
        r.name.includes(q) ||
        (r.skill?.description ?? r.cmp?.description ?? '').toLowerCase().includes(q)),
  );
  const outOfSync = current && !current.error ? current.outOfSync : 0;
  const skipped = new Set(listing?.skipped ?? current?.skipped ?? []);

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
            The skills library every box on this hub gets, next to the skills on one of your
            machines. Pull a machine’s skills to the Hub, send the Hub’s to it, or add from git or a
            marketplace.
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
                  <div className="mt-0.5 font-mono text-[11px] text-[var(--faint)]">
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
          <div className="mt-6 flex flex-wrap items-center gap-2">
            <Select
              aria-label="Machine"
              title="The machine whose skill dirs the library is compared with"
              value={machineId ?? ''}
              // Switching mid-action would aim the rest of it at another machine.
              disabled={!machines || machines.length === 0 || busy !== null}
              onChange={(e) => {
                setMachineId(e.target.value || null);
                setNotice(null);
              }}
              wrapperClassName="min-w-[200px]"
            >
              {!machines || machines.length === 0 ? (
                <option value="">No machine to compare with</option>
              ) : (
                machines.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                    {m.self ? ' (this hub)' : m.online ? '' : ' (offline)'}
                  </option>
                ))
              )}
            </Select>
            <Select
              aria-label="Agent"
              value={agent}
              onChange={(e) => setAgent(e.target.value)}
              wrapperClassName="min-w-[150px]"
            >
              <option value="">All agents</option>
              {agents.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </Select>
            <div className="relative min-w-[200px] flex-1">
              <Icons.search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                aria-label="Search skills"
                placeholder="Search skills"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="pl-8"
              />
            </div>
            <span className="flex items-center gap-3 font-mono text-[11px] text-[var(--faint)]">
              {pendingCount > 0 ? (
                <span className="text-[var(--amber)]">{pendingCount} update(s) waiting</span>
              ) : null}
              <span>
                {listing.skills.length} on Hub · {fmtBytes(total)}
              </span>
              <button
                className="cursor-pointer border-0 bg-transparent p-0 font-mono text-[11px] text-primary hover:underline disabled:opacity-50"
                disabled={busy !== null}
                onClick={() => void refreshAll()}
              >
                {busy === 'refresh-all' ? 'refreshing…' : 'refresh all'}
              </button>
            </span>
          </div>

          {machine && !current ? (
            <div className="mt-3 rounded-lg border border-border bg-card px-3 py-2 text-[12.5px] text-muted-foreground">
              Checking {machineLabel}’s skills…
            </div>
          ) : machine && !pcOnline ? (
            <div className="mt-3 flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-[12.5px] text-muted-foreground">
              <Icons.warn className="size-4 flex-none" />
              <span>
                {machine.online
                  ? `Couldn’t read ${machineLabel}’s skills`
                  : `${machineLabel} offline`}
                {current?.error ? ` — ${current.error}` : ''}. Pull and Send are off until it
                answers.
              </span>
            </div>
          ) : outOfSync > 0 ? (
            <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-[var(--amber-line)] bg-[var(--amber-soft)] px-3 py-2">
              <Icons.warn className="size-4 flex-none text-[var(--amber)]" />
              <span className="text-[13px] font-medium">
                {outOfSync} skill{outOfSync === 1 ? '' : 's'} not in sync with the Hub
              </span>
              <span className="text-[12.5px] text-muted-foreground">on {machineLabel}</span>
              <Button size="sm" className="ml-auto" disabled={busy !== null} onClick={syncAll}>
                {busy === 'sync-all' ? 'Syncing…' : 'Sync all'}
              </Button>
            </div>
          ) : null}

          {rows.length === 0 ? (
            <div className="mt-4">
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
            </div>
          ) : (
            <Card className="mt-4 overflow-hidden">
              <div className="grid grid-cols-[minmax(0,1fr)_150px_170px_360px_44px] gap-3 border-b border-border/60 px-5 py-2 font-mono text-[10.5px] uppercase tracking-[0.06em] text-[var(--faint)] max-lg:hidden">
                <span>Skill</span>
                <span>Agents</span>
                <span>Status</span>
                <span className="text-right">Action</span>
                <span className="text-center" title="Untick to never sync it">
                  Sync
                </span>
              </div>
              <div className="divide-y divide-border/60">
                {visible.length === 0 ? (
                  <div className="px-5 py-6 text-sm text-muted-foreground">
                    No skill matches the filter.
                  </div>
                ) : (
                  visible.map((r) => (
                    <SkillTableRow
                      key={r.name}
                      name={r.name}
                      {...(r.skill ? { s: r.skill } : {})}
                      {...(r.cmp ? { cmp: r.cmp } : {})}
                      machine={machineLabel}
                      skipped={skipped.has(r.name)}
                      onSkip={(skip) => void toggleSkip(r.name, skip)}
                      online={pcOnline}
                      comparing={!current}
                      busy={busy}
                      onPull={() => r.cmp && pullOne(r.cmp)}
                      onSend={() => r.cmp && sendOne(r.cmp)}
                      onEdit={() => r.skill && setModal({ kind: 'edit', skill: r.skill })}
                      onReview={() => r.skill && setModal({ kind: 'update', skill: r.skill })}
                      onRefresh={() => r.skill && void refreshOne(r.skill)}
                      onPolicy={(p) => r.skill && void setPolicy(r.skill, p)}
                      onDiscard={() => r.skill && discard(r.skill)}
                    />
                  ))
                )}
              </div>
            </Card>
          )}
          {rows.length > 0 ? (
            <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
              Unticked ones are skipped for good: the Hub remembers it, so later syncs, the first
              seed from a PC, restarts and new boxes never pull, send or install them. Skipping
              deletes nothing.
            </p>
          ) : null}
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

function statusTone(status: CompareRow['status'] | undefined): string {
  if (status === 'skipped') return 'text-muted-foreground';
  if (status === 'same') return 'text-[var(--green-ink)]';
  if (status === 'differs' || status === 'local-only' || status === 'hub-only')
    return 'text-[var(--amber)]';
  return 'text-muted-foreground';
}

function SkillTableRow({
  name,
  s,
  cmp,
  machine,
  skipped,
  onSkip,
  online,
  comparing,
  busy,
  onPull,
  onSend,
  onEdit,
  onReview,
  onRefresh,
  onPolicy,
  onDiscard,
}: {
  name: string;
  s?: SkillRow;
  cmp?: CompareRow;
  machine: string;
  skipped: boolean;
  onSkip: (skip: boolean) => void;
  online: boolean;
  comparing: boolean;
  busy: string | null;
  onPull: () => void;
  onSend: () => void;
  onEdit: () => void;
  onReview: () => void;
  onRefresh: () => void;
  onPolicy: (p: SkillPolicy) => void;
  onDiscard: () => void;
}) {
  const kind = s?.origin?.kind ?? 'upload';
  const moves = cmp && online && !skipped ? rowMoves(cmp) : [];
  const blocked = cmp ? pullBlocker(cmp) : null;
  const description = s?.description ?? cmp?.description ?? '';
  // Just unskipped: the comparison still says `skipped` until it reloads.
  const stale = !skipped && cmp?.status === 'skipped';
  const status = skipped
    ? 'Skipped, not synced'
    : comparing || stale
      ? 'Checking…'
      : cmp
        ? statusLabel(cmp, machine, online)
        : online
          ? 'Only on Hub'
          : `${machine} offline`;
  return (
    <div
      className={`grid grid-cols-[minmax(0,1fr)_150px_170px_360px_44px] items-start gap-3 px-5 py-3.5 max-lg:grid-cols-1${skipped ? ' bg-background/60' : ''}`}
    >
      <div className="flex min-w-0 items-start gap-3">
        <Icons.book className="mt-0.5 size-4 flex-none text-muted-foreground" />
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`truncate font-mono text-[13.5px] font-medium${skipped ? ' text-muted-foreground line-through decoration-border' : ''}`}
            >
              {name}
            </span>
            {s ? (
              <Badge className="px-1.5 py-0 text-[10px] normal-case">
                {kind === 'folder' ? 'linked' : kind}
              </Badge>
            ) : null}
            {s?.pending ? (
              <button
                className="cursor-pointer rounded-md border border-[var(--amber-line)] bg-[var(--amber-soft)] px-1.5 py-0 font-mono text-[10px] text-[var(--amber)]"
                onClick={onReview}
              >
                update waiting · {short(s.pending.version)}
              </button>
            ) : null}
            {s?.broken ? (
              <span
                className="rounded-md border border-red-500/40 bg-red-500/10 px-1.5 py-0 font-mono text-[10px] text-red-400"
                title={`${s.broken}. Pull it to the hub again (or re-upload it) to fix it; boxes can't install it until then.`}
              >
                broken copy · upload again
              </span>
            ) : null}
          </div>
          <div className="mt-0.5 line-clamp-2 text-[12.5px] text-muted-foreground">
            {description}
          </div>
          {s ? (
            <div
              className="mt-1 truncate font-mono text-[11px] text-[var(--faint)]"
              title={originLabel(s.origin)}
            >
              {fmtBytes(s.size)} · {s.files} file{s.files === 1 ? '' : 's'} · from{' '}
              {kind === 'git' || kind === 'marketplace'
                ? originLabel(s.origin)
                : (s.source.host ?? 'unknown PC')}{' '}
              · updated <Ago ms={Date.parse(s.updatedAt)} /> · {short(s.current)}
            </div>
          ) : cmp?.pc ? (
            <div
              className="mt-1 truncate font-mono text-[11px] text-[var(--faint)]"
              title={cmp.pc.path}
            >
              {fmtBytes(cmp.pc.size)} · {cmp.pc.files} file{cmp.pc.files === 1 ? '' : 's'} ·{' '}
              {cmp.pc.path}
            </div>
          ) : null}
          {blocked ? (
            <div className="mt-0.5 font-mono text-[11px] text-red-400">can’t upload: {blocked}</div>
          ) : null}
          {cmp?.pc?.conflicting ? (
            <div className="mt-0.5 font-mono text-[11px] text-[var(--amber)]">
              different copies in {cmp.pc.dirs.map((d) => `~/${d}`).join(', ')} on {machine}
            </div>
          ) : null}
          {!blocked && cmp?.pc && cmp.pc.findings.length > 0 ? (
            <div className="mt-0.5 font-mono text-[11px] text-[var(--amber)]">
              {cmp.pc.findings.length} secret-scan finding(s) on {machine}
            </div>
          ) : null}
        </div>
      </div>
      <div className="flex flex-wrap gap-1 pt-0.5">
        {(cmp?.agents ?? []).length === 0 ? (
          <span className="font-mono text-[11px] text-[var(--faint)]">—</span>
        ) : (
          cmp!.agents.map((a) => (
            <Badge key={a} className="px-1.5 py-0 text-[10px] normal-case">
              {a}
            </Badge>
          ))
        )}
      </div>
      <div
        className={`flex items-center gap-1.5 pt-0.5 text-[12.5px] ${statusTone(skipped ? 'skipped' : cmp?.status)}`}
      >
        {skipped ? <Icons.pause className="size-3.5 flex-none" /> : null}
        {status}
      </div>
      <div className="flex flex-wrap items-center justify-end gap-1.5 max-lg:justify-start">
        {moves.includes('pull') ? (
          <Button
            size="sm"
            variant={cmp?.status === 'local-only' ? 'default' : 'outline'}
            disabled={busy !== null || blocked !== null}
            title={blocked ?? `Upload ${machine}'s copy to the Hub`}
            onClick={onPull}
          >
            <Icons.arrowUp /> {busy === `pull:${name}` ? 'Pulling…' : 'Pull to Hub'}
          </Button>
        ) : null}
        {moves.includes('send') ? (
          <Button
            size="sm"
            variant={cmp?.status === 'hub-only' ? 'default' : 'outline'}
            disabled={busy !== null}
            title={`Install the Hub's version in ~/.agents/skills on ${machine}`}
            onClick={onSend}
          >
            {busy === `send:${name}` ? 'Sending…' : `Send to ${machine}`}
          </Button>
        ) : null}
        {s ? (
          <>
            <select
              aria-label={`Update policy for ${name}`}
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
                <Icons.refresh /> {busy === `refresh:${name}` ? 'Fetching…' : 'Refresh'}
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="outline"
              title="Edit SKILL.md"
              aria-label={`Edit ${name}`}
              disabled={busy !== null}
              onClick={onEdit}
            >
              <Icons.pencil />
            </Button>
            <Button
              size="sm"
              variant="destructive"
              title="Discard from the Hub"
              aria-label={`Discard ${name}`}
              disabled={busy !== null}
              onClick={onDiscard}
            >
              {busy === `discard:${name}` ? '…' : <Icons.trash />}
            </Button>
          </>
        ) : null}
      </div>
      <div className="flex justify-center pt-1.5 max-lg:justify-start">
        <input
          type="checkbox"
          className="size-4 cursor-pointer accent-primary disabled:cursor-default"
          checked={!skipped}
          disabled={busy !== null}
          onChange={(e) => onSkip(!e.target.checked)}
          aria-label={(skipped ? 'Sync ' : 'Skip ') + name}
          title={
            skipped
              ? 'Skipped: never pulled, sent or put in boxes'
              : 'Untick to skip this one for good'
          }
        />
      </div>
    </div>
  );
}
