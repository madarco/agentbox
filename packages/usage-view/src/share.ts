import { HANDLE_RE, UsageShare } from './schema.js';
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
    kpis: stats.kpis,
    daily: stats.daily.map((d) => ({
      date: d.date,
      tokens: d.tokens,
      agentHours: d.agentHours,
      wallHours: d.wallHours,
      boxHours: d.boxHours,
      peak: d.peak,
      avgAtOnce: d.avgAtOnce,
      commits: d.commits,
      prsMerged: d.prsMerged,
      additions: d.additions,
      deletions: d.deletions,
      files: d.files,
      byAgent: d.byAgent,
      byProvider: d.byProvider,
    })),
    wall: stats.wall,
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
