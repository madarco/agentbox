import { describe, expect, it } from 'vitest';
import {
  AGENT_IDS,
  PROVIDER_IDS,
  UsageShare,
  UsageStats,
  addDays,
  decodeDaily,
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

  it('only free strings are dates and the handle', () => {
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
      const ok = /^\d{4}-\d{2}-\d{2}$/.test(value) || enums.has(value) || s === 'handle=marco-d';
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
    expect(rows[18]!.byAgent).toEqual(f.daily[18]!.byAgent);
    expect(rows[18]!.commits).toBe(f.daily[18]!.commits);
    expect(decodeWall(share.wall)).toEqual(f.wall);
  });

  it('stays under 64 KB for a full year with every agent and provider', () => {
    const f = usageFixture();
    const split = { tokens: 123_456_789, agentHours: 12.34, commits: 123 };
    const day = f.daily[18]!;
    f.range = { ...f.range, id: 'year', since: '2025-11-27' };
    f.daily = Array.from({ length: 365 }, (_, i) => ({
      ...day,
      date: addDays('2025-11-27', i),
      tokens: 987_654_321,
      byAgent: Object.fromEntries(AGENT_IDS.map((a) => [a, split])),
      byProvider: Object.fromEntries(PROVIDER_IDS.map((p) => [p, split])),
    }));
    f.wall = f.wall.map((w) => ({ ...w, tokens: 987_654_321, agentHours: 123.45 }));
    const big = toShare(f, 'a'.repeat(39));
    expect(decodeDaily(big.daily)).toHaveLength(92);
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
