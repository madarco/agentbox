import { describe, expect, it } from 'vitest';
import { piHistoryModule } from '../src/history.js';

const SID = '5b1e0000-1111-4222-8333-444444444444';
const PATH = `sessions/--workspace--/2026-11-23T10-00-00-000Z_${SID}.jsonl`;
const L = (o: unknown): string => `${JSON.stringify(o)}\n`;

const session =
  L({
    type: 'session',
    version: 3,
    id: SID,
    timestamp: '2026-11-23T10:00:00Z',
    cwd: '/workspace',
    parentSession: '/home/vscode/.pi/agent/sessions/--workspace--/2026-11-22T09-00-00-000Z_aaaa0000-1111-4222-8333-444444444444.jsonl',
  }) +
  L({ type: 'message', id: 'a1', parentId: null, timestamp: 't1', message: { role: 'user', content: 'say hi' } }) +
  L({
    type: 'message',
    id: 'a2',
    parentId: 'a1',
    timestamp: 't2',
    message: {
      role: 'assistant',
      content: [
        { type: 'text', text: 'hi' },
        { type: 'toolCall', id: 'c1', name: 'bash', arguments: {} },
      ],
      model: 'gpt-5.5',
      usage: { input: 10, output: 3, cacheRead: 7, cacheWrite: 1, totalTokens: 21, cost: { total: 0.01 } },
    },
  }) +
  L({ type: 'message', id: 'a3', parentId: 'a2', timestamp: 't3', message: { role: 'toolResult', toolName: 'bash', content: [] } }) +
  L({ type: 'session_info', id: 'a4', parentId: 'a3', timestamp: 't4', name: 'Greeting' });

describe('pi history module', () => {
  it('identifies by the header id and maps parentSession to the parent id', () => {
    expect(piHistoryModule.identify(Buffer.from(session), PATH)).toEqual({
      sessionId: SID,
      parentSessionId: 'aaaa0000-1111-4222-8333-444444444444',
    });
    expect(piHistoryModule.identify(Buffer.from(''), PATH)).toEqual({ sessionId: SID });
  });

  it('projects turns, tool calls, usage and the session name', () => {
    const { records } = piHistoryModule.parse({ path: PATH, offset: 0, bytes: Buffer.from(session) }, {});
    expect(records.map((r) => r.kind)).toEqual(['meta', 'turn', 'turn', 'tool', 'usage', 'meta']);
    expect(records.find((r) => r.kind === 'usage')).toMatchObject({
      messageId: 'a2',
      model: 'gpt-5.5',
      inputTokens: 10,
      outputTokens: 3,
      cacheReadTokens: 7,
      cacheWriteTokens: 1,
    });
    expect(records.at(-1)).toMatchObject({ kind: 'meta', title: 'Greeting' });
  });
});
