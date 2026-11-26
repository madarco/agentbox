import { describe, expect, it } from 'vitest';
import {
  activeIntervals,
  buildUsageStats,
  concurrency,
  addDays,
  concurrencyByDay,
  dayKey,
  dayStart,
  groupSessions,
  lanesFromSessions,
  maxOf,
  minOf,
  overlapProfile,
  peakOverlap,
  shippedByDay,
  spansByDay,
  streaks,
  summarizeSessions,
  timeAtLeast,
  totalMs,
  unionSpans,
  UsageStats,
} from '../src/index.js';
import type { ActivityEvent, Lane, SessionTurns, Span } from '../src/index.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
/** 2026-11-19T00:00Z plus `h` hours. */
const at = (h: number): number => Date.UTC(2026, 10, 19) + h * HOUR;
const every = (fromH: number, toH: number, stepMin = 2): number[] => {
  const out: number[] = [];
  for (let t = at(fromH); t <= at(toH); t += stepMin * MIN) out.push(t);
  return out;
};
const session = (
  id: string,
  boxId: string | null,
  turns: number[],
  extra: Partial<SessionTurns> = {},
): SessionTurns => ({ sessionId: id, boxId, agent: 'claude', provider: 'docker', turns, ...extra });

describe('activeIntervals', () => {
  it('splits at gaps over the idle gap and closes 1 min after the last turn', () => {
    const turns = [at(9), at(9) + 5 * MIN, at(9) + 15 * MIN, at(9) + 26 * MIN];
    expect(activeIntervals(turns)).toEqual([
      { start: at(9), end: at(9) + 15 * MIN + MIN },
      { start: at(9) + 26 * MIN, end: at(9) + 27 * MIN },
    ]);
  });

  it('keeps a gap of exactly the idle gap inside one interval', () => {
    const turns = [at(9), at(9) + 10 * MIN];
    expect(activeIntervals(turns)).toHaveLength(1);
  });

  it('takes the gap and tail as parameters, in any turn order', () => {
    const turns = [at(9) + 6 * MIN, at(9)];
    expect(activeIntervals(turns, { idleGapMs: 5 * MIN, tailMs: 0 })).toEqual([
      { start: at(9), end: at(9) },
      { start: at(9) + 6 * MIN, end: at(9) + 6 * MIN },
    ]);
  });

  it('returns nothing for no turns', () => {
    expect(activeIntervals([])).toEqual([]);
  });
});

describe('union, overlap, peak', () => {
  const a = { start: 0, end: 10 };
  const b = { start: 5, end: 15 };
  const c = { start: 15, end: 20 };
  const d = { start: 30, end: 40 };

  it('unions overlapping and touching spans', () => {
    expect(unionSpans([d, b, a, c])).toEqual([
      { start: 0, end: 20 },
      { start: 30, end: 40 },
    ]);
  });

  it('never counts back-to-back spans as overlapping', () => {
    expect(peakOverlap([b, c])).toEqual({ peak: 1, at: 5 });
    expect(overlapProfile([b, c])).toEqual([
      { start: 5, end: 15, n: 1 },
      { start: 15, end: 20, n: 1 },
    ]);
  });

  it('finds the peak and the time with k or more open', () => {
    expect(peakOverlap([a, b, { start: 6, end: 8 }])).toEqual({ peak: 3, at: 6 });
    expect(timeAtLeast([a, b], 2)).toBe(5);
    expect(timeAtLeast([a, b], 1)).toBe(15);
  });

  it('agent time sums, wall time unions', () => {
    const lanes: Lane[] = [
      {
        key: 'x',
        boxId: 'x',
        agent: 'claude',
        provider: 'docker',
        managerId: null,
        spans: [{ start: at(9), end: at(12) }],
      },
      {
        key: 'y',
        boxId: 'y',
        agent: 'codex',
        provider: 'hetzner',
        managerId: null,
        spans: [{ start: at(10), end: at(11) }],
      },
    ];
    const c2 = concurrency(lanes);
    expect(c2.agentMs).toBe(4 * HOUR);
    expect(c2.wallMs).toBe(3 * HOUR);
    expect(c2.peak).toBe(2);
    expect(c2.parallelMs).toBe(HOUR);
  });
});

