// Pure helpers of the hub Usage page: the stats query a range asks for, and the
// CSV a window exports. No React, so they are unit-tested on their own.

import type { RangeId, UsageStats } from '@agentbox/usage-view';

export const USAGE_RANGES: readonly RangeId[] = ['7d', '30d', 'month', '90d', 'year'];
/** The last 30 days: the window the tray's header pill opens this page for. */
export const DEFAULT_USAGE_RANGE: RangeId = '30d';

export function parseUsageRange(raw: string | null | undefined): RangeId {
  return (USAGE_RANGES as readonly string[]).includes(raw ?? '')
    ? (raw as RangeId)
    : DEFAULT_USAGE_RANGE;
}

const pad = (n: number): string => String(n).padStart(2, '0');

/**
 * The `/api/v1/usage/stats` query for a range. `today` is the viewer's local
 * day (YYYY-MM-DD) in `tz`. "This month" runs to the month's last day, so the
 * view draws the rest of it as forecast; the others end on the hub's today
 * (no `until`), so a browser clock ahead of the hub's adds no forecast day.
 */
export function usageStatsQuery(
  range: RangeId,
  today: string,
  tz: string,
  subscription?: string,
): URLSearchParams {
  const q = new URLSearchParams({ tz, range });
  if (range === 'month') {
    const [y, m] = today.split('-').map(Number) as [number, number];
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    q.set('since', `${String(y)}-${pad(m)}-01`);
    q.set('until', `${String(y)}-${pad(m)}-${pad(last)}`);
  } else {
    q.set('since', range === 'year' ? '365d' : range);
  }
  if (subscription) q.set('subscription', subscription);
  return q;
}

/** The viewer's local day, in their own zone. */
export function localDay(now: Date = new Date()): string {
  return `${String(now.getFullYear())}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

const CSV_COLUMNS = [
  'date',
  'agent_hours',
  'wall_hours',
  'box_hours',
  'peak_at_once',
  'avg_at_once',
  'tokens',
  'commits',
  'prs_merged',
  'additions',
  'deletions',
  'files',
] as const;

function cell(v: string | number): string {
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * One row per day of the window up to today (forecast days are not data),
 * plus per-agent and per-provider agent-hour columns for the ones that appear.
 */
export function usageCsv(stats: UsageStats): string {
  const days = stats.daily.filter((d) => d.date <= stats.range.today);
  const agents = [...new Set(days.flatMap((d) => Object.keys(d.byAgent)))].sort();
  const providers = [...new Set(days.flatMap((d) => Object.keys(d.byProvider)))].sort();
  const header = [
    ...CSV_COLUMNS,
    ...agents.map((a) => `agent_${a}_hours`),
    ...providers.map((p) => `provider_${p}_hours`),
  ];
  const rows = days.map((d) => [
    d.date,
    round2(d.agentHours),
    round2(d.wallHours),
    round2(d.boxHours),
    d.peak,
    round2(d.avgAtOnce),
    d.tokens,
    d.commits,
    d.prsMerged,
    d.additions,
    d.deletions,
    d.files,
    ...agents.map((a) => round2(d.byAgent[a as keyof typeof d.byAgent]?.agentHours ?? 0)),
    ...providers.map((p) => round2(d.byProvider[p as keyof typeof d.byProvider]?.agentHours ?? 0)),
  ]);
  return [header, ...rows].map((r) => r.map(cell).join(',')).join('\n') + '\n';
}

/** Nothing recorded in the window: no agent time, no tokens, no shipped work. */
export function usageIsEmpty(stats: UsageStats): boolean {
  return stats.daily.every(
    (d) => d.agentHours === 0 && d.tokens === 0 && d.commits === 0 && d.prsMerged === 0,
  );
}

/**
 * The `POST /api/v1/usage/share` body for the window the page shows: the same
 * fields `usageStatsQuery` puts in the stats URL, plus the display name if any.
 */
export function usageShareBody(
  range: RangeId,
  today: string,
  tz: string,
  subscription: string | undefined,
  name: string,
  preview: boolean,
): Record<string, string | boolean> {
  const body: Record<string, string | boolean> = Object.fromEntries(
    usageStatsQuery(range, today, tz, subscription),
  );
  if (name) body.name = name;
  if (preview) body.preview = true;
  return body;
}
