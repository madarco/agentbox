import { describe, expect, it } from 'vitest';
import { codexHistoryModule } from '../src/history.js';

const SID = '019a0000-1111-7222-8333-444444444444';
const PATH = `sessions/2026/11/23/rollout-2026-11-23T10-00-00-${SID}.jsonl`;
const L = (o: unknown): string => `${JSON.stringify(o)}\n`;

const rollout =
  L({
    timestamp: '2026-11-23T10:00:00Z',
    type: 'session_meta',
    payload: { id: SID, session_id: SID, cwd: '/workspace', source: 'cli' },
  }) +
  L({ timestamp: 't1', type: 'turn_context', payload: { cwd: '/workspace', model: 'gpt-5.5' } }) +
  L({
    timestamp: 't2',
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: '<environment_context>cwd</environment_context>' }],
    },
  }) +
  L({
    timestamp: 't3',
    type: 'response_item',
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'say hi' }] },
  }) +
  L({ timestamp: 't3', type: 'event_msg', payload: { type: 'user_message', message: 'say hi' } }) +
  L({
    timestamp: 't4',
    type: 'response_item',
    payload: { type: 'function_call', name: 'shell', arguments: '{}', call_id: 'c1' },
  }) +
  L({
    timestamp: 't5',
    type: 'response_item',
    payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hi' }] },
  }) +
  L({
    timestamp: 't6',
    type: 'token_usage_record',
    payload: {
      response_id: 'resp_1',
      usage: { input_tokens: 100, cached_input_tokens: 60, output_tokens: 5, cache_write_input_tokens: 0 },
    },
  });

describe('codex history module', () => {
  it('identifies by the rollout name and reads lineage from session_meta', () => {
    expect(codexHistoryModule.identify(Buffer.from(rollout), PATH)).toEqual({ sessionId: SID });
    const child = L({
      type: 'session_meta',
      payload: {
        id: SID,
        source: { subagent: { thread_spawn: { parent_thread_id: 'parent-thread-0001' } } },
      },
    });
    expect(codexHistoryModule.identify(Buffer.from(child), PATH)).toEqual({
      sessionId: SID,
      parentSessionId: 'parent-thread-0001',
    });
    // A head too big for the first frame still identifies by name.
    expect(codexHistoryModule.identify(Buffer.from('{"type":"session_me'), PATH)).toEqual({
      sessionId: SID,
    });
  });

  it('projects prompts, replies, tools and usage, skipping injected context and event copies', () => {
    const { records } = codexHistoryModule.parse(
      { path: PATH, offset: 0, bytes: Buffer.from(rollout) },
      {},
    );
    const turns = records.filter((r) => r.kind === 'turn');
    expect(turns.map((t) => (t.kind === 'turn' ? `${t.role}:${t.text}` : ''))).toEqual([
      'user:say hi',
      'assistant:hi',
    ]);
    expect(records.filter((r) => r.kind === 'tool').map((r) => (r.kind === 'tool' ? r.name : ''))).toEqual(['shell']);
    expect(records.find((r) => r.kind === 'usage')).toMatchObject({
      messageId: 'resp_1',
      model: 'gpt-5.5',
      inputTokens: 40,
      cacheReadTokens: 60,
      outputTokens: 5,
    });
  });

  it('gives the same records whatever the chunking', () => {
    const whole = codexHistoryModule.parse({ path: PATH, offset: 0, bytes: Buffer.from(rollout) }, {});
    const buf = Buffer.from(rollout);
    let state = {};
    const parts = [];
    for (let i = 0; i < buf.length; i += 37) {
      const r = codexHistoryModule.parse({ path: PATH, offset: i, bytes: buf.subarray(i, i + 37) }, state);
      state = r.state;
      parts.push(...r.records);
    }
    expect(parts).toEqual(whole.records);
  });
});