describe('lanes', () => {
  it('merges two sessions of one box, so they count once at once', () => {
    const lanes = lanesFromSessions([
      session('s1', 'box1', every(9, 10)),
      session('s2', 'box1', every(9.5, 11)),
      session('h1', null, every(9, 9.5)),
    ]);
    expect(lanes).toHaveLength(2);
    const box = lanes.find((l) => l.key === 'box1')!;
    expect(box.spans).toHaveLength(1);
    expect(totalMs(box.spans)).toBe(2 * HOUR + MIN);
    expect(lanes.find((l) => l.boxId === null)!.key).toBe('session:h1');
  });
});

describe('time zones', () => {
  it('buckets an instant into its local day', () => {
    const lateUtc = Date.UTC(2026, 10, 19, 23, 30);
    expect(dayKey(lateUtc, 'UTC')).toBe('2026-11-19');
    expect(dayKey(lateUtc, 'Europe/Rome')).toBe('2026-11-20');
    expect(dayKey(Date.UTC(2026, 10, 20, 2, 0), 'America/New_York')).toBe('2026-11-19');
  });

  it('day start is local midnight', () => {
    expect(dayStart('2026-11-20', 'Europe/Rome')).toBe(Date.UTC(2026, 10, 19, 23, 0));
    expect(dayStart('2026-11-20', 'America/New_York')).toBe(Date.UTC(2026, 10, 20, 5, 0));
  });

  it('splits a span at local midnight', () => {
    const span = { start: Date.UTC(2026, 10, 19, 22, 0), end: Date.UTC(2026, 10, 20, 1, 0) };
    const utc = spansByDay([span], 'UTC');
    expect([...utc.keys()]).toEqual(['2026-11-19', '2026-11-20']);
    expect(totalMs(utc.get('2026-11-19')!)).toBe(2 * HOUR);
    const cet = spansByDay([span], 'Europe/Rome');
    expect(totalMs(cet.get('2026-11-19')!)).toBe(HOUR);
    expect(totalMs(cet.get('2026-11-20')!)).toBe(2 * HOUR);
  });

  it('peak per day uses the local day', () => {
    const lanes = lanesFromSessions([
      session('a', 'a', every(22.5, 23.5)),
      session('b', 'b', every(23, 23.5)),
    ]);
    expect(concurrencyByDay(lanes, 'UTC').get('2026-11-19')!.peak).toBe(2);
    const cet = concurrencyByDay(lanes, 'Europe/Rome');
    expect(cet.get('2026-11-19')!.peak).toBe(1);
    expect(cet.get('2026-11-20')!.peak).toBe(2);
  });
});

describe('sessions', () => {
  it('groups by manager, and loose boxes by connected overlap', () => {
    const lanes = lanesFromSessions([
      session('m1', 'm1', every(9, 10), { managerId: 'M' }),
      session('m2', 'm2', every(15, 16), { managerId: 'M' }),
      // a chain: a overlaps b, b overlaps c, a and c never meet
      session('a', 'a', every(9, 10)),
      session('b', 'b', every(9.75, 11)),
      session('c', 'c', every(10.75, 12)),
      session('lonely', 'lonely', every(18, 19)),
    ]);
    const groups = groupSessions(lanes);
    const keys = groups.map((g) =>
      g.lanes
        .map((l) => l.key)
        .sort()
        .join(','),
    );
    expect(keys).toEqual(expect.arrayContaining(['m1,m2', 'a,b,c', 'lonely']));
    expect(groups).toHaveLength(3);
  });

  it('ranks by boxes, then PRs merged', () => {
    const lanes = lanesFromSessions([
      session('a', 'a', every(9, 10)),
      session('b', 'b', every(9.5, 10)),
      session('c', 'c', every(14, 15)),
      session('d', 'd', every(14.5, 15)),
    ]);
    const events: ActivityEvent[] = [{ type: 'pr.merged', at: at(15), boxId: 'c' }];
    const s = summarizeSessions(groupSessions(lanes), events);
    expect(s.map((x) => x.boxIds.sort().join(','))).toEqual(['c,d', 'a,b']);
    expect(s[0]!.prsMerged).toBe(1);
    expect(s[0]!.peak).toBe(2);
    expect(s[0]!.minutes).toBe(61);
  });
});

