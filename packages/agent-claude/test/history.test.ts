import { describe, expect, it } from 'vitest';
import { claudeHistoryModule as m } from '../src/history.js';

const S = 'aaaaaaaa-1111-2222-3333-444444444444';
const P = 'bbbbbbbb-1111-2222-3333-444444444444';
const enc = (lines: object[]): Buffer =>
  Buffer.from(lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

describe('claude identify', () => {
  it('takes the session id from the file stem', () => {
    expect(
      m.identify(enc([{ type: 'user', sessionId: S }]), `projects/-workspace/${S}.jsonl`),
    ).toEqual({
      sessionId: S,
    });
  });

  it('names a foreign head id as the parent, never as the session', () => {
    const head = enc([
      { type: 'user', sessionId: P },
      { type: 'user', sessionId: S },
    ]);
    expect(m.identify(head, `projects/-workspace/${S}.jsonl`)).toEqual({
      sessionId: S,
      parentSessionId: P,
    });
  });

  it('records /branch lineage from forkedFrom', () => {
    const head = enc([
      { type: 'user', sessionId: S, forkedFrom: { sessionId: P, messageUuid: 'x' } },
    ]);
    expect(m.identify(head, `projects/-workspace/${S}.jsonl`)?.parentSessionId).toBe(P);
  });

  it('makes a subagent file a child of its parent session', () => {
    const head = enc([{ type: 'user', sessionId: S, isSidechain: true }]);
    expect(m.identify(head, `projects/-workspace/${S}/subagents/agent-abc.jsonl`)).toEqual({
      sessionId: S,
      child: true,
    });
  });
});

describe('claude parse', () => {
  const lines = [
    { type: 'user', timestamp: 't1', message: { role: 'user', content: 'hello there' } },
    {
      type: 'assistant',
      timestamp: 't2',
      message: {
        id: 'msg_1',
        model: 'claude-x',
        content: [
          { type: 'text', text: 'hi' },
          { type: 'tool_use', name: 'Bash', input: {} },
        ],
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_read_input_tokens: 3,
          cache_creation_input_tokens: 2,
        },
      },
    },
    { type: 'custom-title', customTitle: 'My session' },
    { type: 'user', isMeta: true, message: { content: 'meta' } },
  ];

  it('emits turns, tools, usage and meta with source offsets', () => {
    const bytes = enc(lines);
    const r = m.parse({ path: 'x.jsonl', offset: 100, bytes }, {});
    expect(r.state.partial).toBeUndefined();
    expect(r.records.map((x) => x.kind)).toEqual(['turn', 'turn', 'tool', 'usage', 'meta']);
    expect(r.records[0]).toMatchObject({ role: 'user', text: 'hello there', at: 100 });
    const second = JSON.stringify(lines[0]).length + 1 + 100;
    expect(r.records[1]).toMatchObject({ role: 'assistant', text: 'hi', at: second });
    expect(r.records[3]).toMatchObject({
      messageId: 'msg_1',
      inputTokens: 10,
      cacheWriteTokens: 2,
    });
    expect(r.records[4]).toMatchObject({ title: 'My session' });
  });

  it('drops usage copied from another session (/branch, desktop continuation)', () => {
    const msg = (id: string) => ({
      id,
      content: [],
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const usageIds = (path: string, ls: object[]) =>
      m
        .parse({ path, offset: 0, bytes: enc(ls) }, {})
        .records.flatMap((r) => (r.kind === 'usage' ? [r.messageId] : []));
    expect(
      usageIds('projects/-w/new.jsonl', [
        {
          type: 'assistant',
          sessionId: 'new',
          forkedFrom: { sessionId: 'old' },
          message: msg('a'),
        },
        { type: 'assistant', sessionId: 'old', message: msg('b') },
        { type: 'assistant', sessionId: 'new', message: msg('c') },
        { type: 'assistant', message: msg('d') },
      ]),
    ).toEqual(['c', 'd']);
    // A subagent's lines carry its parent's id: they are its own.
    expect(
      usageIds('projects/-w/par/subagents/agent-1.jsonl', [
        { type: 'assistant', sessionId: 'par', isSidechain: true, message: msg('s') },
      ]),
    ).toEqual(['s']);
  });

  it('carries a split line to the next chunk with the right offset', () => {
    const bytes = enc(lines.slice(0, 2));
    const cut = 30;
    const a = m.parse({ path: 'x', offset: 0, bytes: bytes.subarray(0, cut) }, {});
    expect(a.records).toHaveLength(0);
    const b = m.parse({ path: 'x', offset: cut, bytes: bytes.subarray(cut) }, a.state);
    expect(b.records[0]).toMatchObject({ kind: 'turn', at: 0 });
    expect(b.state.partial).toBeUndefined();
  });
});
