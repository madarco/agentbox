import { describe, expect, it } from 'vitest';
import { agoText, rankInUse, resetText, topPct, type Account } from '../lib/accounts-client';

const acc = (id: string, boxes: string[], pcts?: number[], atLimit = false): Account => ({
  agent: 'claude',
  id,
  kind: 'login',
  hasSecret: true,
  boxes,
  ...(pcts
    ? {
        limits: {
          windows: pcts.map((pct, i) => ({ id: String(i), label: String(i), pct })),
          atLimit,
          updatedAt: '2026-11-25T10:00:00Z',
          source: 'usage-api' as const,
        },
      }
    : {}),
});

describe('top-bar ranking', () => {
  it('keeps in-use subscriptions only, most constrained first, no data last', () => {
    const ranked = rankInUse([
      acc('idle', [], [99]),
      acc('nodata', ['b1']),
      acc('low', ['b2'], [10, 30]),
      acc('full', ['b3'], [100], true),
      acc('high', ['b4'], [85]),
    ]);
    expect(ranked.map((a) => a.id)).toEqual(['full', 'high', 'low', 'nodata']);
  });

  it('topPct is the highest window, 0 with no data', () => {
    expect(topPct(acc('a', [], [12, 64]))).toBe(64);
    expect(topPct(acc('a', []))).toBe(0);
  });

  it('reset and age texts', () => {
    const now = Date.parse('2026-11-25T10:00:00Z');
    expect(resetText(undefined, now)).toBeUndefined();
    expect(resetText('2026-11-25T10:20:00Z', now)).toBe('resets in 20 min');
    expect(resetText('2026-11-25T13:00:00Z', now)).toBe('resets in 3 h');
    expect(resetText('2026-11-25T09:00:00Z', now)).toBe('resets now');
    expect(resetText('2026-11-28T09:00:00Z', now)).toMatch(/^resets \S+ /);
    expect(agoText('2026-11-25T09:58:00Z', now)).toBe('updated 2 min ago');
    expect(agoText('2026-11-25T09:59:50Z', now)).toBe('updated just now');
  });
});