describe('shipped and streaks', () => {
  it('counts lines from pushes and PRs from merges, per local day', () => {
    const events: ActivityEvent[] = [
      { type: 'git.push', at: at(10), commits: 3, files: 5, additions: 100, deletions: 20 },
      { type: 'git.push', at: at(23.5), commits: 1, files: 1, additions: 10, deletions: 0 },
      { type: 'pr.merged', at: at(11), additions: 110, deletions: 20 },
    ];
    const utc = shippedByDay(events, 'UTC').get('2026-11-19')!;
    expect(utc).toEqual({ commits: 4, files: 6, additions: 110, deletions: 20, prsMerged: 1 });
    const cet = shippedByDay(events, 'Europe/Rome');
    expect(cet.get('2026-11-19')!.commits).toBe(3);
    expect(cet.get('2026-11-20')!.commits).toBe(1);
  });

  it('current streak ends today or yesterday; best is the longest run', () => {
    const days = new Set([
      '2026-11-10',
      '2026-11-11',
      '2026-11-12',
      '2026-11-13',
      '2026-11-17',
      '2026-11-18',
    ]);
    expect(streaks(days, '2026-11-18')).toEqual({ current: 2, best: 4 });
    expect(streaks(days, '2026-11-19')).toEqual({ current: 2, best: 4 });
    expect(streaks(days, '2026-11-20')).toEqual({ current: 0, best: 4 });
    expect(streaks(new Set(), '2026-11-20')).toEqual({ current: 0, best: 0 });
  });

  it('a streak crosses a month boundary', () => {
    expect(streaks(new Set(['2026-10-31', '2026-11-01']), '2026-11-01').current).toBe(2);
  });
});

