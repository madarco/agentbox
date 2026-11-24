// The live summary slice (docs/agent-live-status-plan.md, Phase 3): the store's
// live row, the box join (reported session id, else the latest binding), the
// payload enrichment and the 30s per-box notify throttle.
import { createHash } from 'node:crypto';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  registerAgentHistoryModule,
  type AgentHistoryModule,
  type HistoryFrame,
  type HistoryRecord,
} from '@agentbox/core';
import { createHistoryService, type HistoryArchive } from '../lib/backend/history';
import { openSqliteHistoryRepo } from '../lib/history-sqlite';
import { createLiveStatus, currentSessionKey, liveUsage } from '../lib/backend/live-status';
import type { Box } from '../lib/boxes/types';

// A stand-in agent whose lines ARE records: the real parsers have their own tests.
const AGENT = 'livetest';
const mod: AgentHistoryModule = {
  id: AGENT,
  parserVersion: 1,
  identify: (_head, path) => ({ sessionId: path.replace(/\.jsonl$/, '') }),
  parse(chunk, state) {
    const records = Buffer.from(chunk.bytes)
      .toString('utf8')
      .split('\n')
      .filter(Boolean)
      .map((l, i) => ({ ...(JSON.parse(l) as object), at: chunk.offset + i }) as HistoryRecord);
    return { records, state };
  },
};
beforeAll(() => registerAgentHistoryModule(mod));

function memArchive(): HistoryArchive {
  const m = new Map<string, Buffer>();
  return {
    put: async (k, b) => void m.set(k, Buffer.from(b)),
    get: async (k) => m.get(k)!,
    delete: async (k) => void m.delete(k),
  };
}

async function rig() {
  const repo = await openSqliteHistoryRepo(':memory:');
  const svc = createHistoryService({ repo, archive: memArchive(), retentionDays: 90 });
  const files = new Map<string, Buffer>();
  const ship = async (boxId: string, session: string, records: object[]) => {
    const path = `${session}.jsonl`;
    const key = `${boxId}/${path}`;
    const before = files.get(key) ?? Buffer.alloc(0);
    const data = Buffer.from(records.map((r) => JSON.stringify(r)).join('\n') + '\n');
    const all = Buffer.concat([before, data]);
    files.set(key, all);
    const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
    const frame: HistoryFrame = {
      origin: { boxId, boxName: boxId, provider: 'docker' },
      agent: AGENT,
      path,
      offset: before.length,
      sha256Prefix: before.length ? sha(before) : '',
      sha256: sha(all),
      data: data.toString('base64'),
    };
    const r = await svc.ingest(frame);
    expect(r.ok).toBe(true);
  };
  return { repo, svc, ship };
}

const box = (id: string, entry: Record<string, unknown> = { state: 'working' }): Box =>
  ({
    id,
    name: id,
    task: id,
    displayName: null,
    agentStatus: { [AGENT]: entry },
  }) as unknown as Box;

const usage = (id: string, input: number, ts: string, costUsd?: number) => ({
  kind: 'usage',
  messageId: id,
  inputTokens: input,
  outputTokens: 1,
  cacheReadTokens: 2,
  cacheWriteTokens: 3,
  ...(costUsd !== undefined ? { costUsd } : {}),
  ts,
});

afterEach(() => {
  vi.useRealTimers();
});

describe('live summary store', () => {
  it('keeps the newest activity, lets a plan line win until cleared, sums usage with cost', async () => {
    const { repo, ship } = await rig();
    await ship('b1', 'sess-a', [
      { kind: 'activity', text: 'Bash: npm test', ts: '2026-11-24T10:00:02Z' },
      { kind: 'activity', text: 'older, from a subagent file', ts: '2026-11-24T10:00:01Z' },
      usage('m1', 10, '2026-11-24T10:00:01Z', 0.5),
      usage('m2', 20, '2026-11-24T10:00:03Z', 0.25),
      { kind: 'context', tokens: 1234 },
    ]);
    let row = (await repo.liveRow(`${AGENT}:sess-a`))!;
    expect(row.activity).toBe('Bash: npm test');
    expect(liveUsage(row)).toEqual({
      input: 30,
      output: 2,
      cacheRead: 4,
      cacheWrite: 6,
      contextTokens: 1234,
      costUsd: 0.75,
      updatedAt: '2026-11-24T10:00:03Z',
    });
    await ship('b1', 'sess-a', [{ kind: 'activity', text: 'add GET /time', plan: true }]);
    row = (await repo.liveRow(`${AGENT}:sess-a`))!;
    expect(row.plan).toBe('add GET /time');
    await ship('b1', 'sess-a', [{ kind: 'activity', text: '', plan: true }]);
    expect((await repo.liveRow(`${AGENT}:sess-a`))!.plan).toBeNull();
  });

  it("prefers the agent's own cumulative totals over the usage sum", async () => {
    const { repo, ship } = await rig();
    await ship('b1', 'sess-t', [
      usage('m1', 10, '2026-11-24T10:00:01Z'),
      {
        kind: 'totals',
        inputTokens: 500,
        outputTokens: 50,
        cacheReadTokens: 9000,
        cacheWriteTokens: 0,
        reasoningTokens: 20,
        ts: '2026-11-24T10:00:05Z',
      },
      { kind: 'context', tokens: 6500, window: 258400 },
    ]);
    expect(liveUsage((await repo.liveRow(`${AGENT}:sess-t`))!)).toEqual({
      input: 500,
      output: 50,
      cacheRead: 9000,
      cacheWrite: 0,
      reasoning: 20,
      contextTokens: 6500,
      contextWindow: 258400,
      updatedAt: '2026-11-24T10:00:05Z',
    });
  });
});

