import { createHash } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  registerAgentHistoryModule,
  type AgentHistoryModule,
  type HistoryRecord,
  type HistoryFrame,
} from '@agentbox/core';
import {
  createHistoryService,
  SEAL_BYTES,
  SEAL_IDLE_MS,
  type HistoryArchive,
  type HistoryService,
} from '../lib/backend/history';
import { openSqliteHistoryRepo } from '../lib/history-sqlite';

const S = 'aaaaaaaa-1111-2222-3333-444444444444';
const PATH = `projects/-workspace/${S}.jsonl`;

function memArchive(): HistoryArchive & { keys: () => string[] } {
  const m = new Map<string, Buffer>();
  return {
    put: async (k, b) => void m.set(k, Buffer.from(b)),
    get: async (k) => {
      const b = m.get(k);
      if (!b) throw new Error(`missing ${k}`);
      return b;
    },
    delete: async (k) => void m.delete(k),
    keys: () => [...m.keys()],
  };
}

/** An edge in miniature: frames for a growing file, raw hashes like the shipper. */
class Edge {
  bytes = Buffer.alloc(0);
  constructor(
    private readonly svc: HistoryService,
    private readonly boxId = 'box1',
    private readonly path = PATH,
  ) {}
  async append(text: string | Buffer): Promise<ReturnType<HistoryService['ingest']>> {
    const data = Buffer.isBuffer(text) ? text : Buffer.from(text);
    const offset = this.bytes.length;
    const prefix = offset === 0 ? '' : createHash('sha256').update(this.bytes).digest('hex');
    this.bytes = Buffer.concat([this.bytes, data]);
    const frame: HistoryFrame = {
      origin: { boxId: this.boxId, boxName: 'smoke', provider: 'docker' },
      agent: 'claude',
      path: this.path,
      offset,
      sha256Prefix: prefix,
      sha256: createHash('sha256').update(this.bytes).digest('hex'),
      data: data.toString('base64'),
    };
    return this.svc.ingest(frame);
  }
}

const line = (o: object): string => `${JSON.stringify(o)}\n`;

async function service(now = { t: 1_000_000 }) {
  const repo = await openSqliteHistoryRepo(':memory:');
  const archive = memArchive();
  const svc = createHistoryService({ repo, archive, retentionDays: 90, now: () => now.t });
  return { svc, repo, archive, now };
}

// A stand-in with claude's shape (the real parser has its own tests in
// @agentbox/agent-claude, which the hub does not depend on directly).
const testModule: AgentHistoryModule = {
  id: 'claude',
  parserVersion: 1,
  identify(_head, path) {
    const sub = /([^/]+)\/subagents\/[^/]+\.jsonl$/.exec(path);
    if (sub) return { sessionId: sub[1]!, child: true };
    return { sessionId: path.slice(path.lastIndexOf('/') + 1).replace(/\.jsonl$/, '') };
  },
  parse(chunk, state) {
    const text =
      (typeof state.partial === 'string' ? state.partial : '') +
      Buffer.from(chunk.bytes).toString('utf8');
    const lines = text.split('\n');
    const partial = lines.pop() ?? '';
    const records: HistoryRecord[] = [];
    let at = chunk.offset;
    for (const raw of lines) {
      const l = JSON.parse(raw) as {
        type?: string;
        timestamp?: string;
        message?: {
          id?: string;
          content?: unknown;
          usage?: { input_tokens: number; output_tokens: number };
        };
      };
      const ts = l.timestamp ? { ts: l.timestamp } : {};
      const content = l.message?.content;
      const text = typeof content === 'string' ? content : Array.isArray(content) ? 'reply' : '';
      if ((l.type === 'user' || l.type === 'assistant') && text) {
        records.push({ kind: 'turn', role: l.type, text, at, ...ts });
      }
      if (Array.isArray(content)) {
        for (const b of content as Array<{ type?: string; name?: string }>) {
          if (b.type === 'tool_use' && b.name)
            records.push({ kind: 'tool', name: b.name, at, ...ts });
        }
      }
      if (l.message?.usage && l.message.id) {
        records.push({
          kind: 'usage',
          messageId: l.message.id,
          inputTokens: l.message.usage.input_tokens,
          outputTokens: l.message.usage.output_tokens,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          at,
          ...ts,
        });
      }
      at += Buffer.byteLength(raw) + 1;
    }
    return { records, state: partial ? { partial } : {} };
  },
};

