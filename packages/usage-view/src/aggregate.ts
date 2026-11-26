import type {
  AgentId,
  DailyStats,
  FeedItem,
  GanttDayStats,
  Hero,
  Kpis,
  LaneStats,
  ProviderId,
  ProviderStats,
  RangeId,
  SessionStats,
  SplitValues,
  Streaks,
  SubscriptionRow,
  BoxRow,
  ProjectRow,
  UsageStats,
  WallDay,
} from './schema.js';
import { LIMITS } from './schema.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export const DEFAULT_IDLE_GAP_MS = 10 * MIN;
export const DEFAULT_TAIL_MS = 1 * MIN;

/** Half-open `[start, end)` in epoch ms. */
export interface Span {
  start: number;
  end: number;
}

/** One agent session's turn timestamps, as the hub's history store records them. */
export interface SessionTurns {
  sessionId: string;
  /** Null for a host session (an agent on the PC, no box). */
  boxId: string | null;
  agent: AgentId;
  provider: ProviderId;
  managerId?: string | null;
  /** Epoch ms of each turn, any order. */
  turns: number[];
}

export interface BoxInfo {
  boxId: string;
  name: string;
  project?: string | null;
  agent: AgentId;
  provider: ProviderId;
  managerId?: string | null;
}

export interface PushEvent {
  type: 'git.push';
  at: number;
  boxId?: string | null;
  project?: string | null;
  commits: number;
  files: number;
  additions: number;
  deletions: number;
}

export interface PrMergedEvent {
  type: 'pr.merged';
  at: number;
  boxId?: string | null;
  project?: string | null;
  repo?: string;
  number?: number;
  title?: string;
  additions?: number;
  deletions?: number;
}

export type ActivityEvent = PushEvent | PrMergedEvent;

export interface TokenRow {
  at: number;
  agent: AgentId;
  provider: ProviderId;
  project?: string | null;
  boxId?: string | null;
  tokens: number;
}

/** A box's running time from the lifecycle ledger (start to stop/destroy). */
export interface BoxRun {
  boxId: string;
  provider: ProviderId;
  start: number;
  end: number;
}

export interface IntervalOptions {
  /** A gap between turns longer than this ends the interval. Default 10 min. */
  idleGapMs?: number;
  /** How long an interval stays open after its last turn. Default 1 min. */
  tailMs?: number;
}

// ---------------------------------------------------------------------------
// Intervals

/** Active intervals of one session: runs of turns with no gap over `idleGapMs`. */
export function activeIntervals(turns: readonly number[], opts: IntervalOptions = {}): Span[] {
  const gap = opts.idleGapMs ?? DEFAULT_IDLE_GAP_MS;
  const tail = opts.tailMs ?? DEFAULT_TAIL_MS;
  const sorted = turns.filter((t) => Number.isFinite(t)).sort((a, b) => a - b);
  const out: Span[] = [];
  let start: number | null = null;
  let last = 0;
  for (const t of sorted) {
    if (start === null) {
      start = t;
    } else if (t - last > gap) {
      out.push({ start, end: last + tail });
      start = t;
    }
    last = t;
  }
  if (start !== null) out.push({ start, end: last + tail });
  return out;
}

/** Merge overlapping or touching spans into a sorted, disjoint list. */
export function unionSpans(spans: readonly Span[]): Span[] {
  const sorted = spans.filter((s) => s.end > s.start).sort((a, b) => a.start - b.start);
  const out: Span[] = [];
  for (const s of sorted) {
    const prev = out[out.length - 1];
    if (prev && s.start <= prev.end) prev.end = Math.max(prev.end, s.end);
    else out.push({ start: s.start, end: s.end });
  }
  return out;
}

export function totalMs(spans: readonly Span[]): number {
  return spans.reduce((a, s) => a + Math.max(0, s.end - s.start), 0);
}

export function clipSpans(spans: readonly Span[], from: number, to: number): Span[] {
  const out: Span[] = [];
  for (const s of spans) {
    const start = Math.max(s.start, from);
    const end = Math.min(s.end, to);
    if (end > start) out.push({ start, end });
  }
  return out;
}