describe('live status slice', () => {
  it('joins on the reported session id, else the box latest session', async () => {
    const { repo, ship } = await rig();
    await ship('b1', 'old', [
      { kind: 'turn', role: 'user', text: 'one', ts: '2026-11-24T09:00:00Z' },
    ]);
    await ship('b1', 'new', [
      { kind: 'turn', role: 'user', text: 'two', ts: '2026-11-24T10:00:00Z' },
    ]);
    expect(await currentSessionKey(repo, 'b1', AGENT, {})).toBe(`${AGENT}:new`);
    expect(await currentSessionKey(repo, 'b1', AGENT, { sessionId: 'old' })).toBe(`${AGENT}:old`);
    expect(await currentSessionKey(repo, 'b2', AGENT, {})).toBeNull();
  });

  it('enriches the entry: derived title replaces the pane title, plus activity and usage', async () => {
    const { svc, ship } = await rig();
    await ship('b1', 'sess-1', [
      { kind: 'turn', role: 'user', text: 'add a health route', ts: '2026-11-24T10:00:00Z' },
      { kind: 'meta', title: 'Health route' },
      { kind: 'activity', text: 'Edit: server.js', ts: '2026-11-24T10:00:01Z' },
      usage('m1', 10, '2026-11-24T10:00:01Z'),
    ]);
    const live = createLiveStatus({ history: () => svc, notify: () => {} });
    const out = await live.apply(
      box('b1', { state: 'working', sessionTitle: 'Claude Code', sessionId: 'sess-1' }),
    );
    expect(out.agentStatus?.[AGENT]).toMatchObject({
      state: 'working',
      sessionTitle: 'Health route',
      sessionId: 'sess-1',
      activity: 'Edit: server.js',
      usage: { input: 10, output: 1 },
    });
    expect(out.task).toBe('Health route');
    // No history for the box: the entry passes through unchanged.
    const bare = await live.apply(box('b9', { state: 'idle', sessionTitle: 'pane' }));
    expect(bare.agentStatus?.[AGENT]).toEqual({ state: 'idle', sessionTitle: 'pane' });
  });

  it('a /new moves the title with the session id', async () => {
    const { svc, ship } = await rig();
    await ship('b1', 's-old', [{ kind: 'meta', title: 'First task' }]);
    await ship('b1', 's-new', [{ kind: 'turn', role: 'user', text: 'second task please' }]);
    const live = createLiveStatus({ history: () => svc, notify: () => {} });
    const title = async (sessionId: string) =>
      (await live.apply(box('b1', { state: 'idle', sessionId }))).agentStatus?.[AGENT]
        ?.sessionTitle;
    expect(await title('s-old')).toBe('First task');
    expect(await title('s-new')).toBe('second task please');
  });

  it('notifies only on a change of the current session, at most once per box per 30s', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-24T10:00:00Z'));
    const { svc, ship } = await rig();
    let notified = 0;
    const live = createLiveStatus({ history: () => svc, notify: () => notified++ });
    live.start();
    await ship('b1', 'cur', [{ kind: 'activity', text: 'one' }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(notified).toBe(1);
    // A change inside the window (the title falls back to the first prompt)
    // waits for the window to end.
    await ship('b1', 'cur', [{ kind: 'turn', role: 'user', text: 'x' }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(notified).toBe(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(notified).toBe(2);
    // Changes inside the window collapse into one trailing notify.
    await ship('b1', 'cur', [{ kind: 'activity', text: 'two' }]);
    await ship('b1', 'cur', [{ kind: 'activity', text: 'three' }]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(notified).toBe(2);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(notified).toBe(3);
    // Once a listing resolved the current session, another session is ignored.
    await live.apply(box('b1', { state: 'working', sessionId: 'cur' }));
    await vi.advanceTimersByTimeAsync(60_000);
    await ship('b1', 'cur', [{ kind: 'activity', text: 'three' }]);
    await ship('b1', 'other', [{ kind: 'activity', text: 'background' }]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(notified).toBe(3);
    live.stop();
  });

  it('a reported session id of another box is not joined', async () => {
    const { repo, ship } = await rig();
    await ship('b1', 'mine', [{ kind: 'activity', text: 'x' }]);
    expect(await currentSessionKey(repo, 'b1', AGENT, { sessionId: 'mine' })).toBe(`${AGENT}:mine`);
    expect(await currentSessionKey(repo, 'b2', AGENT, { sessionId: 'mine' })).toBeNull();
    // Not shipped yet: the key is kept (it simply has no data).
    expect(await currentSessionKey(repo, 'b2', AGENT, { sessionId: 'unseen' })).toBe(
      `${AGENT}:unseen`,
    );
  });

  it('the fallback skips a latest session older than the last state report', async () => {
    const { repo, svc, ship } = await rig();
    await ship('b1', 'before-clear', [
      { kind: 'turn', role: 'user', text: 'old', ts: '2026-11-24T10:00:00Z' },
      { kind: 'meta', title: 'Old task' },
    ]);
    // A report within the grace (the transcript trails the hooks): still shown.
    expect(await currentSessionKey(repo, 'b1', AGENT, { updatedAt: '2026-11-24T10:01:00Z' })).toBe(
      `${AGENT}:before-clear`,
    );
    // After a /clear the agent reports again; the new session has not shipped.
    expect(
      await currentSessionKey(repo, 'b1', AGENT, { updatedAt: '2026-11-24T10:05:00Z' }),
    ).toBeNull();
    const live = createLiveStatus({ history: () => svc, notify: () => {} });
    const out = await live.apply(
      box('b1', { state: 'working', sessionTitle: 'pane', updatedAt: '2026-11-24T10:05:00Z' }),
    );
    expect(out.agentStatus?.[AGENT]).toEqual({
      state: 'working',
      sessionTitle: 'pane',
      updatedAt: '2026-11-24T10:05:00Z',
    });
  });

  it('coalesces changes of several boxes into one notify per window', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-24T10:00:00Z'));
    const { svc, ship } = await rig();
    let notified = 0;
    const live = createLiveStatus({ history: () => svc, notify: () => notified++ });
    live.start();
    await ship('b1', 's1', [{ kind: 'activity', text: 'one' }]);
    await ship('b2', 's2', [{ kind: 'activity', text: 'two' }]);
    await ship('b3', 's3', [{ kind: 'activity', text: 'three' }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(notified).toBe(1);
    await ship('b2', 's2', [{ kind: 'activity', text: 'two again' }]);
    await ship('b3', 's3', [{ kind: 'activity', text: 'three again' }]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(notified).toBe(2);
    live.stop();
  });

  it('a file reset clears the live row', async () => {
    const { repo, svc, ship } = await rig();
    await ship('b1', 'rw', [{ kind: 'activity', text: 'stale line' }]);
    expect((await repo.liveRow(`${AGENT}:rw`))?.activity).toBe('stale line');
    const data = Buffer.from(`${JSON.stringify({ kind: 'turn', role: 'user', text: 'new' })}\n`);
    const r = await svc.ingest({
      origin: { boxId: 'b1', boxName: 'b1', provider: 'docker' },
      agent: AGENT,
      path: 'rw.jsonl',
      offset: 0,
      sha256Prefix: '',
      sha256: createHash('sha256').update(data).digest('hex'),
      data: data.toString('base64'),
      reset: true,
    });
    expect(r.ok).toBe(true);
    expect((await repo.liveRow(`${AGENT}:rw`))?.activity ?? null).toBeNull();
  });

  it('without a reported session id, a newer session of the box still notifies', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-24T10:00:00Z'));
    const { svc, ship } = await rig();
    let notified = 0;
    const live = createLiveStatus({ history: () => svc, notify: () => notified++ });
    live.start();
    await ship('b1', 'first', [{ kind: 'activity', text: 'one' }]);
    await live.apply(box('b1', { state: 'working' }));
    await vi.advanceTimersByTimeAsync(60_000);
    const before = notified;
    await ship('b1', 'second', [{ kind: 'activity', text: 'after /new' }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(notified).toBe(before + 1);
    live.stop();
  });
});