describe('buildUsageStats', () => {
  const sessions: SessionTurns[] = [
    session('s1', 'b1', every(9, 12), { managerId: 'M' }),
    session('s2', 'b2', every(10, 11), { managerId: 'M', agent: 'codex', provider: 'hetzner' }),
    session('s3', 'b3', every(10.5, 11), { provider: 'e2b' }),
    // the day before, out of a 1-day range but on the wall
    session('s4', 'b1', [at(-10), at(-9.9)]),
  ];
  const events: ActivityEvent[] = [
    {
      type: 'git.push',
      at: at(11),
      boxId: 'b1',
      commits: 4,
      files: 7,
      additions: 300,
      deletions: 40,
    },
    {
      type: 'git.push',
      at: at(-10),
      boxId: 'b1',
      commits: 1,
      files: 1,
      additions: 1,
      deletions: 1,
    },
    {
      type: 'pr.merged',
      at: at(12),
      boxId: 'b1',
      repo: 'agentbox',
      number: 7,
      title: 'Do it',
      additions: 300,
      deletions: 40,
    },
  ];
  const stats = buildUsageStats({
    range: { id: '7d', since: '2026-11-19', until: '2026-11-19', today: '2026-11-19', tz: 'UTC' },
    now: at(13),
    sessions,
    events,
    tokens: [{ at: at(10), agent: 'claude', provider: 'docker', boxId: 'b1', tokens: 1000 }],
    boxes: [
      { boxId: 'b1', name: 'fix-it', project: 'agentbox', agent: 'claude', provider: 'docker' },
      { boxId: 'b2', name: 'help', project: 'agentbox', agent: 'codex', provider: 'hetzner' },
      { boxId: 'b3', name: 'side', project: 'other', agent: 'claude', provider: 'e2b' },
    ],
    boxRuns: [{ boxId: 'b1', provider: 'docker', start: at(8), end: at(13) }],
    sessionTitles: { M: 'Big refactor' },
    previous: { peak: 1, speedup: 1, prsMerged: 0, boxHours: 2.5 },
  });

  it('produces a valid UsageStats', () => {
    expect(() => UsageStats.parse(stats)).not.toThrow();
  });

  it('computes the hero numbers', () => {
    expect(stats.hero.peakAtOnce).toBe(3);
    expect(stats.hero.peakDate).toBe('2026-11-19');
    expect(stats.hero.agentHours).toBeCloseTo(3 + 1 + 0.5 + 3 / 60, 1);
    expect(stats.hero.wallHours).toBeCloseTo(3 + 1 / 60, 1);
    expect(stats.hero.prsMerged).toBe(1);
    expect(stats.hero.commits).toBe(4);
    expect(stats.hero.biggestPrAdditions).toBe(300);
    expect(stats.hero.boxes).toBe(3);
    expect(stats.hero.streakDays).toBe(2);
  });

  it('computes the KPIs and deltas', () => {
    expect(stats.kpis.boxHours.value).toBe(5);
    expect(stats.kpis.boxHours.deltaPct).toBe(100);
    expect(stats.kpis.peak.delta).toBe(2);
    expect(stats.kpis.boxHours.tokens).toBe(1000);
  });

  it('fills daily splits', () => {
    const d = stats.daily[0]!;
    expect(d.byAgent.claude!.tokens).toBe(1000);
    expect(d.byProvider.hetzner!.agentHours).toBeCloseTo(1 + 1 / 60, 2);
    expect(d.byProject!.agentbox!.commits).toBe(4);
  });

  it('names sessions from the manager title, and keeps the wall a year long', () => {
    expect(stats.sessions[0]!.title).toBe('Big refactor');
    expect(stats.sessions[0]!.boxes).toBe(2);
    expect(stats.wall).toHaveLength(371);
    expect(stats.wall.at(-2)!.commits).toBe(1);
    expect(stats.streaks.best).toBe(2);
  });

  it('lays out the busiest day in the Gantt, with the merged PR', () => {
    const g = stats.gantt[0]!;
    expect(g.date).toBe('2026-11-19');
    const fix = g.lanes.find((l) => l.box === 'fix-it')!;
    expect(fix.pr).toBe('agentbox#7');
    expect(fix.intervals[0]![0]).toBe(9);
  });

  it('feeds the punchcard by local hour', () => {
    // Thursday 19 Nov: hours 9, 10 and 11 hold the work
    expect(stats.punchcard[4]![9]).toBeCloseTo(1, 2);
    expect(stats.punchcard[4]![10]).toBeGreaterThan(2);
  });
});

describe('buildUsageStats edge cases', () => {
  const range = {
    id: '7d' as const,
    since: '2026-11-17',
    until: '2026-11-19',
    today: '2026-11-19',
    tz: 'UTC',
  };

  it("marks each Gantt day with the PR merged that day, not the box's last one", () => {
    const stats = buildUsageStats({
      range,
      now: at(20),
      sessions: [session('s', 'b', [...every(-48 + 9, -48 + 10), ...every(9, 10)])],
      events: [
        { type: 'pr.merged', at: at(-48 + 10), boxId: 'b', repo: 'r', number: 1 },
        { type: 'pr.merged', at: at(10), boxId: 'b', repo: 'r', number: 2 },
      ],
      boxes: [{ boxId: 'b', name: 'b', agent: 'claude', provider: 'docker' }],
      ganttDays: ['2026-11-17', '2026-11-19'],
    });
    expect(stats.gantt.map((g) => g.lanes[0]!.pr)).toEqual(['r#1', 'r#2']);
  });

  it('keeps the top boxes by every leaderboard metric', () => {
    const boxes = Array.from({ length: 8 }, (_, i) => ({
      boxId: `b${i}`,
      name: `box-${i}`,
      agent: 'claude' as const,
      provider: 'docker' as const,
    }));
    const stats = buildUsageStats({
      range,
      now: at(20),
      // b7 runs longest but pushes nothing
      sessions: boxes.map((b, i) => session(b.boxId, b.boxId, every(9, i === 7 ? 15 : 9.5))),
      events: boxes.slice(0, 7).map((b, i) => ({
        type: 'git.push' as const,
        at: at(9.2),
        boxId: b.boxId,
        commits: 1,
        files: 1,
        additions: 100 * (i + 1),
        deletions: 0,
      })),
      boxes,
    });
    expect(stats.boxes.map((b) => b.name)).toContain('box-7');
    expect(stats.boxes.map((b) => b.name)).toContain('box-6');
  });

  it('fits long or empty names into the schema', () => {
    const long = 'x'.repeat(500);
    const stats = buildUsageStats({
      range,
      now: at(20),
      sessions: [session('s', 'b', every(9, 10))],
      events: [{ type: 'pr.merged', at: at(10), boxId: 'b', repo: long, number: 3, title: long }],
      boxes: [{ boxId: 'b', name: '', project: long, agent: 'claude', provider: 'docker' }],
      providerNotes: { docker: long },
    });
    expect(() => UsageStats.parse(stats)).not.toThrow();
    expect(stats.feed[0]!.box).toBe('unknown');
  });

  it('per-day concurrency matches clipping each day', () => {
    const lanes = lanesFromSessions([
      session('a', 'a', every(20, 30)),
      session('b', 'b', every(23, 25)),
      session('c', 'c', every(-3, 1)),
    ]);
    const byDay = concurrencyByDay(lanes, 'Europe/Rome');
    for (const [d, v] of byDay) {
      const c = concurrency(
        lanes,
        dayStart(d, 'Europe/Rome'),
        dayStart(addDays(d, 1), 'Europe/Rome'),
      );
      expect(v.peak).toBe(c.peak);
      expect(v.agentHours).toBeCloseTo(c.agentMs / HOUR, 6);
      expect(v.wallHours).toBeCloseTo(c.wallMs / HOUR, 6);
    }
  });
});

