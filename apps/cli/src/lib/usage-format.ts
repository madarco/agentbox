// Pure helpers behind `agentbox usage`: no hub, no fs, so they unit-test.
import type {
  HubApiUsageDimension,
  HubApiUsageGroup,
  HubApiUsageTotals,
} from '../control-plane/hub-api-client.js';
import type { UsageStats } from '@agentbox/usage-view';
import { clip, compactCount, shortId } from './sessions-format.js';

export const USAGE_DIMENSIONS: readonly HubApiUsageDimension[] = [
  'day',
  'agent',
  'account',
  'box',
  'project',
  'host',
  'model',
  'session',
];

/** `--by agent,model` → dimensions, or an error naming the bad one. */
export function parseUsageBy(raw: string): HubApiUsageDimension[] {
  const dims = raw
    .split(',')
    .map((d) => d.trim())
    .filter(Boolean);
  for (const d of dims) {
    if (!(USAGE_DIMENSIONS as readonly string[]).includes(d)) {
      throw new Error(`unknown --by "${d}" (one of: ${USAGE_DIMENSIONS.join(', ')})`);
    }
  }
  const uniq = [...new Set(dims)] as HubApiUsageDimension[];
  if (uniq.length > 2) throw new Error('--by takes at most two dimensions');
  return uniq;
}

/** `git@github.com:o/r.git` / `https://github.com/o/r` → `o/r`; anything else as is. */
export function shortRepo(url: string): string {
  const m = /[:/]([^/:]+\/[^/]+?)(?:\.git)?\/?$/.exec(url);
  return m ? m[1]! : url;
}

export function usageKeyCell(d: HubApiUsageDimension, g: HubApiUsageGroup): string {
  const key = g.keys[d];
  if (key === null || key === undefined) return '-';
  const label = g.labels[d];
  if (d === 'box') return label ?? key;
  if (d === 'project') return shortRepo(key);
  if (d === 'host') return shortId(key);
  if (d === 'session') {
    const id = shortId(key.slice(key.indexOf(':') + 1));
    return label ? `${id} ${clip(label, 40)}` : id;
  }
  return key;
}

export const USAGE_TOTAL_HEADERS = [
  'INPUT',
  'OUTPUT',
  'CACHE READ',
  'CACHE WRITE',
  'TOTAL',
  'MSGS',
];

export function usageTotalCells(t: HubApiUsageTotals): string[] {
  return [
    compactCount(t.inputTokens),
    compactCount(t.outputTokens),
    compactCount(t.cacheReadTokens),
    compactCount(t.cacheWriteTokens),
    compactCount(t.totalTokens),
    String(t.messages),
  ];
}

/** The table: one row per group plus a total row, or the total alone. */
export function usageTable(
  by: readonly HubApiUsageDimension[],
  groups: readonly HubApiUsageGroup[],
  totals: HubApiUsageTotals,
): { headers: string[]; rows: string[][] } {
  const headers = [...by.map((d) => d.toUpperCase()), ...USAGE_TOTAL_HEADERS, 'SESSIONS'];
  const rows = groups.map((g) => [
    ...by.map((d) => usageKeyCell(d, g)),
    ...usageTotalCells(g),
    String(g.sessions),
  ]);
  const total = [
    ...by.map((_, i) => (i === 0 ? 'total' : '')),
    ...usageTotalCells(totals),
    String(totals.sessions),
  ];
  return { headers, rows: by.length > 0 ? [...rows, total] : [total] };
}

const nf = (n: number, digits = 0): string =>
  n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });

/** `agentbox usage`: the hero numbers of a window, one per line. */
export function usageHeroLines(s: UsageStats): string[] {
  const h = s.hero;
  const rows: Array<[string, string]> = [
    ['Agent-hours', `${nf(h.agentHours, 1)} h`],
    ['Wall hours', `${nf(h.wallHours, 1)} h`],
    ['Speed-up', `${nf(h.speedup, 2)}x`],
    ['Peak at once', h.peakDate ? `${nf(h.peakAtOnce)} (${h.peakDate})` : nf(h.peakAtOnce)],
    ['PRs merged', nf(h.prsMerged)],
    ['Commits', nf(h.commits)],
    ['Lines', `+${nf(h.additions)} / -${nf(h.deletions)}`],
    ['Box-hours', `${nf(s.kpis.boxHours.value, 1)} h over ${nf(s.kpis.boxHours.boxes)} boxes`],
  ];
  const w = Math.max(...rows.map(([k]) => k.length));
  return [
    `${s.range.since} to ${s.range.until < s.range.today ? s.range.until : s.range.today} (${s.range.tz})`,
    '',
    ...rows.map(([k, v]) => `${k.padEnd(w)}  ${v}`),
  ];
}
