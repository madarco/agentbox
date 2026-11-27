import { describe, expect, it } from 'vitest';
import { isInjectedPrompt } from '@agentbox/core';
import { claudeHistoryModule as m, claudeLineRecords } from '../src/history.js';

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
    expect(r.records.map((x) => x.kind)).toEqual([
      'turn',
      'turn',
      'tool',
      'activity',
      'usage',
      'context',
      'meta',
    ]);
    expect(r.records[0]).toMatchObject({ role: 'user', text: 'hello there', at: 100 });
    const second = JSON.stringify(lines[0]).length + 1 + 100;
    expect(r.records[1]).toMatchObject({ role: 'assistant', text: 'hi', at: second });
    expect(r.records[3]).toMatchObject({ kind: 'activity', text: 'Bash' });
    expect(r.records[4]).toMatchObject({
      messageId: 'msg_1',
      inputTokens: 10,
      cacheWriteTokens: 2,
    });
    expect(r.records[5]).toMatchObject({ kind: 'context', tokens: 15 });
    expect(r.records[6]).toMatchObject({ title: 'My session' });
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
        // A forkedFrom naming the file's own session is not a copy.
        {
          type: 'assistant',
          sessionId: 'new',
          forkedFrom: { sessionId: 'new' },
          message: msg('e'),
        },
      ]),
    ).toEqual(['c', 'd', 'e']);
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

describe('claude automated prompts (usage busy spans)', () => {
  const userLine = (extra: Record<string, unknown>, content: string): Record<string, unknown> => ({
    type: 'user',
    timestamp: '2026-11-27T07:50:00Z',
    message: { role: 'user', content },
    ...extra,
  });
  const autoOf = (line: Record<string, unknown>): unknown =>
    (claudeLineRecords(line, 0)[0] as { auto?: boolean }).auto;

  it('reads origin.kind first', () => {
    expect(autoOf(userLine({ origin: { kind: 'human' } }, '<task-notification>x'))).toBe(false);
    expect(autoOf(userLine({ origin: { kind: 'task-notification' } }, 'done'))).toBe(true);
  });

  it('a typed prompt is human whatever its origin kind', () => {
    expect(
      autoOf(userLine({ origin: { kind: 'queued' }, promptSource: 'typed' }, 'and this')),
    ).toBe(false);
  });

  it('an image-only prompt starts a turn; a tool result does not', () => {
    const img = {
      type: 'user',
      timestamp: 't',
      message: { role: 'user', content: [{ type: 'image', source: {} }] },
    };
    expect(claudeLineRecords(img, 0)).toMatchObject([{ kind: 'turn', role: 'user', auto: false }]);
    const res = {
      type: 'user',
      timestamp: 't',
      message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] },
    };
    expect(claudeLineRecords(res, 0)).toEqual([]);
  });

  it('then promptSource', () => {
    expect(autoOf(userLine({ promptSource: 'system' }, 'done'))).toBe(true);
    expect(autoOf(userLine({ promptSource: 'typed' }, 'done'))).toBe(false);
  });

  it('then the text, for older transcripts', () => {
    expect(autoOf(userLine({}, '<task-notification>\n<task-id>b</task-id>'))).toBe(true);
    expect(
      autoOf(
        userLine({}, '<system-reminder>a</system-reminder>\n<system-reminder>b</system-reminder>'),
      ),
    ).toBe(true);
    expect(autoOf(userLine({}, 'fix it\n<system-reminder>a</system-reminder>'))).toBe(false);
    expect(autoOf(userLine({}, 'fix the <task-notification> parser'))).toBe(false);
    // Clipped mid-block, as stored text is.
    expect(isInjectedPrompt('<system-reminder>a</system-reminder><system-reminder>very lo…')).toBe(
      true,
    );
  });
});

describe('claude refused credential (credentials-tui Phase 1)', () => {
  // The line claude 2.1.326 writes for a dead login, setup token or API key
  // (measured with bogus tokens; docs/credentials-tui-plan.md).
  const refused = {
    type: 'assistant',
    error: 'authentication_failed',
    isApiErrorMessage: true,
    timestamp: '2026-11-26T15:58:36.000Z',
    sessionId: S,
    message: {
      id: 'b4d5049b',
      model: '<synthetic>',
      role: 'assistant',
      usage: { input_tokens: 0, output_tokens: 0 },
      content: [
        {
          type: 'text',
          text: 'Failed to authenticate: OAuth session expired and could not be refreshed',
        },
      ],
    },
  };

  it('emits an auth record next to the turn', () => {
    const { records } = m.parse(
      { bytes: enc([refused]), offset: 0, path: `${S}.jsonl` } as never,
      {},
    );
    expect(records.filter((r) => r.kind === 'auth')).toEqual([
      { kind: 'auth', error: 'authentication_failed', ts: '2026-11-26T15:58:36.000Z', at: 0 },
    ]);
  });

  it("no auth record for another session's refusal copied in (/branch, fork)", () => {
    const { records } = m.parse(
      {
        bytes: enc([
          { ...refused, sessionId: 'old' },
          { ...refused, forkedFrom: { sessionId: 'old' } },
        ]),
        offset: 0,
        path: `${S}.jsonl`,
      } as never,
      {},
    );
    expect(records.some((r) => r.kind === 'auth')).toBe(false);
  });

  it('no auth record for another API error or a normal reply', () => {
    const other = { ...refused, error: 'rate_limit' };
    const normal = { ...refused, error: undefined, isApiErrorMessage: undefined };
    const { records } = m.parse(
      { bytes: enc([other, normal]), offset: 0, path: `${S}.jsonl` } as never,
      {},
    );
    expect(records.some((r) => r.kind === 'auth')).toBe(false);
  });
});
