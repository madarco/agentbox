import { describe, expect, it } from 'vitest';
import { UsageShare, encodeDaily, toShare, usageFixture } from '@agentbox/usage-view';
import type { DailyStats } from '@agentbox/usage-view';
import { MAX_BARS, MIN_SLOTS, dailySeries } from '@/lib/share/og-series';
import { periodText, shareMeta } from '@/lib/share/format';

const split = (h: number) => ({ tokens: 1000, agentHours: h, commits: 1 });

function day(date: string, peak: number, byAgent: DailyStats['byAgent']): DailyStats {
  const hours = Object.values(byAgent).reduce((a, s) => a + (s?.agentHours ?? 0), 0);
  return {
    date,
    tokens: 1000,
    agentHours: hours,
    wallHours: hours,
    boxHours: hours,
    peak,
    avgAtOnce: 1,
    commits: 1,
    prsMerged: 0,
    additions: 1,
    deletions: 0,
    files: 1,
    byAgent,
    byProvider: {},
  };
}

function withDays(days: DailyStats[]): UsageShare {
  const s = toShare(usageFixture(), 'test');
  const first = days[0]!.date;
  const last = days.at(-1)!.date;
  return UsageShare.parse({
    ...s,
    range: { ...s.range, id: '90d', since: first, today: last, until: last },
    daily: encodeDaily(days, first),
  });
}

const iso = (i: number): string => new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10);

describe('dailySeries', () => {
  it('pads a single day to the minimum slots, latest on the right', () => {
    const s = dailySeries(withDays([day('2026-11-26', 1, { claude: split(0.4) })]));
    expect(s.bars).toHaveLength(MIN_SLOTS);
    expect(s.bars.slice(0, -1).every((b) => b === null)).toBe(true);
    expect(s.bars.at(-1)).toEqual({ peak: 1, hours: [0.4] });
    expect(s).toMatchObject({
      bucketDays: 1,
      agents: ['claude'],
      maxPeak: 1,
      peakDay: '2026-11-26',
      partial: false,
    });
    const later = withDays([day('2026-11-26', 1, { claude: split(0.4) })]);
    const since = { ...later, range: { ...later.range, since: '2026-11-01' } };
    expect(dailySeries(since).partial).toBe(true);
  });

  it('draws the longest share window (62 days) per day', () => {
    const days = Array.from({ length: 62 }, (_, i) =>
      day(iso(i), (i % 7) + 1, { claude: split(1) }),
    );
    const s = dailySeries(withDays(days));
    expect(s).toMatchObject({ bucketDays: 1, maxPeak: 7, days: 62, partial: false });
    expect(s.bars).toHaveLength(62);
  });

  it('groups days into buckets past MAX_BARS, should the share limit grow', () => {
    const days = Array.from({ length: 366 }, (_, i) =>
      day(iso(i), (i % 7) + 1, { claude: split(1) }),
    );
    const base = toShare(usageFixture(), 'test');
    // Unparsed on purpose: today's schema refuses more than 62 days.
    const s = dailySeries({
      ...base,
      range: { ...base.range, since: iso(0), today: iso(365), until: iso(365) },
      daily: encodeDaily(days, iso(0)),
    } as UsageShare);
    expect(s.bars.length).toBeLessThanOrEqual(MAX_BARS);
    expect(s.bucketDays).toBe(4);
    // 366 = 2 + 91 * 4: the short bucket is the oldest one.
    expect(s.bars[0]).toEqual({ peak: 2, hours: [2] });
    expect(s.bars.at(-1)!.hours).toEqual([4]);
  });

  it('highlights only the first busiest day', () => {
    const s = dailySeries(
      withDays([
        day('2026-11-24', 5, { claude: split(1) }),
        day('2026-11-25', 2, { claude: split(1) }),
        day('2026-11-26', 5, { claude: split(1) }),
      ]),
    );
    expect(s.peakDay).toBe('2026-11-24');
    expect(s.peakIndex).toBe(MIN_SLOTS - 3);
  });

  it('names the top three agents and sums the rest as other', () => {
    const s = dailySeries(
      withDays([
        day('2026-11-25', 2, {
          claude: split(5),
          codex: split(4),
          pi: split(3),
          opencode: split(2),
        }),
        day('2026-11-26', 3, { openclaw: split(1) }),
      ]),
    );
    expect(s.agents).toEqual(['claude', 'codex', 'pi', 'other']);
    expect(s.bars.at(-2)!.hours).toEqual([5, 4, 3, 2]);
    expect(s.bars.at(-1)!.hours).toEqual([0, 0, 0, 1]);
    expect(s.peakDay).toBe('2026-11-26');
    expect(s.peakIndex).toBe(s.bars.length - 1);
    expect(s.maxHours).toBe(14);
  });

  it('keeps four agents when that is all there is', () => {
    const s = dailySeries(
      withDays([
        day('2026-11-26', 1, {
          claude: split(4),
          codex: split(3),
          pi: split(2),
          opencode: split(1),
        }),
      ]),
    );
    expect(s.agents).toEqual(['claude', 'codex', 'pi', 'opencode']);
  });
});

describe('share wording', () => {
  const share = toShare(usageFixture(), 'example');

  it('names a calendar month, else the dates', () => {
    // The fixture's November ends on the 26th: dates, since a share is frozen.
    expect(periodText(share)).toBe('1 Nov - 26 Nov 2026');
    const full = { ...share.range, since: '2026-11-01', today: '2026-11-30', until: '2026-11-30' };
    expect(periodText({ ...share, range: full })).toBe('November 2026');
    const febLeap = {
      ...share.range,
      since: '2028-02-01',
      today: '2028-02-29',
      until: '2028-02-29',
    };
    expect(periodText({ ...share, range: febLeap })).toBe('February 2028');
    const spill = { ...share.range, since: '2026-11-01', today: '2026-12-01', until: '2026-12-01' };
    expect(periodText({ ...share, range: spill })).toBe('1 Nov - 1 Dec 2026');
    expect(periodText({ ...share, range: { ...share.range, id: '7d', since: '2026-11-20' } })).toBe(
      '20 Nov - 26 Nov 2026',
    );
    expect(periodText({ ...share, range: { ...share.range, id: '7d', since: '2026-11-26' } })).toBe(
      '26 Nov 2026',
    );
  });

  it('labels the numbers in the metadata', () => {
    const m = shareMeta(share);
    expect(m.title).toBe("@example's coding agents · 1 Nov - 26 Nov 2026");
    expect(m.description).toContain('9 agents running at the same time (peak).');
    expect(m.description).toContain(
      '612 hours of agent work in 211 hours, 2.9x faster than one agent.',
    );
    expect(m.description).toContain('401 hours saved vs. running one agent at a time.');
    expect(m.description).not.toMatch(/—/);
  });

  it('claims no hours saved without a real speed-up', () => {
    const hero = { ...share.hero, agentHours: 3, wallHours: 2.9, speedup: 1.03 };
    expect(shareMeta({ ...share, hero }).description).not.toContain('saved');
    const one = { ...share.hero, agentHours: 2.2, wallHours: 1.2, speedup: 1.8 };
    expect(shareMeta({ ...share, hero: one }).description).toContain('1 hour saved');
  });
});
