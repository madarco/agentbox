// Live status (docs/agent-live-status-plan.md, Phase 3), from synthetic
// rollout lines shaped like the PoC's measurements of codex 0.172.
import { describe, expect, it } from 'vitest';
import type { HistoryRecord } from '@agentbox/core';
import { codexHistoryModule as m } from '../src/history.js';

const SID = '0199aaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const ROLLOUT = `sessions/2026/11/24/rollout-2026-11-24T10-00-00-${SID}.jsonl`;
const INDEX = `agentbox-history/${SID}.index.jsonl`;
const enc = (lines: unknown[]): Buffer =>
  Buffer.from(lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
const parse = (path: string, lines: unknown[]): HistoryRecord[] =>
  m.parse({ path, offset: 0, bytes: enc(lines) }, {}).records;
const line = (type: string, payload: unknown, ts = '2026-11-24T10:00:01Z') => ({
  timestamp: ts,
  type,
  payload,
});

describe('codex live status', () => {
  it('commentary messages and parsed commands are the working-on line; the final answer is not', () => {
    const acts = parse(ROLLOUT, [
      line('response_item', {
        type: 'message',
        role: 'assistant',
        phase: 'commentary',
        content: [{ type: 'output_text', text: 'Checking the routes first.' }],
      }),
      line('event_msg', {
        type: 'exec_command_begin',
        command: ['bash', '-lc', 'rg -n health server.js'],
        parsed_cmd: [{ type: 'search', cmd: 'rg -n health server.js', query: 'health' }],
      }),
      line('response_item', {
        type: 'message',
        role: 'assistant',
        phase: 'final_answer',
        content: [{ type: 'output_text', text: 'Done.' }],
      }),
    ]).flatMap((r) => (r.kind === 'activity' ? [r.text] : []));
    expect(acts).toEqual(['Checking the routes first.', 'search: rg -n health server.js']);
  });

  it('token_count gives cumulative totals and context fill; rate_limits are never projected', () => {
    const records = parse(ROLLOUT, [
      line('event_msg', {
        type: 'token_count',
        info: {
          total_token_usage: {
            input_tokens: 12_000,
            cached_input_tokens: 9_000,
            output_tokens: 700,
            reasoning_output_tokens: 300,
            total_tokens: 12_700,
          },
          last_token_usage: { input_tokens: 6_500, cached_input_tokens: 6_000, output_tokens: 200 },
          model_context_window: 258_400,
        },
        rate_limits: { primary: { used_percent: 42, window_minutes: 300 } },
      }),
    ]);
    expect(records).toEqual([
      {
        kind: 'totals',
        inputTokens: 3_000,
        outputTokens: 700,
        cacheReadTokens: 9_000,
        cacheWriteTokens: 0,
        reasoningTokens: 300,
        ts: '2026-11-24T10:00:01Z',
        at: 0,
      },
      { kind: 'context', tokens: 6_500, window: 258_400, ts: '2026-11-24T10:00:01Z', at: 0 },
    ]);
    expect(JSON.stringify(records)).not.toContain('used_percent');
  });

  it('session_index rows name the session; the last one wins', () => {
    expect(m.identify(Buffer.from(''), INDEX)).toEqual({ sessionId: SID, child: true });
    const row = (n: number, name: string) => ({
      t: 'session_index',
      id: String(n),
      u: n,
      row: { id: SID, thread_name: name, updated_at: `2026-11-24T10:00:0${String(n)}Z`, line: n },
    });
    const titles = parse(INDEX, [row(3, 'Add health route'), row(7, 'renamed')]).map((r) =>
      r.kind === 'meta' ? r.title : r.kind,
    );
    expect(titles).toEqual(['Add health route', 'renamed']);
  });
});
