import { describe, expect, it } from 'vitest';
import {
  AGENT_IDS,
  PROVIDER_IDS,
  UsageRange,
  UsageShare,
  UsageStats,
  SHARE_LIMITS,
  SHARE_MAX_BYTES,
  addDays,
  canonicalTimeZone,
  daysBetween,
  isTimeZone,
  decodeDaily,
  parseShareBody,
  decodeWall,
  toShare,
  usageFixture,
} from '../src/index.js';

describe('fixture', () => {
  it('is a valid UsageStats', () => {
    expect(() => UsageStats.parse(usageFixture())).not.toThrow();
  });

  it('reproduces the mockup numbers', () => {
    const f = usageFixture();
    expect(f.hero.agentHours).toBe(612);
    expect(f.hero.peakAtOnce).toBe(9);
    expect(f.daily).toHaveLength(26);
    expect(f.daily.find((d) => d.date === '2026-11-19')!.peak).toBe(9);
    expect(f.gantt[0]!.lanes).toHaveLength(13);
    expect(f.wall[0]!.date).toBe('2025-11-23');
    expect(f.wall.at(-1)!.date).toBe('2026-11-26');
  });
});

describe('toShare', () => {
  const share = toShare(usageFixture(), 'marco-d');

  it('is a valid, strict UsageShare', () => {
    expect(() => UsageShare.parse(share)).not.toThrow();
  });

  it('carries no names', () => {
    const json = JSON.stringify(share);
    for (const name of [
      'fix-account-switch',
      'agentbox#486',
      'Subscriptions: switch',
      'this Mac',
      'checkout-api',
      'personal',
    ]) {
      expect(json).not.toContain(name);
    }
    expect(share.gantt[0]!.lanes[0]).toEqual({
      agent: 'claude',
      provider: 'hetzner',
      intervals: [[8.5, 15.2]],
      merged: true,
    });
    expect(Object.keys(share.sessions[0]!).sort()).toEqual([
      'agent',
      'boxes',
      'minutes',
      'peak',
      'provider',
      'prsMerged',
    ]);
  });

  it('only free strings are dates, the handle and a listed time zone', () => {
    const strings: string[] = [];
    const walk = (v: unknown, key: string): void => {
      if (typeof v === 'string') strings.push(`${key}=${v}`);
      else if (Array.isArray(v)) v.forEach((x) => walk(x, key));
      else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, k);
    };
    walk(share, '');
    const enums = new Set([
      'claude',
      'codex',
      'opencode',
      'pi',
      'openclaw',
      'other',
      'docker',
      'hetzner',
      'daytona',
      'vercel',
      'e2b',
      'remote-docker',
      'digitalocean',
      'host',
      'month',
    ]);
    for (const s of strings) {
      const value = s.slice(s.indexOf('=') + 1);
      const ok =
        /^\d{4}-\d{2}-\d{2}$/.test(value) ||
        enums.has(value) ||
        s === 'handle=marco-d' ||
        (s.startsWith('tz=') && isTimeZone(value));
      expect(ok, s).toBe(true);
    }
  });

  it('drops the live counters', () => {
    expect(share.kpis.peak.runningNow).toBe(0);
    expect(share.kpis.prs.waitingReview).toBe(0);
  });

  it('round-trips the daily rows and the wall', () => {
    const f = usageFixture();
    const rows = decodeDaily(share.daily);
    expect(rows).toHaveLength(f.daily.length);
    for (const [k, v] of Object.entries(f.daily[18]!.byAgent)) {
      const got = rows[18]!.byAgent[k as keyof (typeof rows)[18]['byAgent']]!;
      expect(got.tokens).toBe(v!.tokens);
      // The share keeps one decimal of hours.
      expect(Math.abs(got.agentHours - v!.agentHours)).toBeLessThanOrEqual(0.05 + 1e-9);
    }
    expect(rows[18]!.commits).toBe(f.daily[18]!.commits);
    expect(decodeWall(share.wall)).toEqual(f.wall);
  });

  it('stays under 64 KB for a full year with every agent and provider', () => {
    const f = usageFixture();
    const split = { tokens: 123_456_789, agentHours: 12.34, commits: 123 };
    const day = f.daily[18]!;
    f.range = { ...f.range, id: 'year', since: '2025-11-27', until: '2026-11-26' };
    f.daily = Array.from({ length: 365 }, (_, i) => ({
      ...day,
      date: addDays('2025-11-27', i),
      tokens: 987_654_321,
      byAgent: Object.fromEntries(AGENT_IDS.map((a) => [a, split])),
      byProvider: Object.fromEntries(PROVIDER_IDS.map((p) => [p, split])),
    }));
    f.wall = f.wall.map((w) => ({ ...w, tokens: 987_654_321, agentHours: 123.45 }));
    const big = toShare(f, 'a'.repeat(39));
    expect(decodeDaily(big.daily)).toHaveLength(SHARE_LIMITS.dailyDays);
    const bytes = new TextEncoder().encode(JSON.stringify(big)).length;
    expect(bytes).toBeLessThan(64 * 1024);
  });

  it('rejects a bad handle', () => {
    expect(() => toShare(usageFixture(), 'Marco D')).toThrow();
    expect(() => toShare(usageFixture(), 'a'.repeat(40))).toThrow();
  });
});

