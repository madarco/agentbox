import { encodeDaily, encodeWall } from './columns.js';
import { HANDLE_RE, LIMITS, UsageShare } from './schema.js';
import type { UsageStats } from './schema.js';

/**
 * The public subset of `stats`: numbers, dates and enum ids. Box, project, branch,
 * PR and session names stay behind; lanes and sessions keep only agent + provider.
 * Parsed with the strict schema, so a private field added later fails loudly here.
 */
export function toShare(stats: UsageStats, handle: string): UsageShare {
  if (!HANDLE_RE.test(handle)) throw new Error(`invalid handle: ${handle}`);
  return UsageShare.parse({
    version: stats.version,
    handle,
    range: stats.range,
    hero: stats.hero,
    // Boxes running and PRs waiting at publish time are live state, not a result.
    kpis: {
      ...stats.kpis,
      peak: { ...stats.kpis.peak, runningNow: 0 },
      prs: { ...stats.kpis.prs, waitingReview: 0 },
    },
    daily: encodeDaily(stats.daily.slice(-LIMITS.shareDailyDays), stats.range.since),
    wall: encodeWall(stats.wall, stats.range.since),
    streaks: stats.streaks,
    gantt: stats.gantt.map((g) => ({
      date: g.date,
      lanes: g.lanes.map((l) => ({
        agent: l.agent,
        provider: l.provider,
        intervals: l.intervals,
        merged: l.pr !== null,
      })),
    })),
    sessions: stats.sessions.map((s) => ({
      agent: s.agent,
      provider: s.provider,
      boxes: s.boxes,
      peak: s.peak,
      prsMerged: s.prsMerged,
      minutes: s.minutes,
    })),
    punchcard: stats.punchcard,
    providers: stats.providers.map((p) => ({ id: p.id, hours: p.hours, boxes: p.boxes })),
  });
}