/** Step function of how many spans are open, as disjoint segments with n > 0. */
export function overlapProfile(
  spans: readonly Span[],
): { start: number; end: number; n: number }[] {
  const edges: [number, number][] = [];
  for (const s of spans) {
    if (s.end <= s.start) continue;
    edges.push([s.start, 1], [s.end, -1]);
  }
  // At equal times close before open, so back-to-back spans never count as overlapping.
  edges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out: { start: number; end: number; n: number }[] = [];
  let n = 0;
  let prevT = 0;
  for (const [t, d] of edges) {
    if (n > 0 && t > prevT) out.push({ start: prevT, end: t, n });
    n += d;
    prevT = t;
  }
  return out;
}

export function peakOverlap(spans: readonly Span[]): { peak: number; at: number | null } {
  let peak = 0;
  let at: number | null = null;
  for (const seg of overlapProfile(spans)) {
    if (seg.n > peak) {
      peak = seg.n;
      at = seg.start;
    }
  }
  return { peak, at };
}

/** Time during which at least `k` spans are open. */
export function timeAtLeast(spans: readonly Span[], k: number): number {
  return overlapProfile(spans).reduce((a, s) => (s.n >= k ? a + s.end - s.start : a), 0);
}

// ---------------------------------------------------------------------------
// Days and time zones

/** Local `YYYY-MM-DD` of an instant, for a zone `tzOffset` minutes ahead of UTC. */
export function dayKey(ms: number, tzOffset: number): string {
  return new Date(ms + tzOffset * MIN).toISOString().slice(0, 10);
}

/** Epoch ms of local midnight starting `day`. */
export function dayStart(day: string, tzOffset: number): number {
  return Date.parse(`${day}T00:00:00Z`) - tzOffset * MIN;
}

export function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
}

/** 0 = Sunday. */
export function weekday(day: string): number {
  return new Date(`${day}T00:00:00Z`).getUTCDay();
}

export function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