describe('UsageShare is strict', () => {
  const good = toShare(usageFixture(), 'me');

  it('rejects unknown keys at any depth', () => {
    expect(() => UsageShare.parse({ ...good, note: 'hi' })).toThrow();
    const lane = { ...good.gantt[0]!.lanes[0]!, box: 'secret' };
    expect(() =>
      UsageShare.parse({ ...good, gantt: [{ ...good.gantt[0]!, lanes: [lane] }] }),
    ).toThrow();
    expect(() => UsageShare.parse({ ...good, daily: { ...good.daily, byProject: {} } })).toThrow();
  });

  it('rejects columns of different lengths', () => {
    expect(() =>
      UsageShare.parse({ ...good, daily: { ...good.daily, commits: good.daily.commits.slice(1) } }),
    ).toThrow();
    const claude = good.daily.byAgent.claude!;
    expect(() =>
      UsageShare.parse({
        ...good,
        daily: { ...good.daily, byAgent: { claude: { ...claude, tokens: [1] } } },
      }),
    ).toThrow();
    expect(() => UsageShare.parse({ ...good, wall: { ...good.wall, peak: [] } })).toThrow();
  });

  it('rejects an unknown key in a per-agent or per-provider split', () => {
    const n = good.daily.tokens.length;
    const cols = {
      tokens: Array(n).fill(1),
      agentHours: Array(n).fill(1),
      commits: Array(n).fill(1),
    };
    const d1 = { ...good.daily, byAgent: { ...good.daily.byAgent, 'my-project': cols } };
    expect(() => UsageShare.parse({ ...good, daily: d1 })).toThrow();
    const d2 = { ...good.daily, byProvider: { 'acme-cloud': cols } };
    expect(() => UsageShare.parse({ ...good, daily: d2 })).toThrow();
  });

  it('rejects a free string where an enum goes', () => {
    const s = { ...good.sessions[0]!, agent: 'buy-my-stuff' };
    expect(() => UsageShare.parse({ ...good, sessions: [s] })).toThrow();
  });

  it('rejects out-of-range numbers and oversized arrays', () => {
    expect(() => UsageShare.parse({ ...good, hero: { ...good.hero, commits: -1 } })).toThrow();
    expect(() => UsageShare.parse({ ...good, hero: { ...good.hero, commits: 1.5 } })).toThrow();
    expect(() => UsageShare.parse({ ...good, hero: { ...good.hero, agentHours: 1e12 } })).toThrow();
    const many = Array.from({ length: 30 }, () => good.sessions[0]!);
    expect(() => UsageShare.parse({ ...good, sessions: many })).toThrow();
  });

  it('rejects a malformed date', () => {
    expect(() =>
      UsageShare.parse({ ...good, range: { ...good.range, since: 'yesterday' } }),
    ).toThrow();
  });
});

