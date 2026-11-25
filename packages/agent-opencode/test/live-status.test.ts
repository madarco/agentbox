// Live status (docs/agent-live-status-plan.md, Phase 3), from synthetic row
// lines shaped like opencode 1.19's sqlite (session tokens columns, todo table).
import { describe, expect, it } from 'vitest';
import type { HistoryRecord, ParseState } from '@agentbox/core';
import { opencodeHistoryModule as m } from '../src/history.js';

const SID = 'ses_df0703640ffeoCT8e2J77noDiC';
const PATH = `agentbox-history/${SID}.jsonl`;
const L = (t: string, id: string, u: number, row: Record<string, unknown>): string =>
  `${JSON.stringify({ t, id, u, row })}\n`;
const parse = (text: string, state: ParseState = {}) =>
  m.parse({ path: PATH, offset: 0, bytes: Buffer.from(text) }, state);
const todo = (position: number, created: number, status: string, content: string) =>
  L('todo', String(position), created + position, {
    session_id: SID,
    position,
    status,
    content,
    priority: 'high',
    time_created: created,
    time_updated: created + position,
  });
const plans = (records: HistoryRecord[]) =>
  records.flatMap((r) => (r.kind === 'activity' && r.plan ? [r.text] : []));

describe('opencode live status', () => {
  it('the in-progress todo of the newest list is the plan line, cleared when none is', () => {
    const first = parse(
      todo(0, 1000, 'completed', 'add GET /health') +
        todo(1, 1000, 'in_progress', 'add GET /time') +
        todo(2, 1000, 'pending', 'update README'),
    );
    expect(plans(first.records)).toEqual(['add GET /time']);
    // A rewrite to a shorter list with nothing in progress: the old row at
    // position 2 is never re-copied, and must not keep the plan alive.
    const second = parse(todo(0, 2000, 'completed', 'all done'), first.state);
    expect(plans(second.records)).toEqual(['']);
  });

  it('rows of one write stamped a few ms apart are one list', () => {
    const r = parse(todo(0, 5000, 'completed', 'first') + todo(1, 5003, 'in_progress', 'second'));
    // Without the spread, row 1 (created 3ms later) would hide row 0's list.
    expect(plans(r.records)).toEqual(['second']);
    const later = parse(
      L('todo', '0', 5010, {
        session_id: SID,
        position: 0,
        status: 'in_progress',
        content: 'first again',
        priority: 'high',
        time_created: 5002,
        time_updated: 5010,
      }),
      r.state,
    );
    expect(plans(later.records)).toEqual(['first again']);
  });

  it('NULL session token columns emit no totals (the sum is used instead)', () => {
    const records = parse(
      L('session', SID, 5, {
        id: SID,
        title: 'T',
        directory: '/workspace',
        cost: null,
        tokens_input: null,
        tokens_output: null,
        time_updated: 5,
      }),
    ).records;
    expect(records.some((r) => r.kind === 'totals')).toBe(false);
  });

  it('a new prompt ends a plan line whose list was deleted', () => {
    const first = parse(
      L('message', 'msg_u', 1, {
        session_id: SID,
        data: JSON.stringify({ role: 'user', time: { created: 1 } }),
      }) + todo(0, 1000, 'in_progress', 'add GET /time'),
    );
    expect(plans(first.records)).toEqual(['add GET /time']);
    const next = parse(
      L('part', 'prt_u', 3000, {
        session_id: SID,
        message_id: 'msg_u',
        data: JSON.stringify({ type: 'text', text: 'now something else' }),
      }),
      first.state,
    );
    expect(plans(next.records)).toEqual(['']);
  });

  it('a tool part is the working-on line, built from its input, not its output', () => {
    const records = parse(
      L('message', 'msg_a', 1, {
        session_id: SID,
        data: JSON.stringify({ role: 'assistant', time: { created: 1 } }),
      }) +
        L('part', 'prt_1', 2, {
          session_id: SID,
          message_id: 'msg_a',
          data: JSON.stringify({
            type: 'tool',
            tool: 'bash',
            state: {
              status: 'running',
              input: { command: 'sleep 25', description: 'Wait' },
              output: 'x',
            },
          }),
        }),
    ).records;
    expect(records.filter((r) => r.kind === 'activity')).toMatchObject([{ text: 'bash: Wait' }]);
  });

  it('session row tokens are the totals; the last assistant tokens.total is the context', () => {
    const records = parse(
      L('session', SID, 5, {
        id: SID,
        title: 'Health route',
        directory: '/workspace',
        cost: 0.42,
        tokens_input: 900,
        tokens_output: 80,
        tokens_reasoning: 20,
        tokens_cache_read: 4000,
        tokens_cache_write: 10,
        time_updated: 5,
      }) +
        L('message', 'msg_b', 6, {
          session_id: SID,
          data: JSON.stringify({
            role: 'assistant',
            time: { created: 1, completed: 6 },
            cost: 0.1,
            tokens: {
              total: 5010,
              input: 900,
              output: 80,
              reasoning: 20,
              cache: { read: 4000, write: 10 },
            },
          }),
        }),
    ).records;
    expect(records.find((r) => r.kind === 'totals')).toMatchObject({
      inputTokens: 900,
      outputTokens: 100,
      cacheReadTokens: 4000,
      cacheWriteTokens: 10,
      reasoningTokens: 20,
      costUsd: 0.42,
    });
    expect(records.find((r) => r.kind === 'context')).toMatchObject({ tokens: 5010 });
    expect(records.find((r) => r.kind === 'usage')).toMatchObject({ costUsd: 0.1 });
  });
});
