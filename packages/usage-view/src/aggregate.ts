import type {
  AgentId,
  DailyStats,
  FeedItem,
  GanttDayStats,
  Hero,
  StatsKpis,
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
  /** Epoch ms of each turn, any order. Ignored when `spans` is given. */
  turns: number[];
  /**
   * The session's active intervals, already cut at the idle gap (a store that
   * computes them in SQL sends these instead of every turn).
   */
  spans?: Span[];
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

const offsetFormats = new Map<string, Intl.DateTimeFormat>();
const offsetCache = new Map<string, Map<number, number>>();
/** Offsets in use change on a quarter hour (UTC), so one lookup covers a quarter. */
const QUARTER = 15 * MIN;

/**
 * Local time minus UTC, in ms, of zone `tz` at instant `ms`. `Intl` is slow next to the
 * arithmetic around it, so each quarter hour is looked up once per zone.
 */
export function zoneOffset(ms: number, tz: string): number {
  let cache = offsetCache.get(tz);
  if (!cache) {
    cache = new Map();
    offsetCache.set(tz, cache);
  }
  const q = Math.floor(ms / QUARTER);
  const hit = cache.get(q);
  if (hit !== undefined) return hit;
  let fmt = offsetFormats.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    offsetFormats.set(tz, fmt);
  }
  const at = q * QUARTER;
  const p: Record<string, number> = {};
  for (const part of fmt.formatToParts(at)) {
    if (part.type !== 'literal') p[part.type] = Number(part.value);
  }
  const local = Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!);
  const off = Math.round((local - at) / MIN) * MIN;
  if (cache.size > 200_000) cache.clear();
  cache.set(q, off);
  return off;
}

/** From `fromMs` on (until the next segment), local time is UTC plus `offsetMs`. */
export interface ZoneSegment {
  fromMs: number;
  offsetMs: number;
}

/**
 * The offsets zone `tz` uses over `[fromMs, toMs)`, one segment per change: lets a
 * store bucket rows into local days in SQL (`(ts + offset) / day`), with no zone
 * support of its own. A year is a handful of segments.
 */
export function zoneSegments(fromMs: number, toMs: number, tz: string): ZoneSegment[] {
  const out: ZoneSegment[] = [{ fromMs, offsetMs: zoneOffset(fromMs, tz) }];
  // Zones change at most a few times a year, never twice in a day: probe daily, then
  // narrow each change down to its quarter hour.
  for (let t = fromMs + DAY; t < toMs + DAY; t += DAY) {
    const last = out[out.length - 1]!;
    const end = Math.min(t, toMs);
    if (end <= last.fromMs || zoneOffset(end, tz) === last.offsetMs) continue;
    // Quarter indices: `lo` still has the old offset, `hi` the new one.
    let lo = Math.floor(Math.max(t - DAY, last.fromMs) / QUARTER);
    let hi = Math.floor(end / QUARTER);
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      if (zoneOffset(mid * QUARTER, tz) === last.offsetMs) lo = mid;
      else hi = mid;
    }
    out.push({ fromMs: hi * QUARTER, offsetMs: zoneOffset(hi * QUARTER, tz) });
  }
  return out;
}

/** Local `YYYY-MM-DD` of an instant in zone `tz`. */
export function dayKey(ms: number, tz: string): string {
  return new Date(ms + zoneOffset(ms, tz)).toISOString().slice(0, 10);
}

/**
 * Epoch ms of the local midnight starting `day` in zone `tz`. A day with no midnight (a
 * DST change at 00:00) starts at the first local instant it has.
 */
export function dayStart(day: string, tz: string): number {
  const utcMidnight = Date.parse(`${day}T00:00:00Z`);
  // The offset before midnight, then the one at the candidate: two steps settle it
  // whichever side of a DST change midnight falls on.
  let t = utcMidnight - zoneOffset(utcMidnight - DAY / 2, tz);
  t = utcMidnight - zoneOffset(t, tz);
  if (dayKey(t, tz) < day) t += HOUR;
  return t;
}

export function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
}

/** 0 = Sunday. */
export function weekday(day: string): number {
  return new Date(`${day}T00:00:00Z`).getUTCDay();
}

/** Longest run `daysBetween` will build; well past any window the schema allows. */
export const MAX_DAYS_BETWEEN = 4000;

/** Every day from `from` to `to`, inclusive. Throws past MAX_DAYS_BETWEEN days. */
export function daysBetween(from: string, to: string): string[] {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) throw new RangeError(`bad day: ${from}..${to}`);
  const n = Math.round((b - a) / DAY) + 1;
  if (n <= 0) return [];
  if (n > MAX_DAYS_BETWEEN) throw new RangeError(`${from}..${to} spans ${n} days`);
  return Array.from({ length: n }, (_, i) => new Date(a + i * DAY).toISOString().slice(0, 10));
}

/** Math.min/max without spreading: a spread of a few hundred thousand values overflows the stack. */
export function minOf(xs: Iterable<number>, empty = Infinity): number {
  let m = empty;
  for (const x of xs) if (x < m) m = x;
  return m;
}

