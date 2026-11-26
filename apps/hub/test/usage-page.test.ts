import { usageFixture } from '@agentbox/usage-view';
import { describe, expect, it } from 'vitest';
import {
  parseUsageRange,
  usageCsv,
  usageIsEmpty,
  usageShareBody,
  usageStatsQuery,
} from '../lib/usage-page';

describe('usageStatsQuery', () => {
  it('runs this month to its last day, so the rest is forecast', () => {
    const q = usageStatsQuery('month', '2028-02-10', 'Europe/Rome');
    expect(Object.fromEntries(q)).toEqual({
      tz: 'Europe/Rome',
      range: 'month',
      since: '2028-02-01',
      until: '2028-02-29',
    });
  });

  it('ends the rolling ranges today and carries the subscription', () => {
    expect(Object.fromEntries(usageStatsQuery('7d', '2026-11-26', 'UTC', 'claude/work'))).toEqual({
      tz: 'UTC',
      range: '7d',
      since: '7d',
      subscription: 'claude/work',
    });
    expect(usageStatsQuery('30d', '2026-11-26', 'UTC').get('since')).toBe('30d');
    expect(usageStatsQuery('90d', '2026-11-26', 'UTC').get('since')).toBe('90d');
    expect(usageStatsQuery('year', '2026-11-26', 'UTC').get('since')).toBe('365d');
  });

  it('falls back to the last 30 days for a missing or unknown range', () => {
    expect(parseUsageRange(null)).toBe('30d');
    expect(parseUsageRange('all')).toBe('30d');
    expect(parseUsageRange('month')).toBe('month');
    expect(parseUsageRange('90d')).toBe('90d');
  });
});

describe('usageCsv', () => {
  const stats = usageFixture();

  it('writes one row per day up to today, no forecast days', () => {
    const lines = usageCsv(stats).trimEnd().split('\n');
    const days = stats.daily.filter((d) => d.date <= stats.range.today);
    expect(lines).toHaveLength(days.length + 1);
    expect(lines[0]!.startsWith('date,agent_hours,wall_hours,box_hours,peak_at_once')).toBe(true);
    expect(lines[1]!.startsWith(`${days[0]!.date},`)).toBe(true);
    expect(lines.at(-1)!.startsWith(`${stats.range.today},`)).toBe(true);
  });

  it('adds a column per agent and provider seen, with the same width on every row', () => {
    const lines = usageCsv(stats).trimEnd().split('\n');
    const header = lines[0]!.split(',');
    expect(header.some((h) => /^agent_[a-z]+_hours$/.test(h))).toBe(true);
    expect(header.some((h) => /^provider_[a-z-]+_hours$/.test(h))).toBe(true);
    for (const l of lines) expect(l.split(',')).toHaveLength(header.length);
  });
});

describe('usageIsEmpty', () => {
  it('is empty only when no day has hours, tokens or shipped work', () => {
    const stats = usageFixture();
    expect(usageIsEmpty(stats)).toBe(false);
    const zero = {
      ...stats,
      daily: stats.daily.map((d) => ({ ...d, agentHours: 0, tokens: 0, commits: 0, prsMerged: 0 })),
    };
    expect(usageIsEmpty(zero)).toBe(true);
  });
});

describe('usageShareBody', () => {
  it('names the same window as the stats query, plus the handle', () => {
    expect(
      usageShareBody('month', '2028-02-10', 'Europe/Rome', 'claude/work', 'marco', true),
    ).toEqual({
      tz: 'Europe/Rome',
      range: 'month',
      since: '2028-02-01',
      until: '2028-02-29',
      subscription: 'claude/work',
      handle: 'marco',
      preview: true,
    });
    expect(usageShareBody('7d', '2028-02-10', 'UTC', undefined, 'marco', false)).toEqual({
      tz: 'UTC',
      range: '7d',
      since: '7d',
      handle: 'marco',
    });
  });
});
