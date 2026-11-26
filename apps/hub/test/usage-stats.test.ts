import { describe, expect, it, beforeEach } from 'vitest';
import type { ActivityEvent, ActivityQuery } from '@agentbox/relay';
import { UsageStats } from '@agentbox/usage-view';
import type { HistoryRecord } from '@agentbox/core';
import type { HistoryRepo } from '../lib/backend/history';
import { openSqliteHistoryRepo } from '../lib/history-sqlite';
import {
  boxRunsOf,
  clearUsageStatsCache,
  computeUsageStats,
  countedPushes,
  parseUsageStatsQuery,
  usageStats,
} from '../lib/backend/usage-stats';

const MIN = 60_000;
const HOUR = 60 * MIN;
/** 2026-11-20T00:00Z plus `h` hours. */
const at = (h: number): number => Date.UTC(2026, 10, 20) + h * HOUR;
const iso = (ms: number): string => new Date(ms).toISOString();
const NOW = at(30); // 2026-11-21T06:00Z

let fileSeq = 0;
async function session(
  repo: HistoryRepo,
  o: {
    id: string;
    agent?: string;
    boxId: string | null;
    provider?: string;
    account?: string;
    project?: string;
    turns: number[];
    tokens?: Array<{ at: number; n: number }>;
  },
): Promise<string> {
  const agent = o.agent ?? 'claude';
  const key = `${agent}:${o.id}`;
  await repo.upsertSession({
    key,
    agent,
    sessionId: o.id,
    boxId: o.boxId,
    boxName: o.boxId ? `${o.boxId}-name` : null,
    provider: o.boxId ? (o.provider ?? 'docker') : null,
    hostId: o.boxId ? null : 'pc-1',
    projectRepoUrl: o.project ?? 'https://github.com/acme/api.git',
    account: o.account ?? `${agent}/default`,
    parentSessionId: null,
    firstTs: null,
    lastTs: null,
    title: null,
    turns: 0,
    inputTokens: 0,
    outputTokens: 0,
    parserVersion: 1,
    createdAt: NOW,
    updatedAt: NOW,
  });
  const file = await repo.createFile({
    originKey: `o${String(++fileSeq)}`,
    agent,
    path: `/x/${o.id}.jsonl`,
    sessionKey: key,
    generation: 0,
    offset: 0,
    sha256: '',
    parseState: null,
    child: false,
    updatedAt: NOW,
  });
  const records: HistoryRecord[] = o.turns.map((t, i) => ({
    kind: 'turn',
    role: i % 2 ? 'assistant' : 'user',
    text: 'secret prompt text',
    ts: iso(t),
    at: i,
  }));
  for (const [i, t] of (o.tokens ?? []).entries()) {
    records.push({
      kind: 'usage',
      messageId: `m${String(i)}`,
      model: 'x',
      inputTokens: t.n,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      ts: iso(t.at),
      at: 10_000 + i,
    });
  }
  await repo.insertRecords(key, file.id, records);
  return key;
}

/** Turns every 2 minutes from `fromH` to `toH`. */
const every = (fromH: number, toH: number): number[] => {
  const out: number[] = [];
  for (let t = at(fromH); t <= at(toH); t += 2 * MIN) out.push(t);
  return out;
};

function fakeLedger(events: ActivityEvent[]) {
  const calls: ActivityQuery[] = [];
  return {
    calls,
    list: async (q: ActivityQuery = {}) => {
      calls.push(q);
      return events
        .filter((e) => {
          const t = Date.parse(e.at);
          return (
            (q.sinceMs === undefined || t >= q.sinceMs) &&
            (q.untilMs === undefined || t < q.untilMs)
          );
        })
        .slice(0, q.limit ?? 1000);
    },
  };
}

let seq = 0;
const ev = (
  type: ActivityEvent['type'],
  t: number,
  extra: Partial<ActivityEvent> = {},
): ActivityEvent => ({
  id: `e${String(++seq)}`,
  type,
  at: iso(t),
  source: 'live',
  ...extra,
});

const q = parseUsageStatsQuery({ since: '2026-11-20', until: '2026-11-21', tz: 'UTC' }, NOW);
if (!q.ok) throw new Error(q.message);
const window = q.query;

beforeEach(() => clearUsageStatsCache());

describe('parseUsageStatsQuery', () => {
  it('defaults to the last 30 days in UTC, and names the range by its length', () => {
    const r = parseUsageStatsQuery({}, NOW);
    expect(r).toEqual({
      ok: true,
      query: {
        id: 'month',
        since: '2026-10-23',
        until: '2026-11-21',
        today: '2026-11-21',
        tz: 'UTC',
      },
    });
    const y = parseUsageStatsQuery({ since: '365d', tz: 'Europe/Rome' }, NOW);
    expect(y.ok && y.query.id).toBe('year');
  });

  it('refuses a year 9999, a window over a year, a bad zone and free text', () => {
    const bad = [
      { since: '2026-01-01', until: '9999-12-31' },
      { since: '2024-01-01', until: '2026-01-01' },
      { since: '400d' },
      { since: 'yesterday' },
      { since: '2026-11-20', until: '2026-11-19' },
      { since: '2026-12-20', until: '2026-12-21' },
      { tz: '+01:00' },
      { tz: 'Mars/Olympus' },
      { tz: 'x'.repeat(200) },
      { range: 'decade' },
      { subscription: 'no slash' },
      { until: '2026-13-01' },
      { until: '2026-01-32' },
      { since: '2026-02-30', until: '2026-03-02' },
    ];
    for (const raw of bad)
      expect(parseUsageStatsQuery(raw, NOW).ok, JSON.stringify(raw)).toBe(false);
  });

  it('keeps today inside a past window', () => {
    const r = parseUsageStatsQuery({ since: '2026-11-01', until: '2026-11-07' }, NOW);
    expect(r.ok && r.query.today).toBe('2026-11-07');
  });
});

