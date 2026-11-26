'use client';

// The Dashboard (docs/hub-redesign-plan.md): the day in four numbers, what
// every box did over the last 12 hours, what runs now, the week, what needs a
// hand, and every box. Boxes come from the store; the week from
// /api/v1/usage/stats; lanes and the feed from /api/v1/activity.

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { agentIcon, Icons, type Icon } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Tabs } from '@/components/ui/tabs';
import { useAccounts } from '@/lib/accounts-client';
import { useStore } from '@/lib/boxes/store';
import type { Box, BoxStatus } from '@/lib/boxes/types';
import {
  buildLanes,
  plural,
  feedEntries,
  lastDays,
  runningAtOnce,
  type FeedEntry,
} from '@/lib/dashboard-view';
import { formatTokenCount, liveActivity, primaryLive, usageTotal } from '@/lib/live-status-view';
import { subscriptionKey, usageKeyLabel } from '@/lib/subscriptions';
import { cn } from '@/lib/utils';
import { ApprovalBanner } from '../approvals/components/approval-banner';
import { AddProjectButton } from '../boxes/components/add-project-modal';
import { BoxTable } from '../boxes/components/box-table';
import { CreateBoxButton } from '../boxes/components/create-box-modal';
import { EmptyBox } from '../boxes/components/empty-box';
import { Legend, Lanes, MiniBars, Sparkline, WeekBars } from './charts';
import { Facet } from './facet';
import { useDashboardData } from './use-dashboard-data';

const SPAN_H = 12;
const VIEW_KEY = 'hub-boxes-view';
type View = 'table' | 'projects';

const fmtHours = (h: number) => (h >= 10 ? Math.round(h).toString() : h.toFixed(1));

function relShort(ms: number, now: number): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return `${String(s)}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${String(m)}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${String(h)}h`;
  return `${String(Math.round(h / 24))}d`;
}

function Kpi({
  label,
  value,
  unit,
  sub,
  chart,
  href,
}: {
  label: string;
  value: ReactNode;
  unit?: ReactNode;
  sub: ReactNode;
  chart?: ReactNode;
  href?: string;
}) {
  const inner = (
    <>
      <div className="eyebrow">{label}</div>
      <div className="mt-2 flex items-baseline gap-1.5">
        <span className="text-[26px] font-semibold leading-none tabular-nums tracking-[-0.02em]">
          {value}
        </span>
        {unit ? <span className="text-sm text-muted-foreground">{unit}</span> : null}
      </div>
      <div className="mt-1 min-h-4 text-xs text-muted-foreground">{sub}</div>
      {chart ? <div className="mt-3">{chart}</div> : null}
    </>
  );
  const cls = 'flex flex-col overflow-hidden p-4 pb-3';
  if (href) {
    return (
      <Link href={href} className="block rounded-xl">
        <Card className={cn(cls, 'h-full transition-colors hover:border-ring/40')}>{inner}</Card>
      </Link>
    );
  }
  return <Card className={cls}>{inner}</Card>;
}

function CardHead({ title, right, sub }: { title: string; right?: ReactNode; sub?: ReactNode }) {
  return (
    <div className="flex items-center gap-2 px-4 pb-2 pt-4">
      <div className="min-w-0">
        <div className="text-[15px] font-semibold">{title}</div>
        {sub ? <div className="mt-0.5 text-[12.5px] text-muted-foreground">{sub}</div> : null}
      </div>
      {right ? <span className="ml-auto flex-none">{right}</span> : null}
    </div>
  );
}

const FEED_ICON: Record<FeedEntry['kind'], { icon: Icon; tone: string }> = {
  push: { icon: Icons.commit, tone: 'text-[var(--green-ink)]' },
  merge: { icon: Icons.branch, tone: 'text-[var(--violet)]' },
  pr: { icon: Icons.branch, tone: 'text-[var(--blue)]' },
  ready: { icon: Icons.check, tone: 'text-[var(--green-ink)]' },
  failed: { icon: Icons.warn, tone: 'text-[var(--red)]' },
  lifecycle: { icon: Icons.box, tone: 'text-muted-foreground' },
};

