import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  registerAgentHistoryModule,
  type AgentHistoryModule,
  type HistoryFrame,
  type HistoryRecord,
} from '@agentbox/core';
import { createHistoryService, type HistoryArchive } from '../lib/backend/history';
import { openSqliteHistoryRepo } from '../lib/history-sqlite';

function memArchive(): HistoryArchive {
  const m = new Map<string, Buffer>();
  return {
    put: async (k, b) => void m.set(k, Buffer.from(b)),
    get: async (k) => m.get(k) ?? Buffer.alloc(0),
    delete: async (k) => void m.delete(k),
  };
}

// One usage line per message: {id, ts, model, in, out, cr, cw}.
function lineModule(id: string): AgentHistoryModule {
  return {
    id,
    parserVersion: 1,
    identify: (_h, path) => ({ sessionId: path.replace(/^.*\//, '').replace(/\.jsonl$/, '') }),
    parse(chunk, state) {
      const text = (state.partial as string | undefined) ?? '';
      const lines = (text + Buffer.from(chunk.bytes).toString('utf8')).split('\n');
      const partial = lines.pop() ?? '';
      const records: HistoryRecord[] = lines.map((raw) => {
        const l = JSON.parse(raw) as Record<string, string | number>;
        return {
          kind: 'usage',
          messageId: String(l.id),
          model: String(l.model),
          inputTokens: Number(l.in),
          outputTokens: Number(l.out),
          cacheReadTokens: Number(l.cr ?? 0),
          cacheWriteTokens: Number(l.cw ?? 0),
          ...(l.ts ? { ts: String(l.ts) } : {}),
          at: chunk.offset,
        };
      });
      return { records, state: { partial } };
    },
  };
}

beforeAll(() => {
  registerAgentHistoryModule(lineModule('claude'));
  registerAgentHistoryModule(lineModule('codex'));
});

async function setup(accounts: Record<string, string> = {}) {
  const repo = await openSqliteHistoryRepo(':memory:');
  const svc = createHistoryService({
    repo,
    archive: memArchive(),
    retentionDays: 90,
    accountOf: async (boxId, agent) =>
      boxId in accounts
        ? accounts[boxId] === ''
          ? 'default'
          : `${agent}/${accounts[boxId]!}`
        : null,
  });
  const ship = async (
    o: { boxId: string; boxName?: string; hostId?: string; repo?: string },
    agent: string,
    sessionId: string,
    rows: object[],
  ) => {
    const data = Buffer.from(rows.map((r) => `${JSON.stringify(r)}\n`).join(''));
    const frame: HistoryFrame = {
      origin: {
        boxId: o.boxId,
        boxName: o.boxName ?? o.boxId,
        provider: 'docker',
        ...(o.hostId ? { hostId: o.hostId } : {}),
        ...(o.repo ? { projectRepoUrl: o.repo } : {}),
      },
      agent,
      path: `sessions/${sessionId}.jsonl`,
      offset: 0,
      sha256Prefix: '',
      sha256: createHash('sha256').update(data).digest('hex'),
      data: data.toString('base64'),
    };
    expect(await svc.ingest(frame)).toMatchObject({ ok: true });
  };
  return { svc, repo, ship };
}

const day1 = '2026-11-20T10:00:00.000Z';
const day1late = '2026-11-20T23:30:00.000Z';
const day2 = '2026-11-21T09:00:00.000Z';

describe('usage (Phase 7)', () => {
  it('sums by agent, model, box and day, with totals and filters', async () => {
    const { svc, ship } = await setup({ b1: '', b2: 'work' });
    await ship(
      { boxId: 'b1', boxName: 'one', hostId: 'pc1', repo: 'git@x:o/a.git' },
      'claude',
      's1',
      [
        { id: 'm1', ts: day1, model: 'opus', in: 10, out: 5, cr: 100, cw: 20 },
        { id: 'm2', ts: day1late, model: 'opus', in: 1, out: 1 },
        { id: 'm1', ts: day1, model: 'opus', in: 10, out: 5, cr: 100, cw: 20 },
      ],
    );
    await ship(
      { boxId: 'b2', boxName: 'two', hostId: 'pc2', repo: 'https://x/o/b' },
      'codex',
      's2',
      [{ id: 'r1', ts: day2, model: 'gpt', in: 50, out: 7 }],
    );

    const all = await svc.usage({ by: [], tzOffsetMin: 0, limit: 50 });
    expect(all.totals).toEqual({
      inputTokens: 61,
      outputTokens: 13,
      cacheReadTokens: 100,
      cacheWriteTokens: 20,
      totalTokens: 194,
      messages: 3,
      sessions: 2,
    });

    const byDay = await svc.usage({ by: ['day'], tzOffsetMin: 0, limit: 50 });
    expect(byDay.groups.map((g) => [g.keys.day, g.totalTokens])).toEqual([
      ['2026-11-20', 137],
      ['2026-11-21', 57],
    ]);
    // 23:30Z is the next day an hour east of UTC.
    const cet = await svc.usage({ by: ['day'], tzOffsetMin: 60, limit: 50 });
    expect(cet.groups.map((g) => [g.keys.day, g.messages])).toEqual([
      ['2026-11-20', 1],
      ['2026-11-21', 2],
    ]);

    const byBox = await svc.usage({ by: ['box', 'agent'], tzOffsetMin: 0, limit: 50 });
    expect(byBox.groups[0]).toMatchObject({
      keys: { box: 'b1', agent: 'claude' },
      labels: { box: 'one' },
      totalTokens: 137,
    });

    const byAccount = await svc.usage({ by: ['account'], tzOffsetMin: 0, limit: 50 });
    expect(byAccount.groups.map((g) => g.keys.account).sort()).toEqual(['codex/work', 'default']);

    expect(
      (await svc.usage({ by: [], tzOffsetMin: 0, limit: 50, project: 'o/b' })).totals.messages,
    ).toBe(1);
    expect(
      (await svc.usage({ by: [], tzOffsetMin: 0, limit: 50, box: 'one' })).totals.messages,
    ).toBe(2);
    expect(
      (await svc.usage({ by: [], tzOffsetMin: 0, limit: 50, host: 'pc2' })).totals.messages,
    ).toBe(1);
    expect(
      (await svc.usage({ by: [], tzOffsetMin: 0, limit: 50, model: 'opus', agent: 'claude' }))
        .totals.messages,
    ).toBe(2);
    const window = await svc.usage({
      by: [],
      tzOffsetMin: 0,
      limit: 50,
      sinceMs: Date.parse('2026-11-20T12:00:00Z'),
      untilMs: Date.parse('2026-11-21T00:00:00Z'),
    });
    expect(window.totals.messages).toBe(1);

    const one = await svc.usage({ by: ['agent'], tzOffsetMin: 0, limit: 1 });
    expect(one).toMatchObject({ truncated: true, groups: [{ keys: { agent: 'claude' } }] });
  });

  it('backfills the account of sessions stored before the box was known', async () => {
    const accounts: Record<string, string> = {};
    const { svc, ship, repo } = await setup(accounts);
    await ship({ boxId: 'b9' }, 'claude', 's9', [{ id: 'm', ts: day1, model: 'x', in: 1, out: 1 }]);
    await ship({ boxId: 'gone' }, 'claude', 's8', [
      { id: 'm', ts: day1, model: 'x', in: 1, out: 1 },
    ]);
    expect((await repo.getSession('claude:s9'))!.account).toBeNull();
    accounts.b9 = 'team';
    expect(await svc.backfillAccounts()).toBe(1);
    expect((await repo.getSession('claude:s9'))!.account).toBe('claude/team');
    expect((await repo.getSession('claude:s8'))!.account).toBeNull();
  });

  it('migrates a pre-Phase-7 store: message times filled from ts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'usage-mig-'));
    const path = join(dir, 'history.db');
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE history_sessions (key TEXT PRIMARY KEY, agent TEXT NOT NULL, session_id TEXT NOT NULL,
      box_id TEXT, box_name TEXT, provider TEXT, host_id TEXT, project_repo_url TEXT, workspace_id TEXT,
      manager_id TEXT, user_id TEXT, parent_session_id TEXT, first_ts TEXT, last_ts TEXT, title TEXT,
      turns INTEGER NOT NULL DEFAULT 0, input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0, parser_version INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE (agent, session_id));
      CREATE TABLE history_usage (session_key TEXT NOT NULL, message_id TEXT NOT NULL, file_id INTEGER NOT NULL,
      model TEXT, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL,
      cache_read_tokens INTEGER NOT NULL, cache_write_tokens INTEGER NOT NULL, ts TEXT,
      PRIMARY KEY (session_key, message_id));
      INSERT INTO history_sessions (key, agent, session_id, created_at, updated_at) VALUES ('claude:o', 'claude', 'o', 1, 1);
      INSERT INTO history_usage VALUES ('claude:o', 'm', 1, 'x', 4, 2, 0, 0, '${day2}');`);
    old.close();
    const repo = await openSqliteHistoryRepo(path);
    const r = await repo.usage({ by: ['day'], tzOffsetMin: 0, limit: 10 });
    expect(r.groups).toMatchObject([{ keys: { day: '2026-11-21' }, totalTokens: 6 }]);
    const inWindow = await repo.usage({
      by: [],
      tzOffsetMin: 0,
      limit: 10,
      sinceMs: Date.parse(day2),
      untilMs: Date.parse(day2) + 1,
    });
    expect(inWindow.totals.messages).toBe(1);
  });
});