describe('countedPushes', () => {
  it('drops a host-only landing a published push of the same box follows', () => {
    const rows = [
      ev('git.push', at(1), { boxId: 'a', hostOnly: true, commits: 3 }),
      ev('git.push', at(2), { boxId: 'a', commits: 3 }),
      ev('git.push', at(3), { boxId: 'b', hostOnly: true, commits: 2 }),
      ev('git.push', at(4), { boxId: 'a', hostOnly: true, commits: 1 }),
    ];
    expect(countedPushes(rows).map((e) => e.commits)).toEqual([3, 2, 1]);
  });

  it('keeps a landing when the push after it published nothing (up to date)', () => {
    const rows = [
      ev('git.push', at(1), { boxId: 'a', hostOnly: true, commits: 5 }),
      ev('git.push', at(2), { boxId: 'a' }),
    ];
    expect(countedPushes(rows).reduce((n, e) => n + (e.commits ?? 0), 0)).toBe(5);
  });
});

describe('boxRunsOf', () => {
  it('runs from ready to stop, a pause ends a run, a resume starts one, a lone stop counts nothing', () => {
    const rows = [
      ev('box.ready', at(1), { boxId: 'a' }),
      ev('box.paused', at(2), { boxId: 'a' }),
      ev('box.resumed', at(3), { boxId: 'a' }),
      ev('box.destroyed', at(4), { boxId: 'a' }),
      ev('box.stopped', at(5), { boxId: 'b' }),
      ev('box.started', at(6), { boxId: 'c' }),
    ];
    const runs = boxRunsOf(rows, () => 'docker', at(8));
    expect(runs.map((r) => [r.boxId, (r.end - r.start) / HOUR])).toEqual([
      ['a', 1],
      ['a', 1],
      ['c', 2],
    ]);
  });
});