function Unavailable({ what, error }: { what: string; error: string | null }) {
  return (
    <div className="px-4 pb-4 text-sm text-muted-foreground">
      {error ? (
        <>
          {what} unavailable: <span className="font-mono text-xs">{error}</span>
        </>
      ) : (
        <span className="inline-flex items-center gap-2">
          <span className="spin !size-3" /> Loading
        </span>
      )}
    </div>
  );
}

function readView(): View {
  try {
    return localStorage.getItem(VIEW_KEY) === 'projects' ? 'projects' : 'table';
  } catch {
    return 'table';
  }
}

export function Dashboard() {
  const router = useRouter();
  const { state, boxesFor } = useStore();
  const { accounts } = useAccounts();
  const { stats, activity, readAt } = useDashboardData();
  const boxes = state.boxes;

  // The date line and the view choice depend on the browser: set after mount
  // so the server render and hydration agree.
  const [day, setDay] = useState('');
  const [view, setView] = useState<View>('table');
  useEffect(() => {
    setDay(new Date().toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'short' }));
    setView(readView());
  }, []);
  const pickView = (v: View) => {
    setView(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      // storage blocked: the choice holds for this page view
    }
  };

  const [q, setQ] = useState('');
  const [status, setStatus] = useState<string[]>([]);
  const [projects, setProjects] = useState<string[]>([]);

  const live = boxes.filter((b) => b.status === 'running');
  const liveProjects = new Set(live.map((b) => b.projectId)).size;

  const lanes = useMemo(
    () =>
      activity.data
        ? buildLanes(
            activity.data,
            boxes.map((b) => ({
              id: b.id,
              name: b.name,
              task: b.task,
              agent: b.agent,
              status: b.status,
              lastActivity: b.lastActivity,
            })),
            readAt,
            SPAN_H,
          )
        : [],
    [activity.data, boxes, readAt],
  );
  const load = useMemo(() => runningAtOnce(lanes, SPAN_H, 10), [lanes]);
  const peak = Math.max(0, ...load);
  const feed = useMemo(() => (activity.data ? feedEntries(activity.data, 5) : []), [activity.data]);

  const week = stats.data ? lastDays(stats.data, 7) : null;
  const today = week?.[week.length - 1];
  const yesterday = week?.[week.length - 2];

  const limited = useMemo(() => {
    const at = new Set(
      (accounts ?? []).filter((a) => a.limits?.atLimit).map((a) => subscriptionKey(a)),
    );
    const out = new Map<string, string>();
    // Only a box with an agent to stall: a stopped one at a limit needs nothing.
    for (const b of boxes) {
      if (b.status !== 'running' && b.status !== 'paused') continue;
      const sub = Object.values(b.subscriptions ?? {}).find((s) => at.has(s));
      if (sub) out.set(b.id, usageKeyLabel(sub, accounts ?? []));
    }
    return out;
  }, [accounts, boxes]);
  const attention = boxes.filter((b) => b.status === 'error' || limited.has(b.id));

  const needle = q.trim().toLowerCase();
  const filtered = boxes.filter(
    (b) =>
      (!needle || `${b.task} ${b.id} ${b.name ?? ''} ${b.branch}`.toLowerCase().includes(needle)) &&
      (!status.length || status.includes(b.status)) &&
      (!projects.length || projects.includes(b.projectId)),
  );
  const filtering = needle !== '' || status.length > 0 || projects.length > 0;
  const statusOpts = (['running', 'paused', 'creating', 'stopped', 'error'] as BoxStatus[])
    .map((s) => ({ value: s, label: s, count: boxes.filter((b) => b.status === s).length }))
    .filter((o) => o.count || status.includes(o.value));
  const projOpts = state.projects.map((p) => ({
    value: p.id,
    label: p.name,
    count: boxesFor(p.id).length,
  }));

  const mode = state.authMode === 'password' ? 'remote hub' : 'local hub';

  return (
    <div className="mx-auto w-full max-w-[1400px] px-6 pb-16 pt-6 max-sm:px-4">
      <div className="flex flex-wrap items-end gap-4">
        <div className="min-w-0">
          <div className="eyebrow" suppressHydrationWarning>
            {day ? `${day} · ` : ''}
            {mode}
          </div>
          <h1 className="mt-1.5 text-[26px] font-semibold leading-tight tracking-[-0.025em]">
            {live.length > 0 ? (
              <>
                {plural(live.length, 'agent')} at work{' '}
                <span className="serif text-[30px] text-[var(--green-ink)]">
                  across {plural(liveProjects, 'project')}
                </span>
              </>
            ) : (
              <>
                No agents at work{' '}
                <span className="serif text-[30px] text-[var(--green-ink)]">
                  {boxes.length ? `${plural(boxes.length, 'box', 'boxes')} idle` : 'yet'}
                </span>
              </>
            )}
          </h1>
        </div>
        <div className="ml-auto flex flex-none flex-wrap gap-2">
          <AddProjectButton variant="outline" />
          {state.projects.length ? (
            <CreateBoxButton projects={state.projects} label="New box" icon={Icons.plus} />
          ) : null}
        </div>
      </div>

      <div className="mt-5">
        <ApprovalBanner />
      </div>

      {/* the day in four numbers */}
      <div className="grid grid-cols-4 gap-3 max-xl:grid-cols-2 max-sm:grid-cols-1">
        <Kpi
          label="Working now"
          value={live.length}
          unit={`of ${plural(boxes.length, 'box', 'boxes')}`}
          sub={
            activity.data
              ? `peak of ${String(peak)} at once in the last ${String(SPAN_H)}h`
              : activity.error
                ? 'activity unavailable'
                : ' '
          }
          chart={
            activity.data ? (
              <Sparkline
                data={load.filter((_, i) => i % 2 === 0)}
                step
                height={34}
                label={`Boxes running at once over the last ${String(SPAN_H)} hours, peak ${String(peak)}`}
              />
            ) : (
              <div className="h-[34px]" />
            )
          }
        />
        <Kpi
          label="Agent-hours today"
          value={today ? fmtHours(today.agentHours) : '—'}
          unit="h"
          href="/usage"
          sub={
            today && today.wallHours > 0 ? (
              <>
                <span className="text-[var(--green-ink)]">
                  {(today.agentHours / today.wallHours).toFixed(1)}×
                </span>{' '}
                the hours on the clock, side by side
              </>
            ) : stats.error ? (
              'usage stats unavailable'
            ) : (
              'no agent time yet today'
            )
          }
          chart={
            week ? (
              <MiniBars
                data={week.map((d) => d.agentHours)}
                label="Agent-hours per day, last 7 days"
              />
            ) : (
              <div className="h-[34px]" />
            )
          }
        />
        <Kpi
          label="Commits today"
          value={today ? today.commits : '—'}
          href="/usage"
          sub={
            today ? (
              <>
                {plural(today.prs, 'pull request')} merged ·{' '}
                <span className="font-mono text-[var(--green-ink)]">+{today.additions}</span>{' '}
                <span className="font-mono text-[var(--red)]">−{today.deletions}</span>
              </>
            ) : stats.error ? (
              'usage stats unavailable'
            ) : (
              ' '
            )
          }
          chart={
            week ? (
              <MiniBars
                data={week.map((d) => d.commits)}
                color="var(--c2)"
                label="Commits per day, last 7 days"
              />
            ) : (
              <div className="h-[34px]" />
            )
          }
        />
        <Kpi
          label="Tokens today"
          value={today ? formatTokenCount(today.tokens) : '—'}
          href="/usage?view=tokens"
          sub={
            today
              ? // A plain reference, not a change: today is only part of a day.
                yesterday && yesterday.tokens > 0
                ? `${formatTokenCount(yesterday.tokens)} yesterday`
                : 'across every agent session'
              : stats.error
                ? 'usage stats unavailable'
                : ' '
          }
          chart={
            week ? (
              <Sparkline
                data={week.map((d) => d.tokens)}
                height={34}
                color="var(--c4)"
                label="Tokens per day, last 7 days"
              />
            ) : (
              <div className="h-[34px]" />
            )
          }
        />
      </div>

      {/* what every box did today, and what is happening right now */}
      <div className="mt-3 grid grid-cols-[minmax(0,1fr)_340px] gap-3 max-xl:grid-cols-1">
        <Card className="min-w-0">
          <div className="flex flex-wrap items-start gap-3 p-5 pb-3">
            <div>
              <div className="text-[15px] font-semibold">Your day</div>
              <div className="mt-0.5 text-[12.5px] text-muted-foreground">
                Your boxes over the last {SPAN_H} hours. Dots are pushes, diamonds are merged pull
                requests.
              </div>
            </div>
            <div className="ml-auto pt-1">
              <Legend
                items={[
                  { label: 'running', color: 'var(--c1)' },
                  { label: 'paused', color: 'var(--faint)', op: 0.6 },
                  { label: 'push', shape: 'dot' },
                  { label: 'PR merged', shape: 'diamond', color: 'var(--violet)' },
                ]}
              />
            </div>
          </div>
          <div className="px-3 pb-3">
            {activity.data ? (
              lanes.length ? (
                <Lanes lanes={lanes} span={SPAN_H} onOpen={(id) => router.push('/boxes/' + id)} />
              ) : (
                <div className="px-2 pb-3 text-sm text-muted-foreground">
                  No box ran in the last {SPAN_H} hours.
                </div>
              )
            ) : (
              <Unavailable what="Activity" error={activity.error} />
            )}
          </div>
        </Card>

        <div className="flex min-w-0 flex-col gap-3">
          <Card className="overflow-hidden">
            <div className="flex items-center gap-2 px-4 pb-2 pt-4">
              <span
                className={cn(
                  'size-2 flex-none rounded-full',
                  live.length ? 'bg-[var(--green)]' : 'bg-[var(--faint)]',
                )}
              />
              <span className="text-[15px] font-semibold">Live now</span>
              <span className="ml-auto font-mono text-[11px] text-muted-foreground">
                {live.length} running
              </span>
            </div>
            {live.length ? (
              <div className="divide-y divide-border">
                {live.slice(0, 6).map((b) => (
                  <LiveRow key={b.id} box={b} />
                ))}
              </div>
            ) : (
              <div className="px-4 pb-4 text-sm text-muted-foreground">Nothing is running.</div>
            )}
          </Card>

          <Card className="min-h-0 flex-1 overflow-hidden">
            <CardHead title="Recent activity" />
            {activity.data ? (
              feed.length ? (
                <div className="px-2 pb-2">
                  {feed.map((e) => (
                    <FeedRow
                      key={e.id}
                      entry={e}
                      now={readAt}
                      known={!!e.boxId && boxes.some((b) => b.id === e.boxId)}
                    />
                  ))}
                </div>
              ) : (
                <div className="px-4 pb-4 text-sm text-muted-foreground">
                  Nothing in the last two days.
                </div>
              )
            ) : (
              <Unavailable what="Activity" error={activity.error} />
            )}
          </Card>
        </div>
      </div>

      {/* the week, and what needs a hand */}
      <div className="mt-3 grid grid-cols-[minmax(0,1fr)_340px] gap-3 max-xl:grid-cols-1">
        <Card className="min-w-0 p-5">
          <div className="flex flex-wrap items-start gap-3">
            <div>
              <div className="text-[15px] font-semibold">Shipped this week</div>
              <div className="mt-0.5 text-[12.5px] text-muted-foreground">
                Commits per day. Purple dots are pull requests merged that day.
              </div>
            </div>
            {week ? (
              <div className="ml-auto flex gap-6">
                {(
                  [
                    ['commits', week.reduce((a, d) => a + d.commits, 0)],
                    ['PRs merged', week.reduce((a, d) => a + d.prs, 0)],
                    ['agent-hours', Math.round(week.reduce((a, d) => a + d.agentHours, 0))],
                  ] as const
                ).map(([k, v]) => (
                  <div key={k} className="text-right">
                    <div className="text-xl font-semibold tabular-nums">{v}</div>
                    <div className="eyebrow !text-[9.5px]">{k}</div>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
          <div className="mt-3">
            {week ? (
              <WeekBars
                labels={week.map((d) => d.label)}
                values={week.map((d) => d.commits)}
                secondary={week.map((d) => d.prs)}
                tip={(i) => {
                  const d = week[i]!;
                  return (
                    <div className="space-y-0.5">
                      <div className="font-medium">{d.label}</div>
                      <div className="font-mono">
                        {plural(d.commits, 'commit')} · {plural(d.prs, 'PR')}
                      </div>
                      <div className="font-mono text-muted-foreground">
                        {fmtHours(d.agentHours)}h ·{' '}
                        <span className="text-[var(--green-ink)]">+{d.additions}</span>{' '}
                        <span className="text-[var(--red)]">−{d.deletions}</span>
                      </div>
                    </div>
                  );
                }}
              />
            ) : (
              <Unavailable what="Usage stats" error={stats.error} />
            )}
          </div>
        </Card>

        <Card className="overflow-hidden">
          <CardHead
            title="Needs a hand"
            right={
              <span className="font-mono text-[11px] text-muted-foreground">
                {attention.length}
              </span>
            }
          />
          {attention.length ? (
            <div className="divide-y divide-border">
              {attention.map((b) => (
                <Link
                  key={b.id}
                  href={'/boxes/' + b.id}
                  className="block px-4 py-2.5 transition-colors hover:bg-muted/50"
                >
                  <div className="flex items-center gap-2">
                    <span
                      className={cn(
                        'size-1.5 flex-none rounded-full',
                        b.status === 'error' ? 'bg-[var(--red)]' : 'bg-[var(--amber)]',
                      )}
                    />
                    <span className="min-w-0 flex-1 truncate text-[13px] font-medium">
                      {b.task}
                    </span>
                  </div>
                  <div className="mt-0.5 truncate pl-3.5 text-xs text-muted-foreground">
                    {b.status === 'error'
                      ? b.error || 'The box errored'
                      : `${limited.get(b.id) ?? 'Its subscription'} is at its limit`}
                  </div>
                </Link>
              ))}
            </div>
          ) : (
            <div className="px-4 pb-4 text-sm text-muted-foreground">Nothing is stuck.</div>
          )}
        </Card>
      </div>

      {/* every box */}
      <div className="mb-3 mt-9 flex flex-wrap items-center gap-2">
        <h2 className="mr-2 text-[15px] font-semibold">Your boxes</h2>
        <div className="relative">
          <Icons.search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Filter boxes…"
            aria-label="Filter boxes"
            className="h-8 w-60 pl-8 max-sm:w-44"
          />
        </div>
        <Facet title="Status" options={statusOpts} selected={status} onChange={setStatus} />
        <Facet title="Project" options={projOpts} selected={projects} onChange={setProjects} />
        {filtering ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setQ('');
              setStatus([]);
              setProjects([]);
            }}
          >
            Reset
            <Icons.x />
          </Button>
        ) : null}
        <span className="flex-1" />
        <Tabs<View>
          value={view}
          onChange={pickView}
          className="h-8"
          label="Box list layout"
          items={[
            { id: 'table', label: 'All', icon: Icons.list },
            { id: 'projects', label: 'By project', icon: Icons.layout },
          ]}
        />
      </div>

      {view === 'table' ? (
        boxes.length === 0 ? (
          <EmptyBox>
            <div className="font-medium text-foreground">No boxes yet</div>
            <div className="mt-1">
              {state.projects.length
                ? 'Create one from a project, or run `agentbox claude` in a repo.'
                : 'Add a project first, or run `agentbox create` in a folder.'}
            </div>
          </EmptyBox>
        ) : filtered.length ? (
          <Card className="overflow-hidden">
            <BoxTable boxes={filtered} showProject bare />
            <div className="flex items-center border-t border-border px-4 py-2.5 font-mono text-[11px] text-muted-foreground">
              {filtered.length} of {plural(boxes.length, 'box', 'boxes')}
            </div>
          </Card>
        ) : (
          <EmptyBox icon={Icons.search}>
            <div className="font-medium text-foreground">No boxes match</div>
            <div className="mt-1">Try clearing a filter.</div>
          </EmptyBox>
        )
      ) : state.projects.length === 0 ? (
        <EmptyBox icon={Icons.folder}>
          <div className="font-medium text-foreground">No projects yet</div>
          <div className="mt-1">
            Add one with New project, or run `agentbox create` in a folder.
          </div>
        </EmptyBox>
      ) : (
        state.projects
          .filter((p) => !projects.length || projects.includes(p.id))
          .map((p) => {
            const bs = filtered.filter((b) => b.projectId === p.id);
            return (
              <div className="mb-6" key={p.id}>
                <div className="mb-2.5 flex flex-wrap items-center gap-2.5">
                  <Link
                    className="flex items-center gap-2 text-sm font-semibold hover:text-primary"
                    href={'/projects/' + p.id}
                  >
                    <span className="grid size-[22px] place-items-center rounded-md border border-[var(--green-line)] bg-[var(--green-soft)] text-[var(--green-ink)]">
                      <Icons.folder className="size-3" />
                    </span>
                    {p.name}
                  </Link>
                  <span className="truncate font-mono text-xs text-muted-foreground">{p.repo}</span>
                  <span className="flex-1" />
                  <span className="font-mono text-[11px] text-muted-foreground">
                    {plural(bs.length, 'box', 'boxes')}
                  </span>
                  <CreateBoxButton project={p} variant="outline" size="sm" label="New box" />
                </div>
                {bs.length ? (
                  <BoxTable boxes={bs} />
                ) : (
                  <div className="rounded-xl border border-dashed border-border px-4 py-5 text-center text-sm text-muted-foreground">
                    No boxes{filtering ? ' match' : ' yet'}.
                  </div>
                )}
              </div>
            );
          })
      )}
    </div>
  );
}

function LiveRow({ box }: { box: Box }) {
  const live = primaryLive(box);
  const tokens = usageTotal(live?.entry.usage);
  const doing = live ? liveActivity(live.entry) : undefined;
  const title = live?.entry.sessionTitle;
  const line = doing ?? (title && title.trim() !== box.task.trim() ? title : undefined);
  const Glyph = agentIcon(box.agent, Icons.terminal);
  return (
    <Link
      href={'/boxes/' + box.id}
      className="block px-4 py-2.5 transition-colors hover:bg-muted/50"
    >
      <div className="flex items-center gap-2">
        <Glyph className="size-3.5 flex-none" />
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{box.task}</span>
        {tokens !== undefined ? (
          <span className="font-mono text-[11px] text-muted-foreground">
            {formatTokenCount(tokens)}
          </span>
        ) : null}
      </div>
      <div className="mt-1 truncate text-xs text-muted-foreground">
        <span className="text-[var(--green-ink)]">›</span>{' '}
        {line ?? `${box.name || box.id} · ${box.host}`}
      </div>
    </Link>
  );
}

function FeedRow({ entry, now, known }: { entry: FeedEntry; now: number; known: boolean }) {
  const { icon: Ic, tone } = FEED_ICON[entry.kind];
  const body = (
    <>
      <Ic className={cn('mt-[3px] size-3.5 flex-none', tone)} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12.5px]">{entry.text}</span>
        <span className="block truncate font-mono text-[10.5px] text-muted-foreground">
          {entry.meta}
          {entry.additions !== undefined || entry.deletions !== undefined ? (
            <>
              {entry.meta ? ' · ' : ''}
              <span className="text-[var(--green-ink)]">+{entry.additions ?? 0}</span>{' '}
              <span className="text-[var(--red)]">−{entry.deletions ?? 0}</span>
            </>
          ) : null}
        </span>
      </span>
      <span className="flex-none font-mono text-[10.5px] text-muted-foreground">
        {relShort(entry.at, now)}
      </span>
    </>
  );
  const cls = 'flex w-full items-start gap-2.5 rounded-md px-2 py-1.5 text-left';
  return known && entry.boxId ? (
    <Link href={'/boxes/' + entry.boxId} className={cn(cls, 'hover:bg-muted/50')}>
      {body}
    </Link>
  ) : (
    <div className={cls}>{body}</div>
  );
}