beforeAll(() => registerAgentHistoryModule(testModule));

describe('history service', () => {
  it('ingests, attributes to the box, and projects the transcript', async () => {
    const { svc, repo } = await service();
    const edge = new Edge(svc);
    expect(
      await edge.append(
        line({ type: 'user', timestamp: '2026-11-22T10:00:00Z', message: { content: 'say hi' } }),
      ),
    ).toMatchObject({ ok: true });
    await edge.append(
      line({
        type: 'assistant',
        timestamp: '2026-11-22T10:00:01Z',
        message: {
          id: 'm1',
          content: [{ type: 'text', text: 'hi' }],
          usage: { input_tokens: 7, output_tokens: 2 },
        },
      }),
    );
    const [s] = await repo.listSessions();
    expect(s).toMatchObject({
      key: `claude:${S}`,
      sessionId: S,
      boxId: 'box1',
      provider: 'docker',
      turns: 2,
      inputTokens: 7,
      outputTokens: 2,
      title: 'say hi',
      firstTs: '2026-11-22T10:00:00Z',
    });
  });

  it('answers offset_mismatch with what it holds, and dedupes a retried frame', async () => {
    const { svc } = await service();
    const edge = new Edge(svc);
    await edge.append(line({ a: 1 }));
    const held = edge.bytes.length;
    // A retry of the same frame (reply lost): refused, told where the hub is.
    const retry = await svc.ingest({
      origin: { boxId: 'box1' },
      agent: 'claude',
      path: PATH,
      offset: 0,
      sha256Prefix: '',
      sha256: 'x',
      data: Buffer.from(line({ a: 1 })).toString('base64'),
    });
    expect(retry).toMatchObject({ ok: false, code: 'offset_mismatch', offset: held });
    // A wrong prefix hash at the right offset is refused too.
    const bad = await svc.ingest({
      origin: { boxId: 'box1' },
      agent: 'claude',
      path: PATH,
      offset: held,
      sha256Prefix: 'nope',
      sha256: 'x',
      data: Buffer.from(line({ b: 2 })).toString('base64'),
    });
    expect(bad).toMatchObject({ ok: false, code: 'offset_mismatch' });
    // An unknown file must start at 0.
    const fresh = await svc.ingest({
      origin: { boxId: 'box2' },
      agent: 'claude',
      path: PATH,
      offset: 10,
      sha256Prefix: 'x',
      sha256: 'y',
      data: 'eA==',
    });
    expect(fresh).toMatchObject({ ok: false, code: 'offset_mismatch', offset: 0 });
  });

  it('seals small frames into one deduped chunk and reassembles exactly', async () => {
    const now = { t: 1_000_000 };
    const { svc, repo, archive } = await service(now);
    const edge = new Edge(svc);
    const big = 'Q'.repeat(10_000);
    for (let i = 0; i < 5; i++) {
      await edge.append(
        line({ type: 'user', message: { content: `turn ${String(i)}` }, blob: big }),
      );
    }
    const fileId = (await repo.getFile('box:box1', 'claude', PATH))!.id;
    expect((await repo.listChunks(fileId, 0)).filter((c) => !c.sealed)).toHaveLength(5);
    now.t += SEAL_IDLE_MS + 1;
    expect((await svc.sweep()).sealed).toBe(1);
    const chunks = await repo.listChunks(fileId, 0);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({
      sealed: true,
      deduped: true,
      start: 0,
      end: edge.bytes.length,
    });
    // 5 copies of the big string became one blob.
    expect(chunks[0]!.storedBytes).toBeLessThan(2_000);
    expect(archive.keys()).toHaveLength(1);
    expect((await svc.readRaw(fileId)).equals(edge.bytes)).toBe(true);
  });

  it('seals as soon as a file holds 2 MB unsealed', async () => {
    const { svc, repo } = await service();
    const edge = new Edge(svc);
    const pad = 'x'.repeat(256 * 1024);
    for (let i = 0; i * 256 * 1024 < SEAL_BYTES + 1; i++) await edge.append(line({ i, pad }));
    const fileId = (await repo.getFile('box:box1', 'claude', PATH))!.id;
    expect((await repo.listChunks(fileId, 0)).some((c) => c.sealed)).toBe(true);
    expect((await svc.readRaw(fileId)).equals(edge.bytes)).toBe(true);
  });

  it('starts a new generation on reset and re-derives the projection', async () => {
    const { svc, repo } = await service();
    const edge = new Edge(svc);
    await edge.append(line({ type: 'user', message: { content: 'old' } }));
    const data = Buffer.from(line({ type: 'user', message: { content: 'new' } }));
    const r = await svc.ingest({
      origin: { boxId: 'box1' },
      agent: 'claude',
      path: PATH,
      offset: 0,
      sha256Prefix: '',
      sha256: createHash('sha256').update(data).digest('hex'),
      data: data.toString('base64'),
      reset: true,
    });
    expect(r).toMatchObject({ ok: true, offset: data.length });
    const file = (await repo.getFile('box:box1', 'claude', PATH))!;
    expect(file.generation).toBe(1);
    expect((await svc.readRaw(file.id)).equals(data)).toBe(true);
    expect((await repo.listSessions())[0]!.turns).toBe(1);
  });

  it('keeps subagent files inside their parent session', async () => {
    const { svc, repo } = await service();
    await new Edge(svc).append(line({ type: 'user', message: { content: 'main' } }));
    await new Edge(svc, 'box1', `projects/-workspace/${S}/subagents/agent-1.jsonl`).append(
      line({ type: 'user', sessionId: S, isSidechain: true, message: { content: 'sub' } }),
    );
    const sessions = await repo.listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.turns).toBe(2);
  });

  it('purges transcripts past retention, keeping the session row and its usage', async () => {
    const now = { t: 1_000_000 };
    const { svc, repo, archive } = await service(now);
    const edge = new Edge(svc);
    await edge.append(line({ type: 'user', message: { content: 'x' }, blob: 'B'.repeat(5000) }));
    await edge.append(
      line({
        type: 'assistant',
        timestamp: '2026-11-20T10:00:00.000Z',
        message: { id: 'm1', content: [], usage: { input_tokens: 7, output_tokens: 3 } },
      }),
    );
    now.t += SEAL_IDLE_MS + 1;
    await svc.sweep();
    now.t += 91 * 24 * 60 * 60_000;
    const r = await svc.sweep({ retention: true });
    expect(r).toMatchObject({ expired: 1, blobs: 1 });
    expect(archive.keys()).toHaveLength(0);
    // Hidden from the session reads, still counted by usage.
    expect(await svc.listSessions({})).toHaveLength(0);
    expect(await svc.resolveSession(S)).toMatchObject({ ok: false, code: 'not_found' });
    expect(await repo.filesOfSession(`claude:${S}`)).toHaveLength(0);
    const u = await svc.usage({ by: ['agent'], tzOffsetMin: 0, limit: 10 });
    expect(u.totals).toMatchObject({ inputTokens: 7, outputTokens: 3, messages: 1, sessions: 1 });
    // A second sweep does not purge it again.
    expect((await svc.sweep({ retention: true })).expired).toBe(0);
  });
});