describe('range bounds', () => {
  const good = toShare(usageFixture(), 'me');
  const withRange = (r: Partial<typeof good.range>) => ({
    ...good,
    range: { ...good.range, ...r },
  });

  it('rejects a far-future range at once instead of hanging a renderer', () => {
    const t0 = Date.now();
    const r = UsageShare.safeParse(withRange({ today: '9999-12-31', until: '9999-12-31' }));
    expect(r.success).toBe(false);
    expect(UsageShare.safeParse(withRange({ until: '9000-01-01' })).success).toBe(false);
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it('requires since <= today <= until, at most a year, between 2020 and 2100', () => {
    expect(UsageShare.safeParse(withRange({ since: '2026-11-27' })).success).toBe(false);
    expect(UsageShare.safeParse(withRange({ today: '2026-12-01' })).success).toBe(false);
    expect(UsageShare.safeParse(withRange({ since: '2025-11-26' })).success).toBe(false);
    expect(UsageShare.safeParse(withRange({ since: '2025-11-30' })).success).toBe(true);
    expect(UsageShare.safeParse(withRange({ since: '2019-12-31' })).success).toBe(false);
    const stats = usageFixture();
    expect(
      UsageStats.safeParse({ ...stats, range: { ...stats.range, until: '2101-01-01' } }).success,
    ).toBe(false);
  });

  it('rejects dates outside 2020-2100 anywhere', () => {
    expect(
      UsageShare.safeParse({ ...good, wall: { ...good.wall, start: '1999-01-01' } }).success,
    ).toBe(false);
    expect(
      UsageShare.safeParse({ ...good, streaks: { ...good.streaks, firstDate: '2200-01-01' } })
        .success,
    ).toBe(false);
  });
});

describe('time zone', () => {
  const range = { id: '7d', since: '2026-11-20', until: '2026-11-26', today: '2026-11-26' };

  it('accepts listed IANA zones and UTC', () => {
    for (const tz of ['Europe/Rome', 'America/New_York', 'UTC', 'Asia/Tokyo']) {
      expect(UsageRange.safeParse({ ...range, tz }).success, tz).toBe(true);
    }
  });

  it('refuses free text, offsets, a wrong case and an oversized name', () => {
    for (const tz of [
      '',
      'europe/rome',
      '+01:00',
      'CET-1',
      'hello world',
      'Europe/' + 'x'.repeat(80),
    ]) {
      expect(isTimeZone(tz), tz).toBe(false);
    }
    expect(UsageRange.safeParse({ ...range, tz: 'Mars/Olympus' }).success).toBe(false);
    expect(UsageRange.safeParse({ ...range, tzOffset: 60 }).success).toBe(false);
  });

  it('canonicalizes what Intl accepts, and nothing else', () => {
    expect(canonicalTimeZone('utc')).toBe('UTC');
    expect(canonicalTimeZone('Europe/Rome')).toBe('Europe/Rome');
    expect(isTimeZone(canonicalTimeZone('Asia/Kolkata')!)).toBe(true);
    expect(canonicalTimeZone('Mars/Olympus')).toBeNull();
    expect(canonicalTimeZone('x'.repeat(65))).toBeNull();
  });
});

describe('daysBetween', () => {
  it('builds the days, and refuses a run that would never end', () => {
    expect(daysBetween('2026-02-27', '2026-03-01')).toEqual([
      '2026-02-27',
      '2026-02-28',
      '2026-03-01',
    ]);
    expect(daysBetween('2026-03-01', '2026-02-27')).toEqual([]);
    expect(() => daysBetween('2026-01-01', '9999-12-31')).toThrow(RangeError);
    expect(() => daysBetween('2026-01-01', 'soon')).toThrow(RangeError);
  });
});

describe('share size', () => {
  it('a share with every array full and every number at its longest is under 64 KB', () => {
    const D = SHARE_LIMITS.dailyDays;
    const fill = <T>(n: number, v: T): T[] => Array.from({ length: n }, () => v);
    const split = {
      tokens: fill(D, 9_999_999_999),
      agentHours: fill(D, 1999.9),
      commits: fill(D, 99_999),
    };
    const lane = {
      agent: 'opencode' as const,
      provider: 'remote-docker' as const,
      intervals: fill(SHARE_LIMITS.intervalsPerLane, [47.9, 47.9] as [number, number]),
      merged: false,
    };
    const base = toShare(usageFixture(), 'a'.repeat(39));
    const max = {
      ...base,
      range: {
        id: 'year' as const,
        since: '2025-11-27',
        until: '2026-11-26',
        today: '2026-11-26',
        // The longest zone name the runtime lists: the share at its largest.
        tz: Intl.supportedValuesOf('timeZone').reduce((a, b) => (b.length > a.length ? b : a)),
      },
      daily: {
        start: '2026-09-26',
        tokens: fill(D, 9_999_999_999),
        agentHours: fill(D, 1999.9),
        wallHours: fill(D, 1999.9),
        boxHours: fill(D, 1999.9),
        peak: fill(D, 999),
        avgAtOnce: fill(D, 998.9),
        commits: fill(D, 99_999),
        prsMerged: fill(D, 99_999),
        additions: fill(D, 9_999_999),
        deletions: fill(D, 9_999_999),
        files: fill(D, 99_999),
        byAgent: Object.fromEntries(AGENT_IDS.map((a) => [a, split])),
        byProvider: Object.fromEntries(PROVIDER_IDS.map((p) => [p, split])),
      },
      wall: {
        start: '2025-11-21',
        all: fill(371, 99_999),
        peak: fill(371, 999),
        commits: fill(371, 99_999),
        prs: fill(371, 99_999),
        agentHours: fill(371, 1999.9),
        tokens: fill(371, 9_999_999_999),
      },
      gantt: ['2026-11-24', '2026-11-25', '2026-11-26'].map((date) => ({
        date,
        lanes: fill(SHARE_LIMITS.lanes, lane),
      })),
      sessions: fill(SHARE_LIMITS.sessions, {
        agent: 'opencode' as const,
        provider: 'remote-docker' as const,
        boxes: 99_999,
        peak: 999,
        prsMerged: 99_999,
        minutes: 9_999_999,
      }),
      punchcard: fill(7, fill(24, 99_998.9)),
      providers: PROVIDER_IDS.map((id) => ({ id, hours: 999_998.9, boxes: 99_999 })),
    };
    const parsed = UsageShare.parse(max);
    const bytes = new TextEncoder().encode(JSON.stringify(parsed)).length;
    expect(bytes).toBeLessThan(SHARE_MAX_BYTES);
  });

  it('rejects hours with more than one decimal', () => {
    const good = toShare(usageFixture(), 'me');
    const agentHours = good.daily.agentHours.map(() => 1.23456789);
    expect(UsageShare.safeParse({ ...good, daily: { ...good.daily, agentHours } }).success).toBe(
      false,
    );
  });

  it('toShare cuts lanes and merges intervals to the share limits', () => {
    const f = usageFixture();
    const many: [number, number][] = Array.from({ length: 20 }, (_, i) => [i, i + 0.5]);
    f.gantt[0]!.lanes = Array.from({ length: 30 }, (_, i) => ({
      agent: 'claude' as const,
      provider: 'docker' as const,
      intervals: i === 0 ? many : [[i % 20, (i % 20) + 1 + i / 100]],
      box: `b${i}`,
      pr: null,
    }));
    const share = toShare(f, 'me');
    const lanes = share.gantt[0]!.lanes;
    expect(lanes).toHaveLength(SHARE_LIMITS.lanes);
    const merged = lanes.find((l) => l.intervals.length > 1)!;
    expect(merged.intervals).toHaveLength(SHARE_LIMITS.intervalsPerLane);
    expect(merged.intervals[0]![0]).toBe(0);
    expect(merged.intervals.at(-1)![1]).toBe(19.5);
  });
});

describe('parseShareBody', () => {
  const body = JSON.stringify(toShare(usageFixture(), 'me'));

  it('returns the parsed share', () => {
    expect(parseShareBody(body).handle).toBe('me');
  });

  it('rejects __proto__, constructor and prototype keys at any depth', () => {
    const at = (needle: string, inject: string) => body.replace(needle, `${needle}${inject},`);
    const p = '"__proto__":{"msg":"FREE TEXT http://spam.example"}';
    expect(() => parseShareBody(body.replace('{', `{${p},`))).toThrow(/forbidden key/);
    expect(() => parseShareBody(at('"hero":{', p))).toThrow(/forbidden key/);
    expect(() => parseShareBody(at('"byAgent":{', p))).toThrow(/forbidden key/);
    expect(() => parseShareBody(at('"hero":{', '"constructor":1'))).toThrow(/forbidden key/);
    expect(() => parseShareBody(at('"hero":{', '"prototype":1'))).toThrow(/forbidden key/);
  });

  it('rejects a raw body over 64 KB, even if the padding is whitespace', () => {
    expect(() => parseShareBody(body + ' '.repeat(SHARE_MAX_BYTES))).toThrow(/over/);
  });

  it('rejects malformed JSON and invalid shares', () => {
    expect(() => parseShareBody('{')).toThrow();
    expect(() => parseShareBody('{"handle":"me"}')).toThrow();
  });
});

describe('uniqueness', () => {
  const good = toShare(usageFixture(), 'me');

  it('rejects a repeated provider or Gantt day', () => {
    expect(
      UsageShare.safeParse({ ...good, providers: [good.providers[0]!, good.providers[0]!] })
        .success,
    ).toBe(false);
    expect(UsageShare.safeParse({ ...good, gantt: [good.gantt[0]!, good.gantt[0]!] }).success).toBe(
      false,
    );
    const stats = usageFixture();
    expect(
      UsageStats.safeParse({ ...stats, providers: [stats.providers[0]!, stats.providers[0]!] })
        .success,
    ).toBe(false);
    expect(
      UsageStats.safeParse({ ...stats, daily: [stats.daily[0]!, stats.daily[0]!] }).success,
    ).toBe(false);
  });
});