describe('time zones across DST', () => {
  // Europe/Rome: CET (+1) to CEST (+2) at 01:00 UTC on 29 Mar 2026, back at 01:00 UTC
  // on 25 Oct 2026. America/New_York: EST (-5) to EDT (-4) at 07:00 UTC on 8 Mar 2026,
  // back at 06:00 UTC on 1 Nov 2026.
  it('days have 23 and 25 hours on the change days', () => {
    const len = (d: string, tz: string): number =>
      (dayStart(addDays(d, 1), tz) - dayStart(d, tz)) / HOUR;
    expect(len('2026-03-29', 'Europe/Rome')).toBe(23);
    expect(len('2026-10-25', 'Europe/Rome')).toBe(25);
    expect(len('2026-03-28', 'Europe/Rome')).toBe(24);
    expect(len('2026-03-08', 'America/New_York')).toBe(23);
    expect(len('2026-11-01', 'America/New_York')).toBe(25);
    expect(dayStart('2026-03-30', 'Europe/Rome')).toBe(Date.UTC(2026, 2, 29, 22, 0));
    expect(dayStart('2026-11-02', 'America/New_York')).toBe(Date.UTC(2026, 10, 2, 5, 0));
  });

  it('buckets a 00:30 turn on the right day on both sides of the change', () => {
    // 00:30 local, the day after each change.
    expect(dayKey(Date.UTC(2026, 2, 29, 22, 30), 'Europe/Rome')).toBe('2026-03-30');
    expect(dayKey(Date.UTC(2026, 9, 25, 23, 30), 'Europe/Rome')).toBe('2026-10-26');
    expect(dayKey(Date.UTC(2026, 2, 9, 4, 30), 'America/New_York')).toBe('2026-03-09');
    expect(dayKey(Date.UTC(2026, 10, 2, 5, 30), 'America/New_York')).toBe('2026-11-02');
    // 23:30 local the evening before: still that day.
    expect(dayKey(Date.UTC(2026, 2, 29, 21, 30), 'Europe/Rome')).toBe('2026-03-29');
    expect(dayKey(Date.UTC(2026, 10, 2, 4, 30), 'America/New_York')).toBe('2026-11-01');
  });

  it('a window across the change keeps each day whole', () => {
    // Active 22:00-02:00 local every night for a week around the spring change.
    const spans: Span[] = [];
    for (let i = 0; i < 7; i++) {
      const d = addDays('2026-03-26', i);
      const s = dayStart(d, 'Europe/Rome') + 22 * HOUR;
      spans.push({ start: s, end: s + 4 * HOUR });
    }
    const byDay = spansByDay(spans, 'Europe/Rome');
    for (const [d, parts] of byDay) {
      for (const p of parts) {
        expect(dayKey(p.start, 'Europe/Rome')).toBe(d);
        expect(dayKey(p.end - 1, 'Europe/Rome')).toBe(d);
      }
    }
    // 22:00 local is 21:00 UTC before the change and 20:00 UTC after it.
    expect(spans[0]!.start).toBe(Date.UTC(2026, 2, 26, 21, 0));
    expect(spans[4]!.start).toBe(Date.UTC(2026, 2, 30, 20, 0));
  });

  it('the punchcard counts local hours on both sides of the change', () => {
    // One hour at 09:00 local, the Friday before and the Monday after the spring change.
    const nine = (d: string): number => dayStart(d, 'America/New_York') + 9 * HOUR;
    const turns = (d: string): number[] => {
      const s = nine(d);
      return Array.from({ length: 60 }, (_, i) => s + i * MIN);
    };
    const stats = buildUsageStats({
      range: {
        id: '7d',
        since: '2026-03-06',
        until: '2026-03-12',
        today: '2026-03-12',
        tz: 'America/New_York',
      },
      now: Date.UTC(2026, 2, 12, 12),
      sessions: [
        { ...session('a', 'a', []), turns: turns('2026-03-06') },
        { ...session('b', 'b', []), turns: turns('2026-03-09') },
      ],
      events: [],
      intervals: { tailMs: 60_000 },
    });
    // Friday (5) and Monday (1), both in the 09:00 column only.
    expect(stats.punchcard[5]![9]).toBeCloseTo(1, 6);
    expect(stats.punchcard[1]![9]).toBeCloseTo(1, 6);
    expect(stats.punchcard.flat().reduce((a, b) => a + b, 0)).toBeCloseTo(2, 6);
    expect(stats.daily.find((d) => d.date === '2026-03-09')!.agentHours).toBeCloseTo(1, 2);
  });

  it('precomputed spans give the same lanes as the turns', () => {
    const turns = every(0, 3);
    const a = lanesFromSessions([session('a', 'a', turns)]);
    const b = lanesFromSessions([
      { ...session('a', 'a', []), spans: lanesFromSessions([session('a', 'a', turns)])[0]!.spans },
    ]);
    expect(b).toEqual(a);
  });
});