/** Split spans at local midnights. */
export function spansByDay(spans: readonly Span[], tzOffset: number): Map<string, Span[]> {
  const out = new Map<string, Span[]>();
  for (const s of spans) {
    let start = s.start;
    while (start < s.end) {
      const key = dayKey(start, tzOffset);
      const next = dayStart(addDays(key, 1), tzOffset);
      const end = Math.min(s.end, next);
      const list = out.get(key) ?? [];
      list.push({ start, end });
      out.set(key, list);
      start = end;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Lanes: one per box (host sessions: one per session)

export interface Lane {
  key: string;
  boxId: string | null;
  agent: AgentId;
  provider: ProviderId;
  managerId: string | null;
  spans: Span[];
}

/**
 * The active time of each box, as the union of its sessions' intervals: two sessions in
 * one box at once are one box at once, and one agent-hour.
 */
export function lanesFromSessions(
  sessions: readonly SessionTurns[],
  opts: IntervalOptions = {},
): Lane[] {
  const byKey = new Map<string, Lane>();
  for (const s of sessions) {
    const key = s.boxId ?? `session:${s.sessionId}`;
    const lane = byKey.get(key) ?? {
      key,
      boxId: s.boxId,
      agent: s.agent,
      provider: s.provider,
      managerId: s.managerId ?? null,
      spans: [],
    };
    if (!lane.managerId && s.managerId) lane.managerId = s.managerId;
    lane.spans.push(...activeIntervals(s.turns, opts));
    byKey.set(key, lane);
  }
  for (const lane of byKey.values()) lane.spans = unionSpans(lane.spans);
  return [...byKey.values()].filter((l) => l.spans.length > 0);
}

export interface ConcurrencySummary {
  agentMs: number;
  wallMs: number;
  peak: number;
  peakAt: number | null;
  /** Time with two or more lanes active. */
  parallelMs: number;
}

export function concurrency(
  lanes: readonly Lane[],
  from = -Infinity,
  to = Infinity,
): ConcurrencySummary {
  const spans = lanes.flatMap((l) => clipSpans(l.spans, from, to));
  const { peak, at } = peakOverlap(spans);
  return {
    agentMs: totalMs(spans),
    wallMs: totalMs(unionSpans(spans)),
    peak,
    peakAt: at,
    parallelMs: timeAtLeast(spans, 2),
  };
}

export interface DayConcurrency {
  agentHours: number;
  wallHours: number;
  peak: number;
  avgAtOnce: number;
}

export function concurrencyByDay(
  lanes: readonly Lane[],
  tzOffset: number,
): Map<string, DayConcurrency> {
  const out = new Map<string, DayConcurrency>();
  const days = new Set<string>();
  for (const l of lanes) for (const k of spansByDay(l.spans, tzOffset).keys()) days.add(k);
  for (const d of days) {
    const c = concurrency(lanes, dayStart(d, tzOffset), dayStart(addDays(d, 1), tzOffset));
    out.set(d, {
      agentHours: c.agentMs / HOUR,
      wallHours: c.wallMs / HOUR,
      peak: c.peak,
      avgAtOnce: c.wallMs > 0 ? c.agentMs / c.wallMs : 0,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Sessions

export interface SessionGroup {
  /** `manager:<id>`, or `overlap:<first start>` for boxes with no manager. */
  key: string;
  managerId: string | null;
  lanes: Lane[];
}

/**
 * Boxes of one manager session group together. Boxes with no manager group by
 * connected overlap: two lanes join when any of their intervals overlap, transitively.
 */
export function groupSessions(lanes: readonly Lane[]): SessionGroup[] {
  const groups: SessionGroup[] = [];
  const byManager = new Map<string, Lane[]>();
  const loose: Lane[] = [];
  for (const l of lanes) {
    if (l.managerId) byManager.set(l.managerId, [...(byManager.get(l.managerId) ?? []), l]);
    else loose.push(l);
  }
  for (const [managerId, ls] of byManager)
    groups.push({ key: `manager:${managerId}`, managerId, lanes: ls });

  // Sweep every loose span by start; a span that starts before the running end of the
  // current component joins it, so union-find over lanes stays O(n log n).
  const parent = loose.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]!]!;
      i = parent[i]!;
    }
    return i;
  };
  const spans = loose.flatMap((l, i) => l.spans.map((s) => ({ ...s, i })));
  spans.sort((a, b) => a.start - b.start);
  let curEnd = -Infinity;
  let curLane = -1;
  for (const s of spans) {
    if (curLane >= 0 && s.start < curEnd) {
      parent[find(s.i)] = find(curLane);
      curEnd = Math.max(curEnd, s.end);
    } else {
      curEnd = s.end;
      curLane = s.i;
    }
  }
  const comps = new Map<number, Lane[]>();
  loose.forEach((l, i) => {
    const r = find(i);
    comps.set(r, [...(comps.get(r) ?? []), l]);
  });
  for (const ls of comps.values()) {
    const first = Math.min(...ls.map((l) => l.spans[0]!.start));
    groups.push({ key: `overlap:${first}`, managerId: null, lanes: ls });
  }
  return groups;
}

function mostCommon<T>(items: readonly T[]): T | undefined {
  const counts = new Map<T, number>();
  let best: T | undefined;
  let bestN = 0;
  for (const it of items) {
    const n = (counts.get(it) ?? 0) + 1;
    counts.set(it, n);
    if (n > bestN) {
      best = it;
      bestN = n;
    }
  }
  return best;
}

export interface SessionSummary {
  key: string;
  managerId: string | null;
  agent: AgentId;
  provider: ProviderId;
  boxes: number;
  peak: number;
  prsMerged: number;
  minutes: number;
  start: number;
  boxIds: string[];
}

export function summarizeSessions(
  groups: readonly SessionGroup[],
  events: readonly ActivityEvent[],
): SessionSummary[] {
  const prsByBox = new Map<string, number>();
  for (const e of events) {
    if (e.type === 'pr.merged' && e.boxId) prsByBox.set(e.boxId, (prsByBox.get(e.boxId) ?? 0) + 1);
  }
  return groups
    .map((g) => {
      const spans = g.lanes.flatMap((l) => l.spans);
      const boxIds = g.lanes.flatMap((l) => (l.boxId ? [l.boxId] : []));
      return {
        key: g.key,
        managerId: g.managerId,
        agent: mostCommon(g.lanes.map((l) => l.agent)) ?? 'other',
        provider: mostCommon(g.lanes.map((l) => l.provider)) ?? 'other',
        boxes: g.lanes.length,
        peak: peakOverlap(spans).peak,
        prsMerged: boxIds.reduce((a, id) => a + (prsByBox.get(id) ?? 0), 0),
        minutes: totalMs(unionSpans(spans)) / MIN,
        start: Math.min(...spans.map((s) => s.start)),
        boxIds,
      };
    })
    .sort(
      (a, b) =>
        b.boxes - a.boxes || b.prsMerged - a.prsMerged || b.peak - a.peak || a.start - b.start,
    );
}

// ---------------------------------------------------------------------------
// Shipped and streaks

export interface ShippedDay {
  commits: number;
  files: number;
  additions: number;
  deletions: number;
  prsMerged: number;
}

const emptyShipped = (): ShippedDay => ({
  commits: 0,
  files: 0,
  additions: 0,
  deletions: 0,
  prsMerged: 0,
});

/**
 * Lines and files come from pushes, not from merged PRs: a PR's lines were already
 * pushed, so counting both would double them.
 */
export function shippedByDay(
  events: readonly ActivityEvent[],
  tzOffset: number,
): Map<string, ShippedDay> {
  const out = new Map<string, ShippedDay>();
  for (const e of events) {
    const key = dayKey(e.at, tzOffset);
    const d = out.get(key) ?? emptyShipped();
    if (e.type === 'git.push') {
      d.commits += e.commits;
      d.files += e.files;
      d.additions += e.additions;
      d.deletions += e.deletions;
    } else {
      d.prsMerged += 1;
    }
    out.set(key, d);
  }
  return out;
}

/** Current streak ends today, or yesterday when today has no commit yet. */
export function streaks(
  commitDays: ReadonlySet<string>,
  today: string,
): { current: number; best: number } {
  let current = 0;
  let d = commitDays.has(today) ? today : addDays(today, -1);
  while (commitDays.has(d)) {
    current++;
    d = addDays(d, -1);
  }
  let best = 0;
  let run = 0;
  let prev: string | null = null;
  for (const day of [...commitDays].sort()) {
    run = prev !== null && addDays(prev, 1) === day ? run + 1 : 1;
    best = Math.max(best, run);
    prev = day;
  }
  return { current, best };
}

// ---------------------------------------------------------------------------
// Everything: the UsageStats of a window

export interface BuildInput {
  range: { id: RangeId; since: string; until: string; today: string; tzOffset: number };
  now: number;
  /** Sessions covering the wall window (a year back from `today`), not only the range. */
  sessions: readonly SessionTurns[];
  events: readonly ActivityEvent[];
  tokens?: readonly TokenRow[];
  boxes?: readonly BoxInfo[];
  boxRuns?: readonly BoxRun[];
  subscriptions?: readonly SubscriptionRow[];
  providerNotes?: Partial<Record<ProviderId, string>>;
  /** Display titles for manager sessions, by manager id. */
  sessionTitles?: Readonly<Record<string, string>>;
  /** The previous window of the same length, for the KPI deltas. */
  previous?: { peak: number; speedup: number; prsMerged: number; boxHours: number };
  runningNow?: number;
  waitingReview?: number;
  /** Days to lay out in the Gantt; default the three busiest of the range. */
  ganttDays?: readonly string[];
  intervals?: IntervalOptions;
}

const round = (n: number, d = 2): number => Math.round(n * 10 ** d) / 10 ** d;

function addSplit<K extends string>(
  rec: Partial<Record<K, SplitValues>>,
  k: K,
  v: Partial<SplitValues>,
): void {
  const cur = rec[k] ?? { tokens: 0, agentHours: 0, commits: 0 };
  cur.tokens += v.tokens ?? 0;
  cur.agentHours += v.agentHours ?? 0;
  cur.commits += v.commits ?? 0;
  rec[k] = cur;
}

function roundSplits<K extends string>(
  rec: Partial<Record<K, SplitValues>>,
): Partial<Record<K, SplitValues>> {
  for (const k of Object.keys(rec) as K[]) {
    const v = rec[k]!;
    rec[k] = { tokens: Math.round(v.tokens), agentHours: round(v.agentHours), commits: v.commits };
  }
  return rec;
}

export function buildUsageStats(input: BuildInput): UsageStats {
  const { range } = input;
  const tz = range.tzOffset;
  const lastDay = range.today < range.until ? range.today : range.until;
  const from = dayStart(range.since, tz);
  const to = dayStart(addDays(lastDay, 1), tz);
  const wallFrom = addDays(lastDay, -(LIMITS.wallDays - 1));
  const inRange = (t: number): boolean => t >= from && t < to;

  const lanes = lanesFromSessions(input.sessions, input.intervals);
  const boxInfo = new Map((input.boxes ?? []).map((b) => [b.boxId, b]));
  for (const l of lanes) {
    const info = l.boxId ? boxInfo.get(l.boxId) : undefined;
    if (info?.managerId && !l.managerId) l.managerId = info.managerId;
  }
  const rangeLanes = lanes
    .map((l) => ({ ...l, spans: clipSpans(l.spans, from, to) }))
    .filter((l) => l.spans.length > 0);
  const rangeEvents = input.events.filter((e) => inRange(e.at));
  const rangeTokens = (input.tokens ?? []).filter((t) => inRange(t.at));

  const conc = concurrency(rangeLanes);
  const byDayConc = concurrencyByDay(lanes, tz);
  const shipped = shippedByDay(input.events, tz);

  const boxRunsByDay = new Map<string, number>();
  let boxMs = 0;
  for (const r of input.boxRuns ?? []) {
    const clipped = clipSpans([{ start: r.start, end: r.end }], from, to);
    boxMs += totalMs(clipped);
    for (const [d, spans] of spansByDay(clipped, tz))
      boxRunsByDay.set(d, (boxRunsByDay.get(d) ?? 0) + totalMs(spans));
  }

  // ---- daily
  const daily: DailyStats[] = daysBetween(range.since, lastDay).map((date) => {
    const c = byDayConc.get(date);
    const s = shipped.get(date) ?? emptyShipped();
    return {
      date,
      tokens: 0,
      agentHours: round(c?.agentHours ?? 0),
      wallHours: round(c?.wallHours ?? 0),
      boxHours: round((boxRunsByDay.get(date) ?? 0) / HOUR),
      peak: c?.peak ?? 0,
      avgAtOnce: round(c?.avgAtOnce ?? 0),
      commits: s.commits,
      prsMerged: s.prsMerged,
      additions: s.additions,
      deletions: s.deletions,
      files: s.files,
      byAgent: {},
      byProvider: {},
      byProject: {},
    };
  });
  const dailyByDate = new Map(daily.map((d) => [d.date, d]));
  for (const l of rangeLanes) {
    const project = l.boxId ? boxInfo.get(l.boxId)?.project : null;
    for (const [d, spans] of spansByDay(l.spans, tz)) {
      const row = dailyByDate.get(d);
      if (!row) continue;
      const agentHours = totalMs(spans) / HOUR;
      addSplit(row.byAgent, l.agent, { agentHours });
      addSplit(row.byProvider, l.provider, { agentHours });
      if (project) addSplit(row.byProject!, project, { agentHours });
    }
  }
  for (const t of rangeTokens) {
    const row = dailyByDate.get(dayKey(t.at, tz));
    if (!row) continue;
    row.tokens += t.tokens;
    addSplit(row.byAgent, t.agent, { tokens: t.tokens });
    addSplit(row.byProvider, t.provider, { tokens: t.tokens });
    const project = t.project ?? (t.boxId ? boxInfo.get(t.boxId)?.project : null);
    if (project) addSplit(row.byProject!, project, { tokens: t.tokens });
  }
  for (const e of rangeEvents) {
    if (e.type !== 'git.push') continue;
    const row = dailyByDate.get(dayKey(e.at, tz));
    const info = e.boxId ? boxInfo.get(e.boxId) : undefined;
    if (!row) continue;
    addSplit(row.byAgent, info?.agent ?? 'other', { commits: e.commits });
    addSplit(row.byProvider, info?.provider ?? 'other', { commits: e.commits });
    const project = e.project ?? info?.project;
    if (project) addSplit(row.byProject!, project, { commits: e.commits });
  }
  for (const row of daily) {
    row.tokens = Math.round(row.tokens);
    roundSplits(row.byAgent);
    roundSplits(row.byProvider);
    roundSplits(row.byProject!);
    if (Object.keys(row.byProject!).length === 0) delete row.byProject;
  }

  // ---- wall
  const tokensByDay = new Map<string, number>();
  for (const t of input.tokens ?? []) {
    const k = dayKey(t.at, tz);
    tokensByDay.set(k, (tokensByDay.get(k) ?? 0) + t.tokens);
  }
  const wall: WallDay[] = daysBetween(wallFrom, lastDay).map((date) => {
    const s = shipped.get(date) ?? emptyShipped();
    const c = byDayConc.get(date);
    return {
      date,
      all: s.commits + s.prsMerged,
      peak: c?.peak ?? 0,
      commits: s.commits,
      prs: s.prsMerged,
      agentHours: round(c?.agentHours ?? 0),
      tokens: Math.round(tokensByDay.get(date) ?? 0),
    };
  });

  // ---- streaks
  const commitDays = new Set(wall.filter((w) => w.commits > 0).map((w) => w.date));
  const st = streaks(commitDays, lastDay);
  const activeWall = wall.filter((w) => w.all > 0 || w.agentHours > 0);
  const firstDate = activeWall[0]?.date ?? null;
  const commitsByDow = [0, 0, 0, 0, 0, 0, 0];
  for (const w of wall) commitsByDow[weekday(w.date)]! += w.commits;
  const totalCommitsWall = commitsByDow.reduce((a, b) => a + b, 0);
  const busiest = totalCommitsWall > 0 ? commitsByDow.indexOf(Math.max(...commitsByDow)) : null;
  const bestWall = wall.reduce<WallDay | null>(
    (a, w) => (w.commits > (a?.commits ?? 0) ? w : a),
    null,
  );
  const streakOut: Streaks = {
    current: st.current,
    best: st.best,
    activeDays: activeWall.length,
    daysSinceFirst: firstDate ? daysBetween(firstDate, lastDay).length : 0,
    firstDate,
    busiestWeekday: busiest,
    busiestWeekdayShare: busiest === null ? 0 : round(commitsByDow[busiest]! / totalCommitsWall, 3),
    bestDay: bestWall ? { date: bestWall.date, commits: bestWall.commits } : null,
  };

  // ---- sessions
  const sessionSummaries = summarizeSessions(groupSessions(rangeLanes), rangeEvents);
  const sessions: SessionStats[] = sessionSummaries.slice(0, 5).map((s) => {
    const projects = s.boxIds.map((id) => boxInfo.get(id)?.project).filter((p): p is string => !!p);
    const title =
      (s.managerId && input.sessionTitles?.[s.managerId]) ||
      `${s.boxes} ${s.boxes === 1 ? 'box' : 'boxes'}, ${dayKey(s.start, tz)}`;
    return {
      agent: s.agent,
      provider: s.provider,
      boxes: s.boxes,
      peak: s.peak,
      prsMerged: s.prsMerged,
      minutes: Math.round(s.minutes),
      title: title.slice(0, LIMITS.name),
      project: mostCommon(projects) ?? null,
    };
  });

  // ---- gantt
  const ganttDates =
    input.ganttDays ??
    [...daily]
      .filter((d) => d.peak > 0)
      .sort((a, b) => b.peak - a.peak || b.agentHours - a.agentHours)
      .slice(0, 3)
      .map((d) => d.date);
  const mergedAt = new Map<string, PrMergedEvent>();
  for (const e of input.events) if (e.type === 'pr.merged' && e.boxId) mergedAt.set(e.boxId, e);
  const gantt: GanttDayStats[] = ganttDates.slice(0, LIMITS.ganttDays).map((date) => {
    const d0 = dayStart(date, tz);
    const laneRows: LaneStats[] = [];
    for (const l of lanes) {
      // A lane belongs to the day it starts in; one that runs past midnight keeps going (up to 48 h).
      const spans = clipSpans(l.spans, d0, d0 + 2 * DAY).filter((s) => s.start < d0 + DAY);
      if (spans.length === 0) continue;
      const info = l.boxId ? boxInfo.get(l.boxId) : undefined;
      const pr = l.boxId ? mergedAt.get(l.boxId) : undefined;
      const lastEnd = spans[spans.length - 1]!.end;
      const prOnDay = pr && pr.at >= d0 && pr.at <= lastEnd + HOUR;
      laneRows.push({
        agent: l.agent,
        provider: l.provider,
        intervals: spans
          .slice(0, LIMITS.intervalsPerLane)
          .map(
            (s) =>
              [round((s.start - d0) / HOUR, 3), round((s.end - d0) / HOUR, 3)] as [number, number],
          ),
        box: (info?.name ?? l.key).slice(0, LIMITS.name),
        pr: prOnDay && pr.repo && pr.number ? `${pr.repo}#${pr.number}` : null,
      });
    }
    laneRows.sort((a, b) => a.intervals[0]![0] - b.intervals[0]![0]);
    return { date, lanes: laneRows.slice(0, LIMITS.lanes) };
  });

  // ---- punchcard
  const punchcard = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));
  for (const l of rangeLanes) {
    for (const s of l.spans) {
      let t = s.start;
      while (t < s.end) {
        const local = new Date(t + tz * MIN);
        const hourEnd =
          t +
          (HOUR -
            (local.getUTCMinutes() * MIN +
              local.getUTCSeconds() * 1000 +
              local.getUTCMilliseconds()));
        const end = Math.min(s.end, hourEnd);
        punchcard[local.getUTCDay()]![local.getUTCHours()]! += (end - t) / HOUR;
        t = end;
      }
    }
  }

  // ---- providers
  const provHours = new Map<ProviderId, { hours: number; boxes: Set<string> }>();
  for (const l of rangeLanes) {
    const p = provHours.get(l.provider) ?? { hours: 0, boxes: new Set<string>() };
    p.hours += totalMs(l.spans) / HOUR;
    p.boxes.add(l.key);
    provHours.set(l.provider, p);
  }
  const providers: ProviderStats[] = [...provHours]
    .map(([id, p]) => ({
      id,
      hours: round(p.hours, 1),
      boxes: p.boxes.size,
      note: input.providerNotes?.[id] ?? null,
    }))
    .sort((a, b) => b.hours - a.hours);

  // ---- feed, boxes, projects
  const merged = rangeEvents.filter((e): e is PrMergedEvent => e.type === 'pr.merged');
  const feed: FeedItem[] = merged
    .filter((e) => e.title && e.repo && e.number)
    .sort((a, b) => b.at - a.at)
    .slice(0, 6)
    .map((e) => {
      const info = e.boxId ? boxInfo.get(e.boxId) : undefined;
      return {
        title: e.title!.slice(0, LIMITS.name),
        repo: e.repo!,
        number: e.number!,
        box: info?.name ?? 'unknown',
        agent: info?.agent ?? 'other',
        provider: info?.provider ?? 'other',
        additions: e.additions ?? 0,
        deletions: e.deletions ?? 0,
        mergedAt: new Date(e.at).toISOString(),
      };
    });

  const boxAgg = new Map<string, BoxRow>();
  const boxRow = (boxId: string): BoxRow | null => {
    const info = boxInfo.get(boxId);
    if (!info) return null;
    let r = boxAgg.get(boxId);
    if (!r) {
      r = {
        name: info.name.slice(0, LIMITS.name),
        project: info.project ?? null,
        agent: info.agent,
        provider: info.provider,
        hours: 0,
        tokens: 0,
        prs: 0,
        additions: 0,
        deletions: 0,
      };
      boxAgg.set(boxId, r);
    }
    return r;
  };
  for (const l of rangeLanes)
    if (l.boxId) {
      const r = boxRow(l.boxId);
      if (r) r.hours += totalMs(l.spans) / HOUR;
    }
  for (const t of rangeTokens)
    if (t.boxId) {
      const r = boxRow(t.boxId);
      if (r) r.tokens += t.tokens;
    }
  const projAgg = new Map<string, ProjectRow>();
  const projRow = (name: string): ProjectRow => {
    const p = projAgg.get(name) ?? {
      name: name.slice(0, LIMITS.name),
      prs: 0,
      commits: 0,
      additions: 0,
    };
    projAgg.set(name, p);
    return p;
  };
  for (const e of rangeEvents) {
    const r = e.boxId ? boxRow(e.boxId) : null;
    const project = e.project ?? (e.boxId ? boxInfo.get(e.boxId)?.project : null);
    if (e.type === 'git.push') {
      if (r) {
        r.additions += e.additions;
        r.deletions += e.deletions;
      }
      if (project) {
        const p = projRow(project);
        p.commits += e.commits;
        p.additions += e.additions;
      }
    } else {
      if (r) r.prs += 1;
      if (project) projRow(project).prs += 1;
    }
  }
  const boxes = [...boxAgg.values()]
    .map((b) => ({ ...b, hours: round(b.hours, 1), tokens: Math.round(b.tokens) }))
    .sort((a, b) => b.additions + b.deletions - (a.additions + a.deletions) || b.hours - a.hours)
    .slice(0, 6);
  const projects = [...projAgg.values()]
    .sort((a, b) => b.prs - a.prs || b.commits - a.commits)
    .slice(0, 6);

  // ---- hero and KPIs
  const tot = daily.reduce(
    (a, d) => ({
      prs: a.prs + d.prsMerged,
      commits: a.commits + d.commits,
      additions: a.additions + d.additions,
      deletions: a.deletions + d.deletions,
      files: a.files + d.files,
      tokens: a.tokens + d.tokens,
    }),
    { prs: 0, commits: 0, additions: 0, deletions: 0, files: 0, tokens: 0 },
  );
  const distinctBoxes = new Set([
    ...rangeLanes.flatMap((l) => (l.boxId ? [l.boxId] : [])),
    ...(input.boxRuns ?? []).filter((r) => r.end > from && r.start < to).map((r) => r.boxId),
  ]);
  const speedup = conc.wallMs > 0 ? conc.agentMs / conc.wallMs : 0;
  const hero: Hero = {
    agentHours: round(conc.agentMs / HOUR, 1),
    wallHours: round(conc.wallMs / HOUR, 1),
    speedup: round(speedup, 2),
    peakAtOnce: conc.peak,
    peakDate: conc.peakAt === null ? null : dayKey(conc.peakAt, tz),
    parallelHours: round(conc.parallelMs / HOUR, 1),
    maxPrsInSession: Math.max(0, ...sessionSummaries.map((s) => s.prsMerged)),
    sessionsWith3Plus: sessionSummaries.filter((s) => s.boxes >= 3).length,
    streakDays: st.current,
    prsMerged: tot.prs,
    commits: tot.commits,
    additions: tot.additions,
    deletions: tot.deletions,
    files: tot.files,
    boxes: distinctBoxes.size,
    bestDayPrs: Math.max(0, ...daily.map((d) => d.prsMerged)),
    bestDayCommits: Math.max(0, ...daily.map((d) => d.commits)),
    biggestPrAdditions: Math.max(0, ...merged.map((e) => e.additions ?? 0)),
  };
  const boxHours = round(boxMs / HOUR, 1);
  const prev = input.previous;
  const kpis: Kpis = {
    peak: {
      value: conc.peak,
      delta: prev ? conc.peak - prev.peak : null,
      runningNow: input.runningNow ?? 0,
    },
    speedup: { value: hero.speedup, delta: prev ? round(hero.speedup - prev.speedup, 2) : null },
    prs: {
      value: tot.prs,
      delta: prev ? tot.prs - prev.prsMerged : null,
      waitingReview: input.waitingReview ?? 0,
    },
    boxHours: {
      value: boxHours,
      deltaPct:
        prev && prev.boxHours > 0
          ? round(((boxHours - prev.boxHours) / prev.boxHours) * 100, 0)
          : null,
      boxes: distinctBoxes.size,
      tokens: tot.tokens,
    },
  };

  return {
    version: 1,
    generatedAt: new Date(input.now).toISOString(),
    range: { ...range },
    hero,
    kpis,
    daily,
    wall,
    streaks: streakOut,
    gantt,
    sessions,
    punchcard: punchcard.map((row) => row.map((h) => round(h))),
    providers,
    feed,
    feedTotal: merged.length,
    boxes,
    projects,
    subscriptions: [...(input.subscriptions ?? [])],
  };
}
