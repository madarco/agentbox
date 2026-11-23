import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  registerAgentHistoryModule,
  type AgentHistoryModule,
  type HistoryFrame,
  type HistoryRecord,
} from '@agentbox/core';
import { createHistoryService, type HistoryArchive } from '../lib/backend/history';
import { openSqliteHistoryRepo } from '../lib/history-sqlite';

// Its own file: it re-registers the `reparse-test` agent's parser at a newer
// version, which would leak into other files' registry.

const AGENT = 'reparse-test';
const SID = 'rrrrrrrr-1111-2222-3333-444444444444';
const PATH = `sessions/${SID}.jsonl`;

function memArchive(): HistoryArchive {
  const m = new Map<string, Buffer>();
  return {
    put: async (k, b) => void m.set(k, Buffer.from(b)),
    get: async (k) => {
      const b = m.get(k);
      if (!b) throw new Error(`missing ${k}`);
      return b;
    },
    delete: async (k) => void m.delete(k),
  };
}

/** v1 projects user lines only; v2 also assistant lines, upper-cased, and a title. */
function moduleAt(version: 1 | 2): AgentHistoryModule {
  return {
    id: AGENT,
    parserVersion: version,
    identify: () => ({ sessionId: SID }),
    parse(chunk, state) {
      const text =
        (typeof state.partial === 'string' ? state.partial : '') +
        Buffer.from(chunk.bytes).toString('utf8');
      const lines = text.split('\n');
      const partial = lines.pop() ?? '';
      const records: HistoryRecord[] = [];
      let at =
        chunk.offset - Buffer.byteLength(typeof state.partial === 'string' ? state.partial : '');
      for (const raw of lines) {
        const l = JSON.parse(raw) as {
          role: 'user' | 'assistant';
          text: string;
          usage?: number;
        };
        if (l.usage) {
          records.push({
            kind: 'usage',
            messageId: `u${String(at)}`,
            inputTokens: l.usage,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            at,
          });
        }
        if (version === 1 && l.role === 'user') {
          records.push({ kind: 'turn', role: 'user', text: l.text, at });
        }
        if (version === 2) {
          records.push({ kind: 'turn', role: l.role, text: l.text.toUpperCase(), at });
          if (l.role === 'assistant') records.push({ kind: 'meta', title: 'v2 title', at });
        }
        at += Buffer.byteLength(raw) + 1;
      }
      return { records, state: partial ? { partial } : {} };
    },
  };
}

describe('history re-parse job', () => {
  it('re-derives a session from raw when its parser version is bumped', async () => {
    registerAgentHistoryModule(moduleAt(1));
    const repo = await openSqliteHistoryRepo(':memory:');
    const svc = createHistoryService({ repo, archive: memArchive(), retentionDays: 90 });
    const body =
      `${JSON.stringify({ role: 'user', text: 'say hi' })}\n` +
      `${JSON.stringify({ role: 'assistant', text: 'hi there' })}\n` +
      `${JSON.stringify({ role: 'user', text: 'tail' })}`; // partial last line
    const frame: HistoryFrame = {
      origin: { boxId: 'box1' },
      agent: AGENT,
      path: PATH,
      offset: 0,
      sha256Prefix: '',
      sha256: createHash('sha256').update(body).digest('hex'),
      data: Buffer.from(body).toString('base64'),
    };
    expect(await svc.ingest(frame)).toMatchObject({ ok: true });
    const key = `${AGENT}:${SID}`;
    expect((await svc.sessionTurns(key, 0, 10)).map((t) => t.text)).toEqual(['say hi']);
    expect(await svc.reparse()).toBe(0); // nothing stale

    registerAgentHistoryModule(moduleAt(2));
    expect(await svc.reparse()).toBe(1);
    expect((await svc.sessionTurns(key, 0, 10)).map((t) => t.text)).toEqual(['SAY HI', 'HI THERE']);
    const session = await repo.getSession(key);
    expect(session).toMatchObject({ parserVersion: 2, title: 'v2 title', turns: 2 });
    // The partial tail is in the stored parse state, so the next frame completes it.
    const file = (await repo.filesOfSession(key))[0]!;
    expect(typeof file.parseState?.partial).toBe('string');
    expect(await svc.reparse()).toBe(0);
  });

  it('keeps a stale session stale when a new file arrives, and keeps its activity time', async () => {
    registerAgentHistoryModule(moduleAt(1));
    let t = 1_000;
    const repo = await openSqliteHistoryRepo(':memory:');
    const svc = createHistoryService({
      repo,
      archive: memArchive(),
      retentionDays: 90,
      now: () => t,
    });
    const frame = (path: string, body: string): HistoryFrame => ({
      origin: { boxId: 'box1' },
      agent: AGENT,
      path,
      offset: 0,
      sha256Prefix: '',
      sha256: createHash('sha256').update(body).digest('hex'),
      data: Buffer.from(body).toString('base64'),
    });
    const body = `${JSON.stringify({ role: 'user', text: 'a' })}\n`;
    await svc.ingest(frame(PATH, body));
    registerAgentHistoryModule(moduleAt(2));
    t = 2_000;
    await svc.ingest(frame(`sessions/${SID}/child.jsonl`, body));
    const key = `${AGENT}:${SID}`;
    expect((await repo.getSession(key))?.parserVersion).toBe(1);
    const before = (await repo.getSession(key))!.updatedAt;
    t = 9_000;
    expect(await svc.reparse()).toBe(1);
    expect(await repo.getSession(key)).toMatchObject({ parserVersion: 2, updatedAt: before });
  });

  it('leaves a session stale when its raw cannot be read, and moves on', async () => {
    registerAgentHistoryModule(moduleAt(1));
    const repo = await openSqliteHistoryRepo(':memory:');
    const archive = memArchive();
    const svc = createHistoryService({ repo, archive, retentionDays: 90 });
    const body = `${JSON.stringify({ role: 'user', text: 'a', usage: 7 })}\n`;
    await svc.ingest({
      origin: { boxId: 'box1' },
      agent: AGENT,
      path: PATH,
      offset: 0,
      sha256Prefix: '',
      sha256: createHash('sha256').update(body).digest('hex'),
      data: Buffer.from(body).toString('base64'),
    });
    registerAgentHistoryModule(moduleAt(2));
    archive.get = async () => {
      throw new Error('gone');
    };
    expect(await svc.reparse()).toBe(0);
    expect((await repo.getSession(`${AGENT}:${SID}`))?.parserVersion).toBe(1);
    // The usage the old parser stored survives the failed re-parse.
    const u = await svc.usage({ by: [], tzOffsetMin: 0, limit: 10 });
    expect(u.totals).toMatchObject({ inputTokens: 7, messages: 1 });
    expect((await repo.getSession(`${AGENT}:${SID}`))?.inputTokens).toBe(7);
  });
});