export function maxOf(xs: Iterable<number>, empty = -Infinity): number {
  let m = empty;
  for (const x of xs) if (x > m) m = x;
  return m;
}

/** Split spans at local midnights. */
export function spansByDay(spans: readonly Span[], tz: string): Map<string, Span[]> {
  const out = new Map<string, Span[]>();
  for (const s of spans) {
    let start = s.start;
    while (start < s.end) {
      const key = dayKey(start, tz);
      const next = dayStart(addDays(key, 1), tz);
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
    for (const sp of s.spans ?? activeIntervals(s.turns, opts)) lane.spans.push(sp);
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

export function concurrencyByDay(lanes: readonly Lane[], tz: string): Map<string, DayConcurrency> {
  // One profile over every span, its segments split at local midnights: the same numbers as
  // clipping per day, in one pass.
  const acc = new Map<string, { agentMs: number; wallMs: number; peak: number }>();
  for (const seg of overlapProfile(lanes.flatMap((l) => l.spans))) {
    for (const [d, parts] of spansByDay([seg], tz)) {
      const a = acc.get(d) ?? { agentMs: 0, wallMs: 0, peak: 0 };
      const ms = totalMs(parts);
      a.agentMs += ms * seg.n;
      a.wallMs += ms;
      a.peak = Math.max(a.peak, seg.n);
      acc.set(d, a);
    }
  }
  const out = new Map<string, DayConcurrency>();
  for (const [d, a] of acc) {
    out.set(d, {
      agentHours: a.agentMs / HOUR,
      wallHours: a.wallMs / HOUR,
      peak: a.peak,
      avgAtOnce: a.wallMs > 0 ? a.agentMs / a.wallMs : 0,
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
    const first = minOf(ls.map((l) => l.spans[0]!.start));
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
        start: minOf(spans.map((s) => s.start)),
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
  tz: string,
): Map<string, ShippedDay> {
  const out = new Map<string, ShippedDay>();
  for (const e of events) {
    const key = dayKey(e.at, tz);
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
  range: { id: RangeId; since: string; until: string; today: string; tz: string };
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
  previous?: {
    peak: number;
    speedup: number;
    hoursSaved: number;
    prsMerged: number;
    boxHours: number;
  };
  runningNow?: number;
  waitingReview?: number;
  /** Days to lay out in the Gantt; default the three busiest of the range. */
  ganttDays?: readonly string[];
  intervals?: IntervalOptions;
}

/** Fit a display name into the schema's 1..LIMITS.name characters. */
const clip = (s: string | null | undefined, fallback = 'unknown'): string =>
  (s && s.trim() ? s : fallback).slice(0, LIMITS.name);
const clipOrNull = (s: string | null | undefined): string | null =>
  s && s.trim() ? clip(s) : null;

const round = (n: number, d = 2): number => Math.round(n * 10 ** d) / 10 ** d;

/**
 * Hours saved by running agents in parallel: how long the agent work would have taken
 * one agent at a time (`agentHours`) minus how long it took on the clock (`wallHours`),
 * to 0.1 h. Machine time against a serial run, not a person's time.
 */
export function hoursSaved(h: { agentHours: number; wallHours: number }): number {
  return Math.max(0, round(h.agentHours - h.wallHours, 1));
}

/** Below this there is no speed-up worth claiming: one agent at a time, near enough. */
export const MIN_SPEEDUP = 1.1;

/** Hours saved worth stating in words: a real speed-up and at least an hour. */
export const claimsHoursSaved = (h: {
  agentHours: number;
  wallHours: number;
  speedup: number;
}): boolean => h.speedup >= MIN_SPEEDUP && hoursSaved(h) >= 1;

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
  const tz = range.tz;
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
      if (project) addSplit(row.byProject!, clip(project), { agentHours });
    }
  }
  for (const t of rangeTokens) {
    const row = dailyByDate.get(dayKey(t.at, tz));
    if (!row) continue;
    row.tokens += t.tokens;
    addSplit(row.byAgent, t.agent, { tokens: t.tokens });
    addSplit(row.byProvider, t.provider, { tokens: t.tokens });
    const project = t.project ?? (t.boxId ? boxInfo.get(t.boxId)?.project : null);
    if (project) addSplit(row.byProject!, clip(project), { tokens: t.tokens });
  }
  for (const e of rangeEvents) {
    if (e.type !== 'git.push') continue;
    const row = dailyByDate.get(dayKey(e.at, tz));
    const info = e.boxId ? boxInfo.get(e.boxId) : undefined;
    if (!row) continue;
    addSplit(row.byAgent, info?.agent ?? 'other', { commits: e.commits });
    addSplit(row.byProvider, info?.provider ?? 'other', { commits: e.commits });
    const project = e.project ?? info?.project;
    if (project) addSplit(row.byProject!, clip(project), { commits: e.commits });
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
  const busiest = totalCommitsWall > 0 ? commitsByDow.indexOf(maxOf(commitsByDow)) : null;
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
      title: clip(title),
      project: clipOrNull(mostCommon(projects)),
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
  const mergesByBox = new Map<string, PrMergedEvent[]>();
  for (const e of input.events) {
    if (e.type !== 'pr.merged' || !e.boxId) continue;
    mergesByBox.set(e.boxId, [...(mergesByBox.get(e.boxId) ?? []), e]);
  }
  const gantt: GanttDayStats[] = ganttDates.slice(0, LIMITS.ganttDays).map((date) => {
    const d0 = dayStart(date, tz);
    // Day ends from the zone, not d0 + 24 h: a DST day is 23 or 25 hours long.
    const d1 = dayStart(addDays(date, 1), tz);
    const d2 = dayStart(addDays(date, 2), tz);
    // Lane hours are the local clock's (hours since local midnight on the wall), so a
    // 14:00 interval reads 14 on a DST day too; never running backwards in the repeated hour.
    const clock0 = d0 + zoneOffset(d0, tz);
    const clockHour = (t: number): number => (t + zoneOffset(t, tz) - clock0) / HOUR;
    const laneRows: LaneStats[] = [];
    for (const l of lanes) {
      // An interval belongs to the day it starts in, and keeps going past midnight (up to
      // the end of the next day). One that started the evening before is that day's.
      const spans = clipSpans(
        l.spans.filter((s) => s.start >= d0 && s.start < d1),
        d0,
        d2,
      );
      if (spans.length === 0) continue;
      const info = l.boxId ? boxInfo.get(l.boxId) : undefined;
      const lastEnd = spans[spans.length - 1]!.end;
      // The last PR the box merged while this lane ran (or within the hour after it).
      const pr = (l.boxId ? (mergesByBox.get(l.boxId) ?? []) : [])
        .filter((e) => e.at >= d0 && e.at <= lastEnd + HOUR)
        .sort((a, b) => b.at - a.at)[0];
      laneRows.push({
        agent: l.agent,
        provider: l.provider,
        intervals: spans.slice(0, LIMITS.intervalsPerLane).map((s) => {
          const a = Math.min(Math.max(round(clockHour(s.start), 3), 0), 48);
          const b = Math.min(Math.max(round(clockHour(s.end), 3), a), 48);
          return [a, b] as [number, number];
        }),
        box: clip(info?.name ?? l.key),
        pr: pr ? clip(pr.repo && pr.number ? `${pr.repo}#${pr.number}` : 'a pull request') : null,
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
        const local = new Date(t + zoneOffset(t, tz));
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
      note: clipOrNull(input.providerNotes?.[id]),
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
        title: clip(e.title),
        repo: clip(e.repo),
        number: e.number!,
        box: clip(info?.name),
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
        name: clip(info.name),
        project: clipOrNull(info.project),
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
      name: clip(name),
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
  const allBoxes = [...boxAgg.values()]
    .map((b) => ({ ...b, hours: round(b.hours, 1), tokens: Math.round(b.tokens) }))
    .sort((a, b) => b.additions + b.deletions - (a.additions + a.deletions) || b.hours - a.hours);
  // Keep the top boxes by each leaderboard metric, so every tab ranks the right ones.
  const keep = new Set(
    (['lines', 'hours', 'tokens'] as const).flatMap((m) =>
      [...allBoxes]
        .sort((a, b) =>
          m === 'lines' ? b.additions + b.deletions - (a.additions + a.deletions) : b[m] - a[m],
        )
        .slice(0, 6),
    ),
  );
  const boxes = allBoxes.filter((b) => keep.has(b)).slice(0, LIMITS.boxes);
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
    maxPrsInSession: maxOf(
      sessionSummaries.map((s) => s.prsMerged),
      0,
    ),
    sessionsWith3Plus: sessionSummaries.filter((s) => s.boxes >= 3).length,
    streakDays: st.current,
    prsMerged: tot.prs,
    commits: tot.commits,
    additions: tot.additions,
    deletions: tot.deletions,
    files: tot.files,
    boxes: distinctBoxes.size,
    bestDayPrs: maxOf(
      daily.map((d) => d.prsMerged),
      0,
    ),
    bestDayCommits: maxOf(
      daily.map((d) => d.commits),
      0,
    ),
    biggestPrAdditions: maxOf(
      merged.map((e) => e.additions ?? 0),
      0,
    ),
  };
  const boxHours = round(boxMs / HOUR, 1);
  const prev = input.previous;
  const kpis: StatsKpis = {
    peak: {
      value: conc.peak,
      delta: prev ? conc.peak - prev.peak : null,
      runningNow: input.runningNow ?? 0,
    },
    speedup: { value: hero.speedup, delta: prev ? round(hero.speedup - prev.speedup, 2) : null },
    hoursSaved: {
      value: hoursSaved(hero),
      delta: prev ? round(hoursSaved(hero) - prev.hoursSaved, 1) : null,
    },
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
