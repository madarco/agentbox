import { describe, expect, it } from 'vitest';
import { openclawHistoryModule } from '../src/history.js';

const SID = '7241fdc1-21e3-4d4e-929a-e49794bad4c4';
const PREV = '0bd2a7a0-0e3c-4f55-9a61-5b6f3a4c0d11';
const PATH = `agentbox-history/${SID}.jsonl`;

// Shapes measured from openclaw 2026.11.7 (docs/agent-history-plan.md, Phase 3b).
const ev = (seq: number, e: Record<string, unknown>) => ({
  t: 'transcript_events',
  id: String(seq),
  u: 1_795_417_337_202 + seq,
  row: { session_id: SID, seq, event_json: JSON.stringify(e), created_at: 1 },
});
const LINES = [
  {
    t: 'session_windows',
    id: SID,
    u: 1_795_417_354_313,
    row: {
      session_id: SID,
      previous_session_id: PREV,
      reason: 'reset',
      updated_at: 1_795_417_354_313,
      model: 'mock-1',
      display_name: null,
    },
  },
  ev(0, { type: 'session', version: 4, id: SID, timestamp: 't0', cwd: '/workspace' }),
  ev(1, { type: 'model_change', provider: 'mock', modelId: 'mock-1', id: 'e1', timestamp: 't1' }),
  ev(3, { type: 'custom', customType: 'openclaw.system-prompt', data: {}, id: 'e3' }),
  ev(4, {
    type: 'message',
    id: 'e4',
    timestamp: 't4',
    message: { role: 'user', content: 'hello there' },
  }),
  ev(5, {
    type: 'custom_message',
    customType: 'openclaw.runtime-context',
    content: '## Watched Sessions',
    id: 'e5',
  }),
  ev(7, {
    type: 'message',
    id: 'e7',
    timestamp: 't7',
    message: {
      role: 'assistant',
      content: [
        { type: 'text', text: 'MOCKREPLY' },
        { type: 'toolCall', name: 'read', arguments: {} },
      ],
      model: 'mock-1',
      usage: { input: 123, output: 45, cacheRead: 2, cacheWrite: 1, totalTokens: 171 },
    },
  }),
];

function bytes(lines: unknown[]): Uint8Array {
  return Buffer.from(lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

describe('openclawHistoryModule', () => {
  it('identifies the session from the file and its lineage from the window', () => {
    expect(openclawHistoryModule.identify(bytes(LINES), PATH)).toEqual({
      sessionId: SID,
      parentSessionId: PREV,
    });
    expect(openclawHistoryModule.identify(bytes(LINES.slice(1)), PATH)).toEqual({
      sessionId: SID,
    });
  });

  it('projects turns, tools and usage, skipping injected context and repeated rows', () => {
    const all = bytes([...LINES, LINES[4], LINES[6]]);
    const { records } = openclawHistoryModule.parse({ path: PATH, offset: 0, bytes: all }, {});
    const kinds = records.map((r) =>
      r.kind === 'turn' ? `${r.role}:${r.text}` : r.kind === 'tool' ? `tool:${r.name}` : r.kind,
    );
    expect(kinds).toEqual([
      'meta',
      'meta',
      'user:hello there',
      'assistant:MOCKREPLY',
      'tool:read',
      'usage',
    ]);
    expect(records.at(-1)).toMatchObject({
      kind: 'usage',
      messageId: 'e7',
      model: 'mock-1',
      inputTokens: 123,
      outputTokens: 45,
      cacheReadTokens: 2,
      cacheWriteTokens: 1,
    });
  });
});
