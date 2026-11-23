import { describe, expect, it } from 'vitest';
import { opencodeHistoryModule } from '../src/history.js';

const SID = 'ses_0123456789abcdef';
const PATH = `agentbox-history/${SID}.jsonl`;
const L = (t: string, id: string, u: number, row: Record<string, unknown>): string =>
  `${JSON.stringify({ t, id, u, row })}\n`;
const d = (o: unknown): string => JSON.stringify(o);

const rows =
  L('session', SID, 1, { id: SID, title: 'New session', directory: '/workspace', parent_id: 'ses_parent0001' }) +
  L('message', 'msg_u', 2, { id: 'msg_u', session_id: SID, data: d({ role: 'user', time: { created: 1 } }) }) +
  L('message', 'msg_a', 3, {
    id: 'msg_a',
    session_id: SID,
    data: d({ role: 'assistant', modelID: 'gpt-5.5', time: { created: 2 }, tokens: { input: 5, output: 1 } }),
  }) +
  L('part', 'prt_1', 4, { id: 'prt_1', message_id: 'msg_u', session_id: SID, data: d({ type: 'text', text: 'say hi' }) }) +
  L('part', 'prt_2', 5, { id: 'prt_2', message_id: 'msg_a', session_id: SID, data: d({ type: 'tool', tool: 'bash' }) }) +
  L('part', 'prt_3', 6, { id: 'prt_3', message_id: 'msg_a', session_id: SID, data: d({ type: 'text', text: 'hi' }) }) +
  // The same part again (it changed) and the completed message: no duplicate turn, usage once.
  L('part', 'prt_3', 7, { id: 'prt_3', message_id: 'msg_a', session_id: SID, data: d({ type: 'text', text: 'hi' }) }) +
  L('message', 'msg_a', 8, {
    id: 'msg_a',
    session_id: SID,
    data: d({
      role: 'assistant',
      modelID: 'gpt-5.5',
      time: { created: 2, completed: 1764000000000 },
      tokens: { input: 50, output: 4, reasoning: 2, cache: { read: 30, write: 0 } },
    }),
  }) +
  L('session', SID, 9, { id: SID, title: 'Greeting', directory: '/workspace' });

describe('opencode history module', () => {
  it('identifies by the file stem, parent from the session row', () => {
    expect(opencodeHistoryModule.identify(Buffer.from(rows), PATH)).toEqual({
      sessionId: SID,
      parentSessionId: 'ses_parent0001',
    });
  });

  it('projects each part once, usage once completed, and title changes', () => {
    const { records, state } = opencodeHistoryModule.parse(
      { path: PATH, offset: 0, bytes: Buffer.from(rows) },
      {},
    );
    expect(
      records.map((r) =>
        r.kind === 'turn' ? `${r.role}:${r.text}` : r.kind === 'tool' ? `tool:${r.name}` : r.kind,
      ),
    ).toEqual(['meta', 'meta', 'user:say hi', 'tool:bash', 'assistant:hi', 'usage', 'meta']);
    expect(records.find((r) => r.kind === 'usage')).toMatchObject({
      messageId: 'msg_a',
      inputTokens: 50,
      outputTokens: 6,
      cacheReadTokens: 30,
    });
    // Replaying the completed message in a later chunk adds nothing.
    const again = opencodeHistoryModule.parse(
      { path: PATH, offset: 9999, bytes: Buffer.from(rows.split('\n')[7]! + '\n') },
      state,
    );
    expect(again.records).toEqual([]);
  });
});
