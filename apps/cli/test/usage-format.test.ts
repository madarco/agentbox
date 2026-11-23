import { describe, expect, it } from 'vitest';
import { parseUsageBy, shortRepo, usageKeyCell, usageTable } from '../src/lib/usage-format.js';
import type { HubApiUsageGroup } from '../src/control-plane/hub-api-client.js';

const totals = {
  inputTokens: 1200,
  outputTokens: 30,
  cacheReadTokens: 50_000,
  cacheWriteTokens: 0,
  totalTokens: 51_230,
  messages: 3,
  sessions: 2,
};

describe('usage format', () => {
  it('parses --by, refusing unknown and more than two dimensions', () => {
    expect(parseUsageBy('day, agent')).toEqual(['day', 'agent']);
    expect(parseUsageBy('box,box')).toEqual(['box']);
    expect(() => parseUsageBy('cost')).toThrow(/unknown --by "cost"/);
    expect(() => parseUsageBy('day,agent,box')).toThrow(/at most two/);
  });

  it('shortens repo URLs', () => {
    expect(shortRepo('git@github.com:o/r.git')).toBe('o/r');
    expect(shortRepo('https://github.com/o/r')).toBe('o/r');
    expect(shortRepo('local:pc:/x')).toBe('local:pc:/x');
  });

  it('names keys by their label and renders a total row', () => {
    const g: HubApiUsageGroup = {
      keys: { box: 'abc123', session: 'claude:0123456789abcdef' },
      labels: { box: 'smoke', session: 'Fix the build' },
      ...totals,
    };
    expect(usageKeyCell('box', g)).toBe('smoke');
    expect(usageKeyCell('session', g)).toBe('01234567 Fix the build');
    expect(usageKeyCell('agent', g)).toBe('-');
    const t = usageTable(['box'], [g], totals);
    expect(t.headers[0]).toBe('BOX');
    expect(t.rows).toEqual([
      ['smoke', '1.2k', '30', '50k', '0', '51k', '3', '2'],
      ['total', '1.2k', '30', '50k', '0', '51k', '3', '2'],
    ]);
    expect(usageTable([], [], totals).rows).toHaveLength(1);
  });
});
