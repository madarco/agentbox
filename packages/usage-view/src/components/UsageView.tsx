import { useMemo, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { addDays, claimsHoursSaved, hoursSaved, maxOf } from '../aggregate.js';
import { decodeDaily, decodeWall } from '../columns.js';
import { AGENT_IDS, PROVIDER_IDS } from '../schema.js';
import type {
  AgentId,
  BoxRow,
  DailyStats,
  FeedItem,
  ProjectRow,
  ProviderId,
  RangeId,
  SplitValues,
  SubscriptionRow,
  UsageShare,
  UsageStats,
} from '../schema.js';
import {
  ConcChart,
  DailyChart,
  DiffChart,
  Gantt,
  HeroPixels,
  Punchcard,
  Spark,
  Wall,
  ganttSummary,
} from './charts.js';
import type { GanttLane, StackRow, StackSeries, WallCell } from './charts.js';
import {
  AGENT_COLOR,
  AGENT_LABEL,
  DOW,
  DOW_LONG,
  PROVIDER_COLOR,
  PROVIDER_LABEL,
  SERIES_COLORS,
  dayMonth,
  daysInclusive,
  dm,
  duration,
  fmt,
  fmtLines,
  hoursLabel,
  hrs,
  nf,
  previousLabel,
  rangeLabel,
  rangeNoun,
  shortDay,
} from './format.js';
import { CountUp, Seg, TipProvider, TipRow } from './hooks.js';
import { AgentIcon, Icons, ProviderLogo } from './marks.js';

export interface UsageViewProps {
  /** A hub's full stats, or a public share (which hides every name). */
  data: UsageStats | UsageShare;
  /** The window control; omitted, the page shows no range switch. */
  onRangeChange?: (id: RangeId) => void;
  /** Extra header controls: the subscription filter, Export CSV, Share. */
  actions?: ReactNode;
  /** Replaces the footer line. */
  footer?: ReactNode;
  className?: string;
}

/** The fields both variants render; the private ones are absent on a share. */
interface View {
  share: boolean;
  /** A share's display name, if it has one. */
  name: string | null;
  range: UsageStats['range'];
  hero: UsageStats['hero'];
  /** A share has no `hoursSaved` KPI: its value comes from the hero, with no delta. */
  kpis: UsageShare['kpis'] & Partial<Pick<UsageStats['kpis'], 'hoursSaved'>>;
  daily: (Omit<DailyStats, 'byProject'> & { byProject?: Record<string, SplitValues> })[];
  wall: UsageStats['wall'];
  streaks: UsageStats['streaks'];
  punchcard: number[][];
  gantt: { date: string; lanes: GanttLane[] }[];
  sessions: {
    agent: AgentId;
    provider: ProviderId;
    boxes: number;
    peak: number;
    prsMerged: number;
    minutes: number;
    title: string | null;
    project: string | null;
  }[];
  providers: { id: ProviderId; hours: number; boxes: number; note: string | null }[];
  feed: FeedItem[] | null;
  feedTotal: number;
  boxes: BoxRow[] | null;
  projects: ProjectRow[] | null;
  subscriptions: SubscriptionRow[] | null;
  generatedAt: string | null;
}

function toView(data: UsageStats | UsageShare): View {
  if (!('generatedAt' in data)) {
    return {
      share: true,
      name: data.name ?? null,
      range: data.range,
      hero: data.hero,
      kpis: data.kpis,
      daily: decodeDaily(data.daily),
      wall: decodeWall(data.wall),
      streaks: data.streaks,
      punchcard: data.punchcard,
      gantt: data.gantt.map((g) => ({
        date: g.date,
        lanes: g.lanes.map((l) => ({ ...l, label: null, pr: null })),
      })),
      sessions: data.sessions.map((s) => ({ ...s, title: null, project: null })),
      providers: data.providers.map((p) => ({ ...p, note: null })),
      feed: null,
      feedTotal: data.hero.prsMerged,
      boxes: null,
      projects: null,
      subscriptions: null,
      generatedAt: null,
    };
  }
  return {
    share: false,
    name: null,
    range: data.range,
    hero: data.hero,
    kpis: data.kpis,
    daily: data.daily,
    wall: data.wall,
    streaks: data.streaks,
    punchcard: data.punchcard,
    gantt: data.gantt.map((g) => ({
      date: g.date,
      lanes: g.lanes.map((l) => ({ ...l, label: l.box, merged: l.pr !== null })),
    })),
    sessions: data.sessions,
    providers: data.providers,
    feed: data.feed,
    feedTotal: data.feedTotal,
    boxes: data.boxes,
    projects: data.projects,
    subscriptions: data.subscriptions,
    generatedAt: data.generatedAt,
  };
}

const RANGE_OPTIONS = [
  ['7d', '7 days'],
  ['30d', '30 days'],
  ['month', 'This month'],
  ['90d', '90 days'],
  ['year', 'Year'],
] as const;

function Delta({
  value,
  suffix = '',
}: {
  value: number | null;
  suffix?: string;
}): ReactElement | null {
  if (value === null || value === 0) return null;
  const up = value > 0;
  return (
    <span className={`delta ${up ? 'up' : 'down'}`}>
      {up ? '+' : '−'}
      {Math.abs(value)}
      {suffix}
    </span>
  );
}

export function UsageView({
  data,
  onRangeChange,
  actions,
  footer,
  className,
}: UsageViewProps): ReactElement {
  const v = useMemo(() => toView(data), [data]);
  return (
    <div className={`usage${className ? ` ${className}` : ''}`}>
      <TipProvider>
        <Header v={v} onRangeChange={onRangeChange} actions={actions} />
        <Hero v={v} />
        <Kpis v={v} />
        <Parallel v={v} />
        <Daily v={v} />
        <Activity v={v} />
        <Boxes v={v} />
        <Code v={v} />
        {!v.share && <Leaderboard v={v} />}
        <div className="foot-note">
          {Icons.info}
          {footer ??
            (v.share
              ? `Shared ${v.name ? `by ${v.name} ` : ''}from AgentBox. Numbers only: no project, box or pull request names leave the hub.`
              : `Updated ${v.generatedAt ? new Date(v.generatedAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : 'just now'}.`)}
        </div>
      </TipProvider>
    </div>
  );
}

function Header({
  v,
  onRangeChange,
  actions,
}: {
  v: View;
  onRangeChange?: (id: RangeId) => void;
  actions?: ReactNode;
}): ReactElement {
  return (
    <div className="head">
      <div>
        <h1>
          Usage <em>and output</em>
        </h1>
        <p>
          {v.share
            ? `What ${v.name ? `${v.name}'s` : 'these'} agents did side by side, what they shipped, and the hours it took.`
            : 'What your agents did side by side, what they shipped, and the hours and tokens it used.'}
        </p>
      </div>
      {(onRangeChange || actions) && (
        <div className="controls">
          {onRangeChange && (
            <Seg
              label="Range"
              options={RANGE_OPTIONS}
              value={v.range.id}
              onChange={onRangeChange}
            />
          )}
          {actions}
        </div>
      )}
    </div>
  );
}

function Hero({ v }: { v: View }): ReactElement {
  const h = v.hero;
  const saved = hoursSaved(h);
  const top = [...v.providers].sort((a, b) => b.hours - a.hours);
  const provTotal = top.reduce((a, p) => a + p.hours, 0);
  const faces = top.slice(0, 3);
  const rest = top.length - faces.length;
  const names = faces.map((p) => (
    <b key={p.id}>
      {PROVIDER_LABEL[p.id]} <span>{provTotal ? Math.round((p.hours / provTotal) * 100) : 0}%</span>
    </b>
  ));
  const who = v.share ? (v.name ? `${v.name}'s agents` : 'These agents') : 'Your agents';
  return (
    <section className="hero">
      <div>
        <div className="eyebrow">
          {rangeLabel(v.range.id, v.range.since, v.range.until, v.range.today)}
        </div>
        <h2>
          {who} did{' '}
          <b>
            <CountUp value={h.agentHours} format={nf} /> hours
          </b>{' '}
          of work in <b>{nf(h.wallHours)} hours</b>. Side by side, they got{' '}
          <b>{h.speedup.toFixed(1)}×</b> as much done as one agent alone
          {claimsHoursSaved(h) ? (
            <>
              , <b>{hoursLabel(saved)}</b> saved vs. one agent at a time
            </>
          ) : null}
          . <em>Up to {h.peakAtOnce} ran at the same time.</em>
        </h2>
        <div className="chips">
          <span className="chip">
            {Icons.lanes}
            <span>
              <b>{h.peakAtOnce} boxes</b> at once{h.peakDate ? ` on ${shortDay(h.peakDate)}` : ''}
            </span>
          </span>
          <span className="chip">
            {Icons.pr}
            <span>
              <b>
                {h.maxPrsInSession} pull {h.maxPrsInSession === 1 ? 'request' : 'requests'}
              </b>{' '}
              in one session
            </span>
          </span>
          <span className="chip">
            {Icons.clock}
            <span>
              <b>{nf(h.parallelHours)} hours</b> with 2+ boxes running
            </span>
          </span>
          <span className="chip">
            {Icons.flame}
            <span>
              <b>
                {h.streakDays} {h.streakDays === 1 ? 'day' : 'days'}
              </b>{' '}
              in a row with commits
            </span>
          </span>
        </div>
        {faces.length > 0 && (
          <div className="faces">
            <div className="face-stack">
              {faces.map((p, i) => (
                <span
                  key={p.id}
                  className="face"
                  style={{ zIndex: 3 - i }}
                  title={`${PROVIDER_LABEL[p.id]}: ${nf(p.hours)} h`}
                >
                  <ProviderLogo id={p.id} size={38} />
                </span>
              ))}
              {rest > 0 && <span className="face more">+{rest}</span>}
            </div>
            <div className="face-text">
              <div className="eyebrow">Most used sandboxes</div>
              {names.length > 1 ? (
                <>
                  {names.slice(0, -1).flatMap((n, i) => (i ? [', ', n] : [n]))} and{' '}
                  {names[names.length - 1]}
                </>
              ) : (
                names[0]
              )}
              <small>
                share of {nf(provTotal)} agent-hours, {top.length}{' '}
                {top.length === 1 ? 'provider' : 'providers'} in all
              </small>
            </div>
          </div>
        )}
      </div>
      <div className="hero-right">
        <div className="eyebrow">Side by side</div>
        <div className="hero-stats">
          <div>
            <div className="n">
              <CountUp value={h.peakAtOnce} format={nf} />
            </div>
            <div className="l">most boxes at once</div>
          </div>
          <div>
            <div className="n">
              {h.speedup.toFixed(1)}
              <small>×</small>
            </div>
            <div className="l">the work of one agent</div>
          </div>
          <div>
            <div className="n">
              <CountUp value={saved} format={hrs} />
              <small>h</small>
            </div>
            <div className="l">saved vs. one agent at a time</div>
          </div>
          <div>
            <div className="n">
              <CountUp value={h.sessionsWith3Plus} format={nf} />
            </div>
            <div className="l">sessions with 3 or more boxes</div>
          </div>
        </div>
        <div className="eyebrow">Shipped</div>
        <div className="hero-stats shipped">
          <div>
            <div className="n">
              <CountUp value={h.prsMerged} format={nf} />
            </div>
            <div className="l">pull requests merged</div>
            <span className="best">best day: {nf(h.bestDayPrs)}</span>
          </div>
          <div>
            <div className="n">
              <CountUp value={h.commits} format={nf} />
            </div>
            <div className="l">commits</div>
            <span className="best">best day: {nf(h.bestDayCommits)}</span>
          </div>
          <div>
            <div className="n">
              <span className="add">+{fmtLines(h.additions)}</span>{' '}
              <span className="del">−{fmtLines(h.deletions)}</span>
            </div>
            <div className="l">lines added and removed</div>
            <span className="best">biggest PR: +{nf(h.biggestPrAdditions)}</span>
          </div>
          <div>
            <div className="n">
              <CountUp value={h.files} format={nf} />
            </div>
            <div className="l">files changed</div>
            <span className="best">across {nf(h.boxes)} boxes</span>
          </div>
        </div>
      </div>
      <HeroPixels values={v.wall.map((w) => w.all)} />
    </section>
  );
}

function Kpis({ v }: { v: View }): ReactElement {
  const k = v.kpis;
  // A share: the value from the hero, no delta.
  const saved = k.hoursSaved ?? { value: hoursSaved(v.hero), delta: null };
  const days = v.daily;
  const prev = previousLabel(v.range.id, v.range.since);
  return (
    <div className="kpis">
      <div className="card kpi">
        <div className="top">
          <span className="eyebrow">Boxes at once</span>
          <span className="ico" style={{ background: 'var(--green-soft)', color: 'var(--green)' }}>
            {Icons.lanes}
          </span>
        </div>
        <div className="v">
          {k.peak.value}
          <small>peak</small>
        </div>
        <div className="meta">
          <Delta value={k.peak.delta} />
          {k.peak.delta !== null ? `vs ${prev}` : null}
          {!v.share && k.peak.runningNow > 0
            ? `${k.peak.delta !== null ? ' · ' : ''}${k.peak.runningNow} running now`
            : null}
        </div>
        <Spark values={days.map((d) => d.peak)} color="var(--green)" />
      </div>
      <div className="card kpi">
        <div className="top">
          <span className="eyebrow">Parallel speed-up</span>
          <span className="ico" style={{ background: 'var(--blue-soft)', color: 'var(--blue)' }}>
            {Icons.bolt}
          </span>
        </div>
        <div className="v">
          {k.speedup.value.toFixed(1)}
          <small>×</small>
        </div>
        <div className="meta">
          <Delta value={k.speedup.delta} suffix="×" />
          {nf(v.hero.agentHours)} h of work in {nf(v.hero.wallHours)} h
        </div>
        <Spark values={days.map((d) => d.avgAtOnce)} color="var(--blue)" />
      </div>
      <div className="card kpi">
        <div className="top">
          <span className="eyebrow">Hours saved</span>
          <span className="ico" style={{ background: 'var(--green-soft)', color: 'var(--green)' }}>
            {Icons.clock}
          </span>
        </div>
        <div className="v">
          {hrs(saved.value)}
          <small>h</small>
        </div>
        <div className="meta">
          <Delta value={saved.delta} suffix=" h" />
          vs. one agent at a time
        </div>
        <Spark values={days.map((d) => hoursSaved(d))} color="var(--green)" />
      </div>
      <div className="card kpi">
        <div className="top">
          <span className="eyebrow">Pull requests merged</span>
          <span
            className="ico"
            style={{ background: 'var(--violet-soft)', color: 'var(--violet)' }}
          >
            {Icons.pr}
          </span>
        </div>
        <div className="v">{nf(k.prs.value)}</div>
        <div className="meta">
          <Delta value={k.prs.delta} />
          {!v.share && k.prs.waitingReview > 0
            ? `${k.prs.waitingReview} waiting for review`
            : k.prs.delta !== null
              ? `vs ${prev}`
              : null}
        </div>
        <Spark values={days.map((d) => d.prsMerged)} color="var(--violet)" />
      </div>
      <div className="card kpi">
        <div className="top">
          <span className="eyebrow">Box-hours</span>
          <span className="ico" style={{ background: 'var(--amber-soft)', color: 'var(--amber)' }}>
            {Icons.box}
          </span>
        </div>
        <div className="v">
          {nf(k.boxHours.value)}
          <small>h</small>
        </div>
        <div className="meta">
          <Delta value={k.boxHours.deltaPct} suffix="%" />
          {nf(k.boxHours.boxes)} boxes · {fmt(k.boxHours.tokens)} tokens
        </div>
        <Spark values={days.map((d) => d.boxHours)} color="var(--amber)" />
      </div>
    </div>
  );
}

function SectionTitle({ title, sub }: { title: string; sub: string }): ReactElement {
  return (
    <div className="section-title">
      <h3>{title}</h3>
      <span>{sub}</span>
    </div>
  );
}

function Parallel({ v }: { v: View }): ReactElement {
  const [day, setDay] = useState(v.gantt[0]?.date ?? '');
  const current = v.gantt.find((g) => g.date === day) ?? v.gantt[0];
  const sum = current ? ganttSummary(current.lanes) : null;
  const agents = AGENT_IDS.filter((a) => current?.lanes.some((l) => l.agent === a));
  const rows = v.daily;
  return (
    <>
      <SectionTitle
        title="Running in parallel"
        sub="Many boxes at the same time is where the hours come from."
      />
      {current && sum && (
        <div className="card">
          <div className="card-h">
            <div>
              <h2>
                {dayMonth(current.date)}: {sum.peak} {sum.peak === 1 ? 'box' : 'boxes'} at once
              </h2>
              <div className="sub">
                {current.lanes.length} boxes · {sum.prs} PRs merged · {Math.round(sum.hours)}{' '}
                agent-hours in {sum.busy.toFixed(1)} h on the clock (
                {sum.busy > 0 ? (sum.hours / sum.busy).toFixed(1) : '0'}×)
              </div>
            </div>
            {v.gantt.length > 1 && (
              <div className="tools">
                <Seg
                  small
                  label="Day"
                  options={v.gantt.map((g) => [g.date, shortDay(g.date)] as const)}
                  value={current.date}
                  onChange={setDay}
                />
              </div>
            )}
          </div>
          <div className="legend">
            {agents.map((a) => (
              <span key={a}>
                <i style={{ background: AGENT_COLOR[a] }} />
                {AGENT_LABEL[a]}
              </span>
            ))}
            <span>
              <i style={{ background: 'var(--violet)', borderRadius: '50%' }} />
              PR merged
            </span>
            <span>
              <i
                style={{ background: 'var(--green-soft)', border: '1px solid var(--green-line)' }}
              />
              Most at once
            </span>
          </div>
          <Gantt key={current.date} lanes={current.lanes} />
        </div>
      )}
      <div className="grid2" style={{ marginTop: 14 }}>
        <div className="card">
          <div className="card-h">
            <div>
              <h2>Boxes at once, every day</h2>
              <div className="sub">
                The most running together, and the average while any box ran
              </div>
            </div>
          </div>
          <div className="legend">
            <span>
              <i style={{ background: 'var(--w3)' }} />
              Peak
            </span>
            <span>
              <i style={{ background: 'var(--s6)', height: 3, borderRadius: 2 }} />
              Average
            </span>
          </div>
          <ConcChart rows={rows} />
        </div>
        <div className="card">
          <div className="card-h">
            <div>
              <h2>Biggest sessions</h2>
              <div className="sub">
                {v.share ? 'Sessions' : 'Manager sessions'} that fanned out the most boxes. Filled:
                running at the same time.
              </div>
            </div>
          </div>
          <div className="table-scroll">
            <table className="lb sessions">
              <thead>
                <tr>
                  <th>Session</th>
                  <th>Boxes</th>
                  <th className="n">PRs</th>
                  <th className="n">Time</th>
                </tr>
              </thead>
              <tbody>
                {v.sessions.map((s, i) => (
                  <tr key={i}>
                    <td>
                      {s.title !== null ? (
                        <div className="nm">
                          {s.title}
                          {s.project && <small>{s.project}</small>}
                        </div>
                      ) : (
                        <div className="who">
                          <AgentIcon agent={s.agent} />
                          <div className="nm">
                            {AGENT_LABEL[s.agent]}
                            <small>on {PROVIDER_LABEL[s.provider]}</small>
                          </div>
                        </div>
                      )}
                    </td>
                    <td>
                      <div className="fan" title={`${s.boxes} boxes, ${s.peak} at once`}>
                        {Array.from({ length: Math.min(s.boxes, 16) }, (_, j) => (
                          <i key={j} className={j < s.peak ? 'on' : undefined} />
                        ))}
                      </div>
                      <div className="fan-n">
                        {s.boxes} boxes · <b>{s.peak} at once</b>
                      </div>
                    </td>
                    <td className="n">{s.prsMerged}</td>
                    <td className="n">{duration(s.minutes)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </>
  );
}

type Metric = 'tokens' | 'agentHours' | 'commits';
type Split = 'agent' | 'provider' | 'project';

const METRIC_FMT: Record<Metric, (n: number) => string> = {
  tokens: fmt,
  agentHours: (n) => `${hrs(n)} h`,
  commits: nf,
};
const METRIC_TITLE: Record<Metric, string> = {
  tokens: 'Tokens per day',
  agentHours: 'Agent-hours per day',
  commits: 'Commits per day',
};

function Daily({ v }: { v: View }): ReactElement {
  const [metric, setMetric] = useState<Metric>('tokens');
  const hasProjects = v.daily.some((d) => d.byProject && Object.keys(d.byProject).length > 0);
  const [split, setSplit] = useState<Split>('agent');
  const splitNow: Split = split === 'project' && !hasProjects ? 'agent' : split;
  const format = METRIC_FMT[metric];

  const series: StackSeries[] = useMemo(() => {
    const totals = new Map<string, number>();
    for (const d of v.daily) {
      const rec: Record<string, SplitValues | undefined> =
        splitNow === 'agent'
          ? d.byAgent
          : splitNow === 'provider'
            ? d.byProvider
            : (d.byProject ?? {});
      for (const [k, s] of Object.entries(rec))
        if (s) totals.set(k, (totals.get(k) ?? 0) + s[metric]);
    }
    const keys = [...totals.entries()]
      .filter(([, t]) => t > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([k]) => k);
    if (splitNow === 'agent') {
      return AGENT_IDS.filter((a) => keys.includes(a)).map((a) => ({
        key: a,
        label: AGENT_LABEL[a],
        color: AGENT_COLOR[a],
      }));
    }
    if (splitNow === 'provider') {
      return PROVIDER_IDS.filter((p) => keys.includes(p)).map((p) => ({
        key: p,
        label: PROVIDER_LABEL[p],
        color: PROVIDER_COLOR[p],
      }));
    }
    return keys
      .slice(0, SERIES_COLORS.length)
      .map((k, i) => ({ key: k, label: k, color: SERIES_COLORS[i]! }));
  }, [v.daily, splitNow, metric]);

  const real = v.daily.filter((d) => d.date <= v.range.today);
  const lastDay = v.range.today < v.range.until ? v.range.today : v.range.until;
  const soFar = real.reduce((a, d) => a + d[metric], 0);
  const pace = real.length ? soFar / real.length : 0;
  const remaining =
    v.range.today < v.range.until ? daysInclusive(v.range.today, v.range.until) - 1 : 0;
  const forecast = soFar + pace * remaining;
  const rows: StackRow[] = real.map((d) => {
    const rec: Record<string, SplitValues | undefined> =
      splitNow === 'agent'
        ? d.byAgent
        : splitNow === 'provider'
          ? d.byProvider
          : (d.byProject ?? {});
    return {
      date: d.date,
      forecast: false,
      total: d[metric],
      parts: Object.fromEntries(series.map((s) => [s.key, rec[s.key]?.[metric] ?? 0])),
      prsMerged: d.prsMerged,
      commits: d.commits,
    };
  });
  for (let i = 1; i <= remaining; i++) {
    rows.push({
      date: addDays(v.range.today, i),
      forecast: true,
      total: pace,
      parts: {},
      prsMerged: 0,
      commits: 0,
    });
  }
  const splitOptions: (readonly [Split, string])[] = [
    ['agent', 'By agent'],
    ['provider', 'By provider'],
    ...(hasProjects ? [['project', 'By project'] as const] : []),
  ];
  return (
    <>
      <SectionTitle
        title={
          real.length < daysInclusive(v.range.since, lastDay)
            ? `Every day, the last ${real.length} days`
            : `Every day ${rangeNoun(v.range.id)}`
        }
        sub={`Stacked by who did the work.${remaining ? ' Hatched bars are the forecast to the end of the window.' : ''}`}
      />
      <div className="card">
        <div className="card-h">
          <div>
            <h2>{METRIC_TITLE[metric]}</h2>
            <div className="sub">
              {remaining
                ? `Forecast ${format(forecast)} by ${dm(v.range.until)} at this pace`
                : `${format(soFar)} in ${real.length} days`}
            </div>
          </div>
          <div className="tools">
            <Seg small label="Split" options={splitOptions} value={splitNow} onChange={setSplit} />
            <Seg
              small
              label="Metric"
              options={[
                ['tokens', 'Tokens'],
                ['agentHours', 'Agent-hours'],
                ['commits', 'Commits'],
              ]}
              value={metric}
              onChange={setMetric}
            />
          </div>
        </div>
        <div className="legend">
          {series.map((s) => (
            <span key={s.key}>
              <i style={{ background: s.color }} />
              {s.label}
            </span>
          ))}
          {remaining > 0 && (
            <span>
              <i className="hatch" />
              Forecast
            </span>
          )}
          <span className="tot">{format(soFar)} so far</span>
        </div>
        <DailyChart rows={rows} series={series} format={format} showToday={remaining > 0} />
      </div>
    </>
  );
}

type WallMetric = 'all' | 'peak' | 'commits' | 'prs' | 'agentHours' | 'tokens';
const WALL_LABEL: Record<WallMetric, string> = {
  all: 'contributions',
  peak: '',
  commits: 'commits',
  prs: 'pull requests merged',
  agentHours: 'agent-hours',
  tokens: 'tokens',
};

function Activity({ v }: { v: View }): ReactElement {
  const [metric, setMetric] = useState<WallMetric>('all');
  const total = v.wall.reduce((a, d) => a + d[metric], 0);
  const title =
    metric === 'peak'
      ? `Up to ${maxOf(
          v.wall.map((d) => d.peak),
          0,
        )} boxes at once, ${v.wall.filter((d) => d.peak >= 3).length} days with 3 or more`
      : `${metric === 'tokens' ? fmt(total) : nf(total)} ${WALL_LABEL[metric]} in the last year`;
  const cells: WallCell[] = v.wall.map((d) => ({
    date: d.date,
    value: d[metric],
    detail:
      d.all === 0 && d.agentHours === 0 ? null : (
        <>
          <TipRow color="var(--w5)" label="Boxes at once" value={d.peak} />
          <TipRow color="var(--w4)" label="Commits" value={nf(d.commits)} />
          <TipRow color="var(--violet)" label="PRs merged" value={d.prs} />
          <div className="hr" />
          <div className="r">
            Agent-hours<b>{hrs(d.agentHours)} h</b>
          </div>
          <div className="r">
            Tokens<b>{fmt(d.tokens)}</b>
          </div>
        </>
      ),
  }));
  const s = v.streaks;
  return (
    <>
      <SectionTitle
        title="Activity"
        sub="One square per day for the last year. Darker means more work."
      />
      <div className="card wall-card">
        <div style={{ minWidth: 0 }}>
          <div className="card-h">
            <div>
              <h2>{title}</h2>
              <div className="sub">Commits and merged pull requests from every box</div>
            </div>
            <div className="tools">
              <Seg
                small
                label="Wall metric"
                options={[
                  ['all', 'All work'],
                  ['peak', 'Boxes at once'],
                  ['commits', 'Commits'],
                  ['prs', 'PRs'],
                  ['agentHours', 'Agent-hours'],
                  ['tokens', 'Tokens'],
                ]}
                value={metric}
                onChange={setMetric}
              />
            </div>
          </div>
          <div className="wall-body">
            <Wall cells={cells} firstDate={s.firstDate} />
            <div className="wall-legend">
              Less <i style={{ background: 'var(--w0)' }} />
              <i style={{ background: 'var(--w1)' }} />
              <i style={{ background: 'var(--w2)' }} />
              <i style={{ background: 'var(--w3)' }} />
              <i style={{ background: 'var(--w4)' }} />
              <i style={{ background: 'var(--w5)' }} /> More
            </div>
          </div>
        </div>
        <div className="wall-side">
          <div>
            <div className="big">
              {s.current}
              <small> {s.current === 1 ? 'day' : 'days'}</small>
            </div>
            <div className="lbl">Current streak</div>
            {s.best > s.current ? (
              <span className="flame">personal best is {s.best}</span>
            ) : (
              s.current > 0 && <span className="flame">personal best</span>
            )}
          </div>
          <div>
            <div className="big">
              {s.activeDays}
              <small> / {s.daysSinceFirst}</small>
            </div>
            <div className="lbl">Active days{s.firstDate ? ` since ${dm(s.firstDate)}` : ''}</div>
          </div>
          {s.busiestWeekday !== null && (
            <div>
              <div className="big">{DOW[s.busiestWeekday]}</div>
              <div className="lbl" title={DOW_LONG[s.busiestWeekday]}>
                Busiest weekday, {Math.round(s.busiestWeekdayShare * 100)}% of commits
              </div>
            </div>
          )}
          {s.bestDay && (
            <div>
              <div className="big">{nf(s.bestDay.commits)}</div>
              <div className="lbl">Most commits in one day, {dm(s.bestDay.date)}</div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

function Boxes({ v }: { v: View }): ReactElement {
  const [metric, setMetric] = useState<'hours' | 'boxes'>('hours');
  const night = v.punchcard.reduce((a, row) => a + row.slice(0, 7).reduce((x, y) => x + y, 0), 0);
  const total = v.providers.reduce((a, p) => a + p[metric], 0) || 1;
  const max = maxOf(
    v.providers.map((p) => p[metric]),
    1,
  );
  const hoursTotal = v.providers.reduce((a, p) => a + p.hours, 0);
  return (
    <>
      <SectionTitle title="Boxes" sub="Where the agents ran, and when." />
      <div className="grid2">
        <div className="card">
          <div className="card-h">
            <div>
              <h2>When your agents work</h2>
              <div className="sub">
                Agent-hours by hour of day, {rangeNoun(v.range.id)}. {nf(night)} h ran between
                midnight and 7 am.
              </div>
            </div>
          </div>
          <Punchcard grid={v.punchcard} />
        </div>
        <div className="card">
          <div className="card-h">
            <div>
              <h2>Providers</h2>
              <div className="sub">
                {nf(hoursTotal)} agent-hours on {v.providers.length}{' '}
                {v.providers.length === 1 ? 'provider' : 'providers'}
              </div>
            </div>
            <div className="tools">
              <Seg
                small
                label="Provider metric"
                options={[
                  ['hours', 'Hours'],
                  ['boxes', 'Boxes'],
                ]}
                value={metric}
                onChange={setMetric}
              />
            </div>
          </div>
          <div className="prov">
            <div className="prov-stack">
              {v.providers.map((p) => (
                <div
                  key={p.id}
                  style={{ flex: p[metric], background: PROVIDER_COLOR[p.id] }}
                  title={PROVIDER_LABEL[p.id]}
                />
              ))}
            </div>
            {v.providers.map((p) => (
              <div key={p.id} className="prov-row">
                <ProviderLogo id={p.id} size={22} />
                <span className="name">
                  {PROVIDER_LABEL[p.id]}
                  {p.note && <small>{p.note}</small>}
                </span>
                <span className="h">
                  {nf(p[metric])}
                  {metric === 'hours' ? ' h' : ''}
                </span>
                <span className="pct">{Math.round((p[metric] / total) * 100)}%</span>
                <div className="bar">
                  <div
                    style={{
                      width: `${(p[metric] / max) * 100}%`,
                      background: PROVIDER_COLOR[p.id],
                    }}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}

function ago(iso: string, now: string | null): string {
  const ms = Date.parse(now ?? new Date().toISOString()) - Date.parse(iso);
  const h = Math.floor(ms / 3600e3);
  if (h < 1) return 'just now';
  if (h < 24) return `${h} h ago`;
  const d = Math.floor(h / 24);
  return d === 1 ? 'yesterday' : `${d} days ago`;
}

function Code({ v }: { v: View }): ReactElement {
  const rows = v.daily.filter((d) => d.date <= v.range.today);
  const net = v.hero.additions - v.hero.deletions;
  const diffCard = (
    <div className="card">
      <div className="card-h">
        <div>
          <h2>Lines changed per day</h2>
          <div className="sub">
            <span className="add">+{nf(v.hero.additions)}</span>
            {'  '}
            <span className="del">−{nf(v.hero.deletions)}</span>
            {'  '}net {net >= 0 ? '+' : '−'}
            {nf(Math.abs(net))}
          </div>
        </div>
      </div>
      <div className="legend">
        <span>
          <i style={{ background: 'var(--add)' }} />
          Added
        </span>
        <span>
          <i style={{ background: 'var(--del)' }} />
          Removed
        </span>
      </div>
      <DiffChart rows={rows} />
    </div>
  );
  return (
    <>
      <SectionTitle title="Code shipped" sub="Lines added and removed by the agents' pushes." />
      {v.feed ? (
        <div className="grid2">
          {diffCard}
          <div className="card">
            <div className="card-h">
              <div>
                <h2>Recently merged</h2>
                <div className="sub">The last pull requests your agents landed</div>
              </div>
              {v.feedTotal > 0 && (
                <div className="tools">
                  <span className="btn">All {nf(v.feedTotal)}</span>
                </div>
              )}
            </div>
            <div className="feed">
              {v.feed.map((f, fi) => {
                const tot = f.additions + f.deletions || 1;
                const ac = Math.round((f.additions / tot) * 5);
                return (
                  <div key={`${fi}-${f.repo}#${f.number}`} className="feed-row">
                    <div className="merged">{Icons.pr}</div>
                    <div style={{ minWidth: 0 }}>
                      <div className="t">{f.title}</div>
                      <div className="m">
                        <AgentIcon agent={f.agent} size={14} />
                        <span>{f.box}</span>
                        <span>·</span>
                        <span>
                          {f.repo}#{f.number}
                        </span>
                        <span>·</span>
                        <span>{PROVIDER_LABEL[f.provider]}</span>
                        <span>·</span>
                        <span>{ago(f.mergedAt, v.generatedAt)}</span>
                      </div>
                    </div>
                    <div>
                      <div className="lines">
                        <span className="add">+{nf(f.additions)}</span>{' '}
                        <span className="del">−{nf(f.deletions)}</span>
                      </div>
                      <div className="diffbar">
                        {Array.from({ length: 5 }, (_, i) => (
                          <i key={i} className={i < ac ? 'a' : 'd'} />
                        ))}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      ) : (
        diffCard
      )}
    </>
  );
}

function Leaderboard({ v }: { v: View }): ReactElement {
  const [metric, setMetric] = useState<'lines' | 'hours' | 'tokens'>('lines');
  const val = (b: BoxRow): number =>
    metric === 'lines' ? b.additions + b.deletions : metric === 'hours' ? b.hours : b.tokens;
  const boxes = [...(v.boxes ?? [])].sort((a, b) => val(b) - val(a)).slice(0, 6);
  const max = boxes[0] ? val(boxes[0]) || 1 : 1;
  return (
    <>
      <SectionTitle title="Leaderboard" sub={`Who did the most ${rangeNoun(v.range.id)}.`} />
      <div className="grid2">
        <div className="card">
          <div className="card-h">
            <div>
              <h2>Top boxes</h2>
            </div>
            <div className="tools">
              <Seg
                small
                label="Box metric"
                options={[
                  ['lines', 'Lines'],
                  ['hours', 'Hours'],
                  ['tokens', 'Tokens'],
                ]}
                value={metric}
                onChange={setMetric}
              />
            </div>
          </div>
          <div className="table-scroll">
            <table className="lb">
              <thead>
                <tr>
                  <th />
                  <th>Box</th>
                  <th className="n">PRs</th>
                  <th className="n">
                    {metric === 'lines' ? 'Lines' : metric === 'hours' ? 'Hours' : 'Tokens'}
                  </th>
                </tr>
              </thead>
              <tbody>
                {boxes.map((b, i) => (
                  <tr key={`${i}-${b.name}`}>
                    <td className="rank" style={{ paddingRight: 0 }}>
                      {i + 1}
                    </td>
                    <td>
                      <div className="who">
                        <AgentIcon agent={b.agent} />
                        <div className="nm">
                          {b.name}
                          <small>
                            {b.project ? `${b.project} · ` : ''}
                            {PROVIDER_LABEL[b.provider]}
                          </small>
                        </div>
                      </div>
                      <div className="inbar">
                        <div style={{ width: `${(val(b) / max) * 100}%` }} />
                      </div>
                    </td>
                    <td className="n">{b.prs}</td>
                    <td className="n">
                      {metric === 'lines' ? (
                        <>
                          <span className="add">+{fmt(b.additions)}</span>{' '}
                          <span className="del">−{fmt(b.deletions)}</span>
                        </>
                      ) : metric === 'hours' ? (
                        `${hrs(b.hours)} h`
                      ) : (
                        fmt(b.tokens)
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <div className="card">
          <div className="card-h">
            <div>
              <h2>Projects</h2>
            </div>
          </div>
          <div className="table-scroll">
            <table className="lb">
              <thead>
                <tr>
                  <th>Project</th>
                  <th className="n">PRs</th>
                  <th className="n">Commits</th>
                  <th className="n">Added</th>
                </tr>
              </thead>
              <tbody>
                {(v.projects ?? []).map((p, i) => (
                  <tr key={`${i}-${p.name}`}>
                    <td>
                      <div className="who">
                        <span
                          className="sw"
                          style={{ background: SERIES_COLORS[i % SERIES_COLORS.length] }}
                        />
                        <span className="nm">{p.name}</span>
                      </div>
                    </td>
                    <td className="n">{p.prs}</td>
                    <td className="n">{nf(p.commits)}</td>
                    <td className="n add">+{fmt(p.additions)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {(v.subscriptions ?? []).length > 0 && (
            <>
              <div className="card-h" style={{ paddingTop: 10 }}>
                <div>
                  <h2>Subscriptions</h2>
                </div>
              </div>
              <div className="table-scroll">
                <table className="lb">
                  <thead>
                    <tr>
                      <th>Subscription</th>
                      <th className="n">Tokens</th>
                      <th className="n">Cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(v.subscriptions ?? []).map((s, i) => (
                      <tr key={i}>
                        <td>
                          <div className="who">
                            <AgentIcon agent={s.agent} />
                            <span className="nm">
                              {AGENT_LABEL[s.agent]} <span className="muted">{s.label}</span>
                            </span>
                          </div>
                        </td>
                        <td className="n">{fmt(s.tokens)}</td>
                        <td className="n">
                          {s.cost === null ? (
                            <span className="pill plan">plan</span>
                          ) : (
                            `$${s.cost.toFixed(2)}`
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      </div>
    </>
  );
}
