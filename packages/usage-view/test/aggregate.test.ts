import { describe, expect, it } from 'vitest';
import {
  activeIntervals,
  buildUsageStats,
  concurrency,
  concurrencyByDay,
  dayKey,
  dayStart,
  groupSessions,
  lanesFromSessions,
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
import type { ActivityEvent, Lane, SessionTurns } from '../src/index.js';

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
    expect(dayKey(lateUtc, 0)).toBe('2026-11-19');
    expect(dayKey(lateUtc, 60)).toBe('2026-11-20');
    expect(dayKey(Date.UTC(2026, 10, 20, 2, 0), -300)).toBe('2026-11-19');
  });

  it('day start is local midnight', () => {
    expect(dayStart('2026-11-20', 60)).toBe(Date.UTC(2026, 10, 19, 23, 0));
    expect(dayStart('2026-11-20', -300)).toBe(Date.UTC(2026, 10, 20, 5, 0));
  });

  it('splits a span at local midnight', () => {
    const span = { start: Date.UTC(2026, 10, 19, 22, 0), end: Date.UTC(2026, 10, 20, 1, 0) };
    const utc = spansByDay([span], 0);
    expect([...utc.keys()]).toEqual(['2026-11-19', '2026-11-20']);
    expect(totalMs(utc.get('2026-11-19')!)).toBe(2 * HOUR);
    const cet = spansByDay([span], 60);
    expect(totalMs(cet.get('2026-11-19')!)).toBe(HOUR);
    expect(totalMs(cet.get('2026-11-20')!)).toBe(2 * HOUR);
  });

  it('peak per day uses the local day', () => {
    const lanes = lanesFromSessions([
      session('a', 'a', every(22.5, 23.5)),
      session('b', 'b', every(23, 23.5)),
    ]);
    expect(concurrencyByDay(lanes, 0).get('2026-11-19')!.peak).toBe(2);
    const cet = concurrencyByDay(lanes, 60);
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
    const utc = shippedByDay(events, 0).get('2026-11-19')!;
    expect(utc).toEqual({ commits: 4, files: 6, additions: 110, deletions: 20, prsMerged: 1 });
    const cet = shippedByDay(events, 60);
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
    range: { id: '7d', since: '2026-11-19', until: '2026-11-19', today: '2026-11-19', tzOffset: 0 },
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
