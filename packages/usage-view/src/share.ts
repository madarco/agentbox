import { encodeDaily, encodeWall } from './columns.js';
import { SHARE_LIMITS, SHARE_NAME_RE, SHARE_MAX_BYTES, UsageShare } from './schema.js';
import type { DailyColumns, LaneStats, UsageStats, WallColumns } from './schema.js';

/** Clamp into [0, max] and round to one decimal: the share's precision for hours. */
const h1 = (v: number, max: number): number => Math.round(Math.min(Math.max(v, 0), max) * 10) / 10;
/** Clamp into [0, max] and round to a whole number. */
const int = (v: number, max: number): number => Math.round(Math.min(Math.max(v, 0), max));

type Split = { tokens: number[]; agentHours: number[]; commits: number[] };
const fitSplits = <K extends string>(rec: Partial<Record<K, Split>>): Partial<Record<K, Split>> => {
  const out: Partial<Record<K, Split>> = {};
  for (const k of Object.keys(rec) as K[]) {
    const v = rec[k]!;
    out[k] = {
      tokens: v.tokens.map((x) => int(x, 1e10)),
      agentHours: v.agentHours.map((x) => h1(x, 2000)),
      commits: v.commits.map((x) => int(x, 99_999)),
    };
  }
  return out;
};

function fitDaily(d: DailyColumns): DailyColumns {
  return {
    start: d.start,
    tokens: d.tokens.map((x) => int(x, 1e10)),
    agentHours: d.agentHours.map((x) => h1(x, 2000)),
    wallHours: d.wallHours.map((x) => h1(x, 2000)),
    boxHours: d.boxHours.map((x) => h1(x, 2000)),
    peak: d.peak.map((x) => int(x, 999)),
    avgAtOnce: d.avgAtOnce.map((x) => h1(x, 999)),
    commits: d.commits.map((x) => int(x, 99_999)),
    prsMerged: d.prsMerged.map((x) => int(x, 99_999)),
    additions: d.additions.map((x) => int(x, 9_999_999)),
    deletions: d.deletions.map((x) => int(x, 9_999_999)),
    files: d.files.map((x) => int(x, 99_999)),
    byAgent: fitSplits(d.byAgent),
    byProvider: fitSplits(d.byProvider),
  };
}

function fitWall(w: WallColumns): WallColumns {
  return {
    start: w.start,
    all: w.all.map((x) => int(x, 99_999)),
    peak: w.peak.map((x) => int(x, 999)),
    commits: w.commits.map((x) => int(x, 99_999)),
    prs: w.prs.map((x) => int(x, 99_999)),
    agentHours: w.agentHours.map((x) => h1(x, 2000)),
    tokens: w.tokens.map((x) => int(x, 1e10)),
  };
}

/** Merge the closest neighbours until at most `max` intervals are left. */
function fitIntervals(intervals: LaneStats['intervals'], max: number): [number, number][] {
  const out = intervals.map(([a, b]) => [h1(a, 48), h1(b, 48)] as [number, number]);
  while (out.length > max) {
    let at = 0;
    for (let i = 1; i < out.length - 1; i++) {
      if (out[i + 1]![0] - out[i]![1] < out[at + 1]![0] - out[at]![1]) at = i;
    }
    out.splice(at, 2, [out[at]![0], out[at + 1]![1]]);
  }
  return out;
}

const laneHours = (l: LaneStats): number => l.intervals.reduce((a, [s, e]) => a + e - s, 0);

/**
 * The public subset of `stats`: numbers, dates and enum ids. Box, project, branch,
 * PR and session names stay behind; lanes and sessions keep only agent + provider.
 * Numbers are rounded and clamped to the share's bounds and arrays cut to its limits,
 * so the result always parses and stays under SHARE_MAX_BYTES.
 */
export function toShare(stats: UsageStats, name?: string): UsageShare {
  if (name !== undefined && !SHARE_NAME_RE.test(name)) throw new Error(`invalid name: ${name}`);
  return UsageShare.parse({
    version: stats.version,
    ...(name !== undefined ? { name } : {}),
    range: stats.range,
    hero: stats.hero,
    // Boxes running and PRs waiting at publish time are live state, not a result.
    // hoursSaved is left out: the share derives it from the hero (see StatsKpis).
    kpis: {
      peak: { ...stats.kpis.peak, runningNow: 0 },
      speedup: stats.kpis.speedup,
      prs: { ...stats.kpis.prs, waitingReview: 0 },
      boxHours: stats.kpis.boxHours,
    },
    daily: fitDaily(encodeDaily(stats.daily.slice(-SHARE_LIMITS.dailyDays), stats.range.since)),
    wall: fitWall(encodeWall(stats.wall, stats.range.since)),
    streaks: stats.streaks,
    gantt: stats.gantt.slice(0, SHARE_LIMITS.ganttDays).map((g) => ({
      date: g.date,
      // The busiest lanes, back in the order they started.
      lanes: [...g.lanes]
        .sort((a, b) => laneHours(b) - laneHours(a))
        .slice(0, SHARE_LIMITS.lanes)
        .sort((a, b) => a.intervals[0]![0] - b.intervals[0]![0])
        .map((l) => ({
          agent: l.agent,
          provider: l.provider,
          intervals: fitIntervals(l.intervals, SHARE_LIMITS.intervalsPerLane),
          merged: l.pr !== null,
        })),
    })),
    sessions: stats.sessions.slice(0, SHARE_LIMITS.sessions).map((s) => ({
      agent: s.agent,
      provider: s.provider,
      boxes: int(s.boxes, 99_999),
      peak: int(s.peak, 999),
      prsMerged: int(s.prsMerged, 99_999),
      minutes: int(s.minutes, 9_999_999),
    })),
    punchcard: stats.punchcard.map((row) => row.map((v) => h1(v, 99_999))),
    providers: stats.providers.map((p) => ({
      id: p.id,
      hours: h1(p.hours, 999_999),
      boxes: int(p.boxes, 99_999),
    })),
  });
}

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Parse a share POST body for storage. Refuses more than SHARE_MAX_BYTES of raw text
 * and any `__proto__` / `constructor` / `prototype` key (zod would drop it from the
 * output but it is still in the raw text). Store the returned value re-serialized,
 * never the raw body: only the parsed output is known to hold nothing but numbers,
 * dates, enum ids and the optional display name.
 */
export function parseShareBody(rawText: string): UsageShare {
  if (new TextEncoder().encode(rawText).length > SHARE_MAX_BYTES) {
    throw new Error(`share body over ${SHARE_MAX_BYTES} bytes`);
  }
  const json: unknown = JSON.parse(rawText, (key, value: unknown) => {
    if (FORBIDDEN_KEYS.has(key)) throw new Error(`forbidden key in share body: ${key}`);
    return value;
  });
  return UsageShare.parse(json);
}
