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
import { subscriptionOf } from '../lib/backend/accounts';
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
        if (l.limits) {
          return {
            kind: 'limits',
            windows: [{ id: 'primary', pct: Number(l.limits), windowMinutes: 10080 }],
            ...(l.ts ? { ts: String(l.ts) } : {}),
            at: chunk.offset,
          };
        }
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
      boxId in accounts ? `${agent}/${accounts[boxId] || 'default'}` : null,
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
    expect(byAccount.groups.map((g) => g.keys.account).sort()).toEqual([
      'claude/default',
      'codex/work',
    ]);
    const msgs = async (account: string) =>
      (await svc.usage({ by: [], tzOffsetMin: 0, limit: 50, account })).totals.messages;
    expect(await msgs('codex/work')).toBe(1);
    expect(await msgs('claude/work')).toBe(0);
    expect(await msgs('work')).toBe(1);
    expect(await msgs('claude/default')).toBe(2);
    expect(await msgs('w%')).toBe(0);

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

    // A truncated day report keeps the newest days, still in time order.
    const lastDay = await svc.usage({ by: ['day'], tzOffsetMin: 0, limit: 1 });
    expect(lastDay).toMatchObject({ truncated: true, groups: [{ keys: { day: '2026-11-21' } }] });
    const days = await svc.usage({ by: ['day', 'agent'], tzOffsetMin: 0, limit: 50 });
    expect(days.groups.map((g) => g.keys.day)).toEqual(['2026-11-20', '2026-11-21']);

    const one = await svc.usage({ by: ['agent'], tzOffsetMin: 0, limit: 1 });
    expect(one).toMatchObject({ truncated: true, groups: [{ keys: { agent: 'claude' } }] });
  });

  it('groups one repo spelled ssh and https as one project', async () => {
    const { svc, ship } = await setup();
    const row = { id: 'm', ts: day1, model: 'x', in: 1, out: 1 };
    await ship({ boxId: 'b1', repo: 'git@github.com:Acme/API.git' }, 'claude', 'p1', [row]);
    await ship({ boxId: 'b2', repo: 'https://github.com/acme/api' }, 'claude', 'p2', [row]);
    const r = await svc.usage({ by: ['project'], tzOffsetMin: 0, limit: 10 });
    expect(r.groups).toHaveLength(1);
    expect(r.groups[0]).toMatchObject({ keys: { project: 'github.com/acme/api' }, sessions: 2 });
    for (const project of ['github.com/acme/api', 'acme/api', 'git@github.com:acme/api.git']) {
      const f = await svc.usage({ by: [], tzOffsetMin: 0, limit: 10, project });
      expect(f.totals.sessions).toBe(2);
    }
  });

  it('filters a project by its key exactly, a bare fragment by substring', async () => {
    const { svc, ship } = await setup();
    const tokens = (n: number) => [{ id: 'm', ts: day1, model: 'x', in: n, out: 0 }];
    await ship(
      { boxId: 'b1', repo: 'git@github.com:madarco/agentbox.git' },
      'claude',
      'r1',
      tokens(100),
    );
    await ship(
      { boxId: 'b2', repo: 'https://github.com/madarco/agentbox-tray' },
      'claude',
      'r2',
      tokens(10),
    );
    await ship(
      { boxId: 'b3', repo: 'git@github.com:madarco/agentbox-test-repo' },
      'claude',
      'r3',
      tokens(1),
    );
    await ship({ boxId: 'b4', repo: '/home/u/agentbox' }, 'claude', 'r4', tokens(1000));
    await ship({ boxId: 'b5', repo: '/home/u/agentbox2' }, 'claude', 'r5', tokens(10000));
    const total = async (project: string) =>
      (await svc.usage({ by: [], tzOffsetMin: 0, limit: 10, project })).totals.inputTokens;
    // What the page sends from a By-project row, and the URL spellings.
    expect(await total('github.com/madarco/agentbox')).toBe(100);
    expect(await total('https://github.com/madarco/agentbox')).toBe(100);
    expect(await total('git@github.com:madarco/agentbox.git')).toBe(100);
    expect(await total('/home/u/agentbox')).toBe(1000);
    // A fragment is a substring search, as documented.
    expect(await total('madarco/agentbox')).toBe(111);
    // The group keys round-trip through the filter.
    const groups = await svc.usage({ by: ['project'], tzOffsetMin: 0, limit: 10 });
    for (const g of groups.groups) {
      expect(await total(g.keys.project!)).toBe(g.inputTokens);
    }
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

  it('keeps the newest limits per subscription, across its sessions (3b)', async () => {
    const { svc, ship, repo } = await setup({ b1: 'work', b2: 'work', b3: '' });
    await ship({ boxId: 'b1' }, 'codex', 'x1', [{ limits: 20, ts: day1 }]);
    await ship({ boxId: 'b2' }, 'codex', 'x2', [{ limits: 55, ts: day2 }]);
    // An older record shipped later does not win.
    await ship({ boxId: 'b1' }, 'codex', 'x3', [{ limits: 10, ts: day1late }]);
    await ship({ boxId: 'b3' }, 'codex', 'x4', [{ limits: 90, ts: day1 }]);
    expect(await repo.accountLimits('codex/work')).toMatchObject({
      windows: [{ id: 'primary', pct: 55, windowMinutes: 10080 }],
      ts: day2,
    });
    expect((await repo.accountLimits('codex/default'))?.windows[0]?.pct).toBe(90);
    expect(await repo.accountLimits('codex/none')).toBeNull();
    // Limits are not turns or usage.
    expect((await svc.usage({ by: [], tzOffsetMin: 0, limit: 10 })).totals.messages).toBe(0);
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
      ALTER TABLE history_sessions ADD COLUMN account TEXT;
      INSERT INTO history_sessions (key, agent, session_id, account, created_at, updated_at) VALUES ('codex:p', 'codex', 'p', 'work', 1, 1);
      INSERT INTO history_sessions (key, agent, session_id, box_id, account, created_at, updated_at) VALUES ('pi:q', 'pi', 'q', 'bq', 'default', 1, 1);
      INSERT INTO history_usage VALUES ('claude:o', 'm', 1, 'x', 4, 2, 0, 0, '${day2}');`);
    old.close();
    const repo = await openSqliteHistoryRepo(path, { borrowingAgents: ['pi'] });
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
    // A bare account id (before hub settings 3a) becomes the agent's subscription.
    expect((await repo.getSession('codex:p'))!.account).toBe('codex/work');
    // A borrowing agent's bare id may be a lender's: cleared for the backfill.
    expect((await repo.getSession('pi:q'))!.account).toBeNull();
    const svc = createHistoryService({
      repo,
      archive: memArchive(),
      retentionDays: 90,
      accountOf: async (boxId, agent) =>
        boxId === 'bq' ? subscriptionOf({ borrowedCredentials: ['codex'] }, agent) : null,
    });
    expect(await svc.backfillAccounts()).toBe(1);
    expect((await repo.getSession('pi:q'))!.account).toBe('codex/default');

    // A second open changes nothing.
    const again = await openSqliteHistoryRepo(path, { borrowingAgents: ['pi'] });
    expect((await again.getSession('pi:q'))!.account).toBe('codex/default');
    expect((await again.getSession('codex:p'))!.account).toBe('codex/work');
  });
});
