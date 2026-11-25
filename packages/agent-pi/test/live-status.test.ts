// Live status (docs/agent-live-status-plan.md, Phase 3) and the usage
// under-count fix (bug 6), from a synthetic pi session file.
import { describe, expect, it } from 'vitest';
import { piHistoryModule as m } from '../src/history.js';

const SID = '01a20f8c-cb95-71f0-b3c3-935833332d2c';
const PATH = `sessions/--workspace--/2026-11-24T10-00-00-000Z_${SID}.jsonl`;
const L = (o: unknown): string => `${JSON.stringify(o)}\n`;
const usage = (input: number, output: number, total: number) => ({
  input,
  output,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: input + output,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total },
});

const file =
  L({ type: 'session', id: SID, cwd: '/workspace', timestamp: 't0' }) +
  L({ type: 'message', id: 'u1', timestamp: 't1', message: { role: 'user', content: 'fix it' } }) +
  L({
    type: 'message',
    id: 'a1',
    timestamp: 't2',
    message: {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Reading the server.' },
        {
          type: 'toolCall',
          id: 'c1',
          name: 'read',
          arguments: { path: 'server.js', offset: null },
        },
      ],
      usage: usage(100, 10, 0.01),
    },
  }) +
  L({
    type: 'message',
    id: 't1',
    timestamp: 't3',
    message: {
      role: 'toolResult',
      content: [{ type: 'text', text: '...' }],
      usage: usage(5, 0, 0.001),
    },
  }) +
  L({ type: 'compaction', id: 'k1', timestamp: 't4', summary: '...', usage: usage(50, 20, 0.02) }) +
  L({
    type: 'branch_summary',
    id: 'b1',
    timestamp: 't5',
    summary: '...',
    usage: usage(7, 3, 0.003),
  });

describe('pi live status', () => {
  const { records } = m.parse({ path: PATH, offset: 0, bytes: Buffer.from(file) }, {});

  it('sums usage over every entry kind that carries it, with cost', () => {
    const u = records.filter((r) => r.kind === 'usage');
    expect(u.map((r) => (r.kind === 'usage' ? r.messageId : ''))).toEqual(['a1', 't1', 'k1', 'b1']);
    const sum = u.reduce(
      (n, r) => n + (r.kind === 'usage' ? r.inputTokens + r.outputTokens : 0),
      0,
    );
    expect(sum).toBe(195);
    const cost = u.reduce((n, r) => n + (r.kind === 'usage' ? (r.costUsd ?? 0) : 0), 0);
    expect(cost).toBeCloseTo(0.034);
  });

  it('the last toolCall is the working-on line; pi records no context fill', () => {
    expect(records.filter((r) => r.kind === 'activity')).toMatchObject([
      { text: 'read: server.js' },
    ]);
    expect(records.some((r) => r.kind === 'context')).toBe(false);
  });
});