describe('computeUsageStats', () => {
  it('counts overlap, peak, commits and lines, with host sessions as "host"', async () => {
    const repo = await openSqliteHistoryRepo(':memory:');
    // Box a: 09:00-12:00. Box b: 10:00-11:00, two sessions in one box. PC: 11:30-12:30.
    await session(repo, {
      id: 's1',
      boxId: 'a',
      turns: every(9, 12),
      tokens: [{ at: at(9.5), n: 1000 }],
    });
    await session(repo, { id: 's2', boxId: 'b', provider: 'hetzner', turns: every(10, 11) });
    await session(repo, {
      id: 's3',
      boxId: 'b',
      provider: 'hetzner',
      agent: 'codex',
      turns: every(10, 10.5),
    });
    await session(repo, { id: 's4', boxId: null, turns: every(11.5, 12.5) });
    const ledger = fakeLedger([
      ev('box.created', at(8.9), {
        boxId: 'a',
        managerId: 'm1',
        projectKey: 'github.com/acme/api',
      }),
      ev('box.ready', at(9), { boxId: 'a', managerId: 'm1', provider: 'docker', agent: 'claude' }),
      ev('box.ready', at(10), {
        boxId: 'b',
        managerId: 'm1',
        provider: 'hetzner',
        agent: 'claude',
      }),
      ev('git.push', at(11), {
        boxId: 'a',
        commits: 4,
        filesChanged: 3,
        additions: 120,
        deletions: 7,
      }),
      // Up to date: a row with no counts.
      ev('git.push', at(11.1), { boxId: 'a' }),
      ev('git.push', at(11.2), { boxId: 'b', hostOnly: true, commits: 2, additions: 10 }),
      ev('pr.merged', at(12), { boxId: 'a', pr: { repo: 'acme/api', number: 7 } }),
      ev('pr.merged', at(12.1), { boxId: 'a', pr: { repo: 'acme/api', number: 7 }, id: 'dup' }),
      ev('box.stopped', at(13), { boxId: 'a' }),
    ]);
    await repo.refreshSpans(1000);
    const stats = await computeUsageStats({ history: repo, ledger, now: () => NOW }, window);
    expect(() => UsageStats.parse(stats)).not.toThrow();
    // a 3h1m + b 1h1m + host 1h1m.
    expect(stats.hero.agentHours).toBeCloseTo(5.1, 1);
    // 09:00 to 12:31.
    expect(stats.hero.wallHours).toBeCloseTo(3.5, 1);
    // a, b, and box a still runs at 11:30 with the PC session.
    expect(stats.hero.peakAtOnce).toBe(2);
    expect(stats.hero.commits).toBe(6);
    expect(stats.hero.additions).toBe(130);
    expect(stats.hero.prsMerged).toBe(1);
    expect(stats.providers.map((p) => p.id).sort()).toEqual(['docker', 'hetzner', 'host']);
    // Both boxes ran under manager m1: one session of 2 boxes; the PC session is its own.
    expect(stats.sessions[0]!.boxes).toBe(2);
    expect(stats.kpis.boxHours.value).toBeCloseTo(4.1 + (NOW - at(10)) / HOUR, 0);
    expect(stats.kpis.peak.runningNow).toBe(1);
    expect(stats.daily.find((d) => d.date === '2026-11-20')!.tokens).toBe(1000);
    // No transcript text reaches the stats.
    expect(JSON.stringify(stats)).not.toContain('secret prompt text');
  });

  it('shows no live counters on a past window', async () => {
    const ledger = fakeLedger([ev('box.ready', at(1), { boxId: 'a' })]);
    const past = parseUsageStatsQuery({ since: '2026-11-19', until: '2026-11-20' }, NOW);
    if (!past.ok) throw new Error(past.message);
    const stats = await computeUsageStats({ history: null, ledger, now: () => NOW }, past.query);
    expect(stats.kpis.peak.runningNow).toBe(0);
  });

  it('filters by subscription', async () => {
    const repo = await openSqliteHistoryRepo(':memory:');
    await session(repo, { id: 's1', boxId: 'a', account: 'claude/work', turns: every(9, 10) });
    await session(repo, { id: 's2', boxId: 'b', account: 'claude/home', turns: every(9, 11) });
    const ledger = fakeLedger([
      ev('git.push', at(10), { boxId: 'a', account: 'claude/work', commits: 1 }),
      ev('git.push', at(10), { boxId: 'b', account: 'claude/home', commits: 5 }),
    ]);
    await repo.refreshSpans(1000);
    const stats = await computeUsageStats(
      { history: repo, ledger, now: () => NOW },
      { ...window, subscription: 'claude/work' },
    );
    expect(stats.hero.agentHours).toBeCloseTo(1, 1);
    expect(stats.hero.commits).toBe(1);
  });

  it('reads only stored intervals; the refresh brings new turns in', async () => {
    const repo = await openSqliteHistoryRepo(':memory:');
    await session(repo, { id: 's1', boxId: 'a', turns: every(9, 10) });
    const win = { sinceMs: at(0), untilMs: at(24), idleGapMs: 10 * MIN };
    expect(await repo.usageSpans(win)).toEqual([]);
    expect(await repo.refreshSpans(1000)).toBe(1);
    expect(await repo.usageSpans(win)).toHaveLength(1);
    expect(await repo.refreshSpans(1000)).toBe(0);
  });

  it('keeps the hours of a purged session', async () => {
    const repo = await openSqliteHistoryRepo(':memory:');
    const key = await session(repo, {
      id: 's1',
      boxId: 'a',
      turns: [...every(9, 10), ...every(11, 12)],
    });
    await repo.refreshSpans(1000);
    const before = await computeUsageStats({ history: repo, ledger: null, now: () => NOW }, window);
    await repo.purgeSession(key, NOW);
    const after = await computeUsageStats({ history: repo, ledger: null, now: () => NOW }, window);
    expect(after.hero.agentHours).toBe(before.hero.agentHours);
    expect(after.daily).toEqual(before.daily);
  });

  it('buckets days in the zone asked for', async () => {
    const repo = await openSqliteHistoryRepo(':memory:');
    // 23:30-23:50 UTC is 00:30-00:50 the next day in Rome.
    await session(repo, { id: 's1', boxId: 'a', turns: every(23.5, 23.8) });
    const rome = parseUsageStatsQuery(
      { since: '2026-11-20', until: '2026-11-21', tz: 'Europe/Rome' },
      NOW,
    );
    if (!rome.ok) throw new Error(rome.message);
    await repo.refreshSpans(1000);
    const stats = await computeUsageStats(
      { history: repo, ledger: null, now: () => NOW },
      rome.query,
    );
    expect(stats.daily.find((d) => d.date === '2026-11-21')!.agentHours).toBeGreaterThan(0);
    expect(stats.daily.find((d) => d.date === '2026-11-20')!.agentHours).toBe(0);
  });

  it('pages a ledger past one read, and caches a window for a minute', async () => {
    const rows = Array.from({ length: 50_010 }, (_, i) =>
      ev('git.push', at(1) + i, { boxId: 'a', commits: 1 }),
    );
    const ledger = fakeLedger(rows);
    let now = NOW;
    const deps = { history: null, ledger, now: () => now };
    const a = await usageStats(deps, window);
    expect(a.hero.commits).toBe(50_010);
    const calls = ledger.calls.length;
    expect(calls).toBeGreaterThan(1);
    await usageStats(deps, window);
    expect(ledger.calls.length).toBe(calls);
    now += 61_000;
    await usageStats(deps, window);
    expect(ledger.calls.length).toBeGreaterThan(calls);
  });
});