describe('scale', () => {
  it('summarizes a session of 300k intervals without overflowing the stack', () => {
    const spans = Array.from({ length: 300_000 }, (_, i) => ({ start: i * 10, end: i * 10 + 5 }));
    const lane: Lane = {
      key: 'x',
      boxId: 'x',
      agent: 'claude',
      provider: 'docker',
      managerId: 'M',
      spans,
    };
    const s = summarizeSessions(groupSessions([lane]), []);
    expect(s[0]!.start).toBe(0);
    expect(minOf(spans.map((x) => x.start))).toBe(0);
    expect(maxOf(spans.map((x) => x.end))).toBe(2_999_995);
    expect(maxOf([], 0)).toBe(0);
  });
});

describe('Gantt lanes across midnight', () => {
  it('a lane that started the evening before belongs to that day only', () => {
    const stats = buildUsageStats({
      range: {
        id: '7d',
        since: '2026-11-17',
        until: '2026-11-19',
        today: '2026-11-19',
        tz: 'UTC',
      },
      now: at(20),
      sessions: [session('s', 'b', every(-3, 2))],
      events: [],
      boxes: [{ boxId: 'b', name: 'night', agent: 'claude', provider: 'docker' }],
      ganttDays: ['2026-11-18', '2026-11-19'],
    });
    expect(stats.gantt[0]!.lanes).toHaveLength(1);
    expect(stats.gantt[0]!.lanes[0]!.intervals[0]![0]).toBe(21);
    expect(stats.gantt[0]!.lanes[0]!.intervals.at(-1)![1]).toBeGreaterThan(26);
    expect(stats.gantt[1]!.lanes).toHaveLength(0);
  });
});
