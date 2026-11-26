import { describe, expect, it } from 'vitest';
import { UsageShare, UsageStats, toShare, usageFixture } from '../src/index.js';

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

  it('stays well under 64 KB for a year', () => {
    expect(new TextEncoder().encode(JSON.stringify(share)).length).toBeLessThan(64 * 1024);
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
    expect(() =>
      UsageShare.parse({ ...good, daily: [{ ...good.daily[0]!, byProject: {} }] }),
    ).toThrow();
  });

  it('rejects an unknown key in a per-agent or per-provider split', () => {
    const split = { tokens: 1, agentHours: 1, commits: 1 };
    const day = { ...good.daily[0]!, byAgent: { ...good.daily[0]!.byAgent, 'my-project': split } };
    expect(() => UsageShare.parse({ ...good, daily: [day] })).toThrow();
    const day2 = { ...good.daily[0]!, byProvider: { 'acme-cloud': split } };
    expect(() => UsageShare.parse({ ...good, daily: [day2] })).toThrow();
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
