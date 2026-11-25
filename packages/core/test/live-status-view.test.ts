// Live status, Phase 4: the presentation rules every surface shares.
import { describe, expect, it } from 'vitest';
import {
  contextFillPct,
  formatCostUsd,
  formatTokenCount,
  isLiveActivityState,
  liveActivity,
  usageBreakdown,
  usageSummary,
  usageTotal,
  type AgentLiveUsageView,
} from '../src/index.js';

const U: AgentLiveUsageView = {
  input: 1200,
  output: 3400,
  cacheRead: 1_000_000,
  cacheWrite: 20_000,
  contextTokens: 90_000,
  contextWindow: 200_000,
};

describe('formatTokenCount', () => {
  it.each([
    [0, '0'],
    [950, '950'],
    [999.6, '1k'],
    [1000, '1k'],
    [12_345, '12.3k'],
    [99_960, '100k'],
    [123_456, '123k'],
    [999_600, '1M'],
    [1_234_567, '1.2M'],
    [2_000_000, '2M'],
    [1_234_567_890, '1.23B'],
    [-5, '0'],
    [Number.NaN, '0'],
  ])('%s -> %s', (n, out) => {
    expect(formatTokenCount(n)).toBe(out);
  });
});

describe('liveActivity: only while the agent is busy or needs the user', () => {
  it.each(['working', 'waiting', 'question'])('shows on %s', (state) => {
    expect(isLiveActivityState(state)).toBe(true);
    expect(liveActivity({ state, activity: 'bash: npm test' })).toBe('bash: npm test');
  });
  it.each(['idle', 'error', 'unknown', 'end-plan', 'compacting', undefined])(
    'hides on %s (an idle box ends on its final reply)',
    (state) => {
      expect(liveActivity({ state, activity: 'Done. All tests pass.' })).toBeUndefined();
    },
  );
  it('no activity is no line', () => {
    expect(liveActivity({ state: 'working' })).toBeUndefined();
    expect(liveActivity({ state: 'working', activity: '' })).toBeUndefined();
  });
});

describe('usage', () => {
  it('total, fill and summary', () => {
    expect(usageTotal(U)).toBe(1_024_600);
    expect(contextFillPct(U)).toBe(45);
    expect(usageSummary(U)).toBe('1M tok · 45% ctx');
  });
  it('absent means no data, never zero', () => {
    expect(usageTotal(undefined)).toBeUndefined();
    expect(usageSummary(undefined)).toBeUndefined();
    expect(usageTotal({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })).toBeUndefined();
    expect(contextFillPct({ ...U, contextWindow: undefined })).toBeUndefined();
    expect(contextFillPct({ ...U, contextTokens: undefined })).toBeUndefined();
    expect(usageBreakdown(undefined)).toEqual([]);
  });
  it('cost only when positive', () => {
    expect(formatCostUsd(U)).toBeUndefined();
    expect(formatCostUsd({ ...U, costUsd: 0 })).toBeUndefined();
    expect(formatCostUsd({ ...U, costUsd: 0.004 })).toBe('<$0.01');
    expect(usageSummary({ ...U, costUsd: 1.5 })).toBe('1M tok · 45% ctx · $1.50');
  });
  it('breakdown lists the optional rows only when present', () => {
    expect(usageBreakdown(U).map(([k]) => k)).toEqual([
      'input',
      'output',
      'cache read',
      'cache write',
      'context',
    ]);
    expect(usageBreakdown(U).find(([k]) => k === 'context')?.[1]).toBe('90k / 200k (45%)');
    const full = usageBreakdown({ ...U, reasoning: 500, costUsd: 0.42 });
    expect(full.map(([k]) => k)).toContain('reasoning');
    expect(full.at(-1)).toEqual(['cost', '$0.42']);
  });
});
