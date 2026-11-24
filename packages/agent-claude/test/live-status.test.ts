// Live status (docs/agent-live-status-plan.md, Phase 3): titles, the
// working-on line and context fill from synthetic transcripts shaped like the
// PoC's measurements.
import { describe, expect, it } from 'vitest';
import type { HistoryRecord } from '@agentbox/core';
import { claudeHistoryModule as m } from '../src/history.js';

const SID = '11111111-2222-4333-8444-555555555555';
const enc = (lines: unknown[]): Buffer =>
  Buffer.from(lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
const parse = (path: string, lines: unknown[]): HistoryRecord[] =>
  m.parse({ path, offset: 0, bytes: enc(lines) }, {}).records;

const assistant = (id: string, content: unknown[], usage?: Record<string, number>) => ({
  type: 'assistant',
  sessionId: SID,
  timestamp: `2026-11-24T10:00:0${id.slice(-1)}Z`,
  message: { id, model: 'claude-x', content, ...(usage ? { usage } : {}) },
});

describe('claude live status', () => {
  it('reads ai-title, and a rename wins over a later ai-title', () => {
    const titles = (lines: unknown[]) =>
      parse(`projects/-workspace/${SID}.jsonl`, lines).flatMap((r) =>
        r.kind === 'meta' && r.title ? [r.title] : [],
      );
    expect(titles([{ type: 'ai-title', aiTitle: 'Add a health route', sessionId: SID }])).toEqual([
      'Add a health route',
    ]);
    expect(
      titles([
        { type: 'custom-title', customTitle: 'mine', sessionId: SID },
        { type: 'ai-title', aiTitle: 'Generated', sessionId: SID },
      ]),
    ).toEqual(['mine']);
  });

  it('keeps the rename across chunks', () => {
    const path = `projects/-workspace/${SID}.jsonl`;
    const first = m.parse(
      { path, offset: 0, bytes: enc([{ type: 'custom-title', customTitle: 'mine' }]) },
      {},
    );
    const second = m.parse(
      { path, offset: 100, bytes: enc([{ type: 'ai-title', aiTitle: 'Generated' }]) },
      first.state,
    );
    expect(second.records).toEqual([]);
  });

  it('builds the working-on line from the last tool_use, never a write payload', () => {
    const acts = parse(`projects/-workspace/${SID}.jsonl`, [
      assistant('msg_1', [{ type: 'text', text: 'Looking at\nthe server.' }]),
      assistant('msg_2', [
        {
          type: 'tool_use',
          name: 'Bash',
          input: { command: 'npm test', description: 'Run tests' },
        },
      ]),
      assistant('msg_3', [
        {
          type: 'tool_use',
          name: 'Write',
          input: { file_path: 'src/a.ts', content: 'SECRET FILE BODY' },
        },
      ]),
    ]).flatMap((r) => (r.kind === 'activity' ? [r.text] : []));
    expect(acts).toEqual(['Looking at the server.', 'Bash: Run tests', 'Write: src/a.ts']);
  });

  it('redacts and clips the line', () => {
    const [act] = parse(`projects/-workspace/${SID}.jsonl`, [
      assistant('msg_1', [
        {
          type: 'tool_use',
          name: 'Bash',
          input: {
            command: `curl -H "x-api-key: sk-ant-api03-${'a1B2'.repeat(20)}" ${'x'.repeat(200)}`,
          },
        },
      ]),
    ]).filter((r) => r.kind === 'activity');
    expect(act).toBeDefined();
    const text = (act as { text: string }).text;
    expect(text.length).toBeLessThanOrEqual(120);
    expect(text).not.toContain('a1B2a1B2');
  });

  it('context fill is the main thread last input + cache; subagents add usage, not context', () => {
    const usage = {
      input_tokens: 5,
      output_tokens: 9,
      cache_read_input_tokens: 100,
      cache_creation_input_tokens: 20,
    };
    const main = parse(`projects/-workspace/${SID}.jsonl`, [
      assistant('msg_1', [{ type: 'text', text: 'a' }], usage),
    ]);
    expect(main.find((r) => r.kind === 'context')).toMatchObject({ tokens: 125 });
    const sub = parse(`projects/-workspace/${SID}/subagents/agent-a1.jsonl`, [
      assistant('msg_9', [{ type: 'text', text: 'b' }], usage),
      { type: 'ai-title', aiTitle: 'sub title' },
    ]);
    expect(sub.map((r) => r.kind)).toEqual(['turn', 'activity', 'usage']);
  });
});
