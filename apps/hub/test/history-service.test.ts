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

  it('deletes sessions past retention, with their archive objects and orphan blobs', async () => {
    const now = { t: 1_000_000 };
    const { svc, repo, archive } = await service(now);
    const edge = new Edge(svc);
    await edge.append(line({ type: 'user', message: { content: 'x' }, blob: 'B'.repeat(5000) }));
    now.t += SEAL_IDLE_MS + 1;
    await svc.sweep();
    now.t += 91 * 24 * 60 * 60_000;
    const r = await svc.sweep({ retention: true });
    expect(r).toMatchObject({ expired: 1, blobs: 1 });
    expect(await repo.listSessions()).toHaveLength(0);
    expect(archive.keys()).toHaveLength(0);
  });
});
