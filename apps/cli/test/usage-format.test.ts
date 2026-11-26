import { describe, expect, it } from 'vitest';
import { usageFixture } from '@agentbox/usage-view';
import {
  parseUsageBy,
  shortRepo,
  usageHeroLines,
  usageKeyCell,
  usageTable,
} from '../src/lib/usage-format.js';
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

describe('usageHeroLines', () => {
  it('prints the window and the hero numbers', () => {
    const lines = usageHeroLines(usageFixture());
    expect(lines[0]).toBe('2026-11-01 to 2026-11-26 (Europe/Rome)');
    const text = lines.join('\n');
    for (const k of [
      'Agent-hours',
      'Wall hours',
      'Speed-up',
      'Peak at once',
      'PRs merged',
      'Commits',
      'Lines',
    ]) {
      expect(text).toContain(k);
    }
    expect(text).toMatch(/Agent-hours\s+612\.0 h/);
    expect(text).toMatch(/Hours saved\s+401\.0 h vs\. one agent at a time/);
  });
});