describe('history reads (Phase 2)', () => {
  const T = 'bbbbbbbb-1111-2222-3333-444444444444';
  async function seeded() {
    const now = { t: 1_000_000 };
    const ctx = await service(now);
    const a = new Edge(ctx.svc, 'box1');
    await a.append(
      line({
        type: 'user',
        timestamp: '2026-11-22T10:00:00Z',
        message: { content: 'fix the flaky retry test' },
      }),
    );
    await a.append(
      line({
        type: 'assistant',
        timestamp: '2026-11-22T10:00:02Z',
        message: {
          id: 'm1',
          content: [
            { type: 'text', text: 'done' },
            { type: 'tool_use', name: 'Bash' },
          ],
        },
      }),
    );
    await new Edge(ctx.svc, 'box1', `projects/-workspace/${S}/subagents/agent-1.jsonl`).append(
      line({
        type: 'user',
        timestamp: '2026-11-22T10:00:01Z',
        message: { content: 'subagent task' },
      }),
    );
    const b = new Edge(ctx.svc, 'box2', `projects/-workspace/${T}.jsonl`);
    now.t += 1000;
    await b.append(
      line({
        type: 'user',
        timestamp: '2026-11-22T11:00:00Z',
        message: { content: 'write the docs' },
      }),
    );
    return { ...ctx, a, b };
  }

  it('lists newest first and filters by box, agent, since and words', async () => {
    const { svc } = await seeded();
    expect((await svc.listSessions({})).map((s) => s.sessionId)).toEqual([T, S]);
    expect((await svc.listSessions({ box: 'box1' })).map((s) => s.sessionId)).toEqual([S]);
    expect((await svc.listSessions({ box: 'smoke' })).length).toBe(2); // the box name
    expect(await svc.listSessions({ agent: 'codex' })).toEqual([]);
    // `since` is activity (the transcript's own timestamps), not ingest time.
    expect(
      (await svc.listSessions({ sinceMs: Date.parse('2026-11-22T10:30:00Z') })).map(
        (s) => s.sessionId,
      ),
    ).toEqual([T]);
    expect((await svc.listSessions({ q: 'flaky retry' })).map((s) => s.sessionId)).toEqual([S]);
    // FTS syntax in user input is quoted away, never an error.
    expect(await svc.listSessions({ q: 'flaky"' })).toHaveLength(1);
    // Operators become plain words that must also match: no error, no hits.
    expect(await svc.listSessions({ q: '"flaky OR NEAR(' })).toEqual([]);
    expect(await svc.listSessions({ q: '***' })).toEqual([]); // no words: no match, like search
  });

  it('resolves a session by key, id or a unique 8+ char prefix', async () => {
    const { svc } = await seeded();
    expect(await svc.resolveSession(S)).toEqual({ ok: true, key: `claude:${S}` });
    expect(await svc.resolveSession(`claude:${T}`)).toEqual({ ok: true, key: `claude:${T}` });
    expect(await svc.resolveSession('aaaaaaaa')).toEqual({ ok: true, key: `claude:${S}` });
    expect(await svc.resolveSession('aaaa')).toMatchObject({ ok: false, code: 'not_found' });
    expect(await svc.resolveSession('aaaaaaa%')).toMatchObject({ ok: false, code: 'not_found' });
  });

  it('resolves a prefix containing `_` (opencode ids) literally', async () => {
    const { svc } = await service();
    await new Edge(svc, 'box1', 'projects/-workspace/ses_df9264f6cffe.jsonl').append(
      line({ type: 'user', message: { content: 'x' } }),
    );
    await new Edge(svc, 'box1', 'projects/-workspace/sesXdf9264f6cffe.jsonl').append(
      line({ type: 'user', message: { content: 'y' } }),
    );
    expect(await svc.resolveSession('ses_df92')).toEqual({
      ok: true,
      key: 'claude:ses_df9264f6cffe',
    });
  });

  it('reports an ambiguous prefix with its candidates', async () => {
    const { svc } = await seeded();
    await new Edge(
      svc,
      'box3',
      'projects/-workspace/aaaaaaaa-9999-2222-3333-444444444444.jsonl',
    ).append(line({ type: 'user', message: { content: 'x' } }));
    const r = await svc.resolveSession('aaaaaaaa');
    expect(r).toMatchObject({ ok: false, code: 'ambiguous' });
    expect(r.ok ? [] : r.candidates).toHaveLength(2);
  });

  it('condenses a session: files, tools, first prompt, last reply', async () => {
    const { svc } = await seeded();
    const d = (await svc.sessionDetail(`claude:${S}`))!;
    expect(d.files.map((f) => [f.path, f.child])).toEqual([
      [`projects/-workspace/${S}.jsonl`, false],
      [`projects/-workspace/${S}/subagents/agent-1.jsonl`, true],
    ]);
    expect(d.tools).toEqual([{ name: 'Bash', count: 1 }]);
    expect(d.firstPrompt).toBe('fix the flaky retry test');
    expect(d.lastReply).toBe('reply');
    expect(d.turns).toBe(4);
  });

  it('pages turns in time order with subagent rows interleaved', async () => {
    const { svc } = await seeded();
    const rows = await svc.sessionTurns(`claude:${S}`, 0, 10);
    expect(rows.map((r) => [r.index, r.kind, r.text ?? r.name])).toEqual([
      [0, 'turn', 'fix the flaky retry test'],
      [1, 'turn', 'subagent task'],
      [2, 'turn', 'reply'],
      [3, 'tool', 'Bash'],
    ]);
    expect((await svc.sessionTurns(`claude:${S}`, 2, 1)).map((r) => r.index)).toEqual([2]);
  });

  it('picks the main file by default and a listed path on request', async () => {
    const { svc } = await seeded();
    expect((await svc.sessionFile(`claude:${S}`))!.path).toBe(`projects/-workspace/${S}.jsonl`);
    const sub = `projects/-workspace/${S}/subagents/agent-1.jsonl`;
    expect((await svc.sessionFile(`claude:${S}`, sub))!.path).toBe(sub);
    expect(await svc.sessionFile(`claude:${S}`, `projects/-workspace/${T}.jsonl`)).toBeNull();
  });

  it('streams raw bytes exactly, even when a seal replaces chunks mid-download', async () => {
    const now = { t: 1_000_000 };
    const { svc, repo } = await service(now);
    const edge = new Edge(svc);
    const big = 'Z'.repeat(6000);
    for (let i = 0; i < 4; i++) await edge.append(line({ i, big }));
    const fileId = (await repo.getFile('box:box1', 'claude', PATH))!.id;
    const it = svc.rawStream(fileId);
    const parts: Buffer[] = [];
    const first = await it.next();
    parts.push(first.value as Buffer);
    now.t += SEAL_IDLE_MS + 1;
    expect((await svc.sweep()).sealed).toBe(1); // the remaining small chunks are gone now
    for (;;) {
      const n = await it.next();
      if (n.done) break;
      parts.push(n.value);
    }
    expect(Buffer.concat(parts).equals(edge.bytes)).toBe(true);
  });

  it('searches turns with snippets, quoting user input', async () => {
    const { svc } = await seeded();
    const hits = await svc.search('flaky', 10);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ sessionKey: `claude:${S}`, role: 'user' });
    expect(hits[0]!.snippet).toContain('[flaky]');
    expect(await svc.search('"unbalanced', 10)).toEqual([]);
    expect(await svc.search('   ', 10)).toEqual([]);
  });

  it('stops a download at the length taken when it started, while the file keeps growing', async () => {
    const { svc, repo } = await service();
    const edge = new Edge(svc);
    await edge.append(line({ a: 1 }));
    await edge.append(line({ b: 2 }));
    const file = (await repo.getFile('box:box1', 'claude', PATH))!;
    const snapshot = Buffer.from(edge.bytes);
    const it = svc.rawStream(file.id, file.offset);
    const parts: Buffer[] = [(await it.next()).value as Buffer];
    await edge.append(line({ c: 3 })); // ingested mid-download
    for (;;) {
      const n = await it.next();
      if (n.done) break;
      parts.push(n.value);
    }
    expect(Buffer.concat(parts).equals(snapshot)).toBe(true);
  });

  it('keeps a row without a timestamp where it was written', async () => {
    const { svc } = await service();
    const edge = new Edge(svc);
    await edge.append(
      line({ type: 'user', timestamp: '2026-11-22T10:00:00Z', message: { content: 'first' } }),
    );
    await edge.append(
      line({
        type: 'assistant',
        message: { id: 'm', content: [{ type: 'tool_use', name: 'Read' }] },
      }),
    );
    await edge.append(
      line({ type: 'user', timestamp: '2026-11-22T10:00:05Z', message: { content: 'second' } }),
    );
    const rows = await svc.sessionTurns(`claude:${S}`, 0, 10);
    expect(rows.map((r) => r.text ?? r.name)).toEqual(['first', 'reply', 'Read', 'second']);
  });
});
