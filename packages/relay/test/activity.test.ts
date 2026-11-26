import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  activityFromTimeline,
  backfillActivityFromTimelines,
  configureActivityBoxContext,
  configureActivityLedger,
  ensureActivityBackfill,
  recordActivity,
  SqliteActivityStore,
  type ActivityStore,
  type ActivityEvent,
} from '../src/activity/index.js';
import {
  recordBoxGitPush,
  recordBoxPushed,
  recordCreateJobTimeline,
} from '../src/timeline-hooks.js';
import { configureBoxPushStat } from '../src/workspaces/push-stat.js';
import { configureTimelineSink, type TimelineSink } from '../src/workspaces/timeline-sink.js';
import type { TimelineEvent } from '../src/workspaces/types.js';
import type { QueueJob } from '../src/queue.js';

const run = promisify(execFile);

let store: ActivityStore;

beforeEach(async () => {
  store = new SqliteActivityStore(':memory:');
  await store.migrate();
  configureActivityLedger(store);
  configureActivityBoxContext(async () => undefined);
});

afterEach(async () => {
  configureActivityLedger(null);
  configureActivityBoxContext(null);
  configureTimelineSink(null);
  configureBoxPushStat(null);
  await store.close();
});

/** A sink with no workspace for anything: the box is outside every workspace. */
function noWorkspaceSink(): { sink: TimelineSink; recorded: number } {
  const out = { recorded: 0 } as { sink: TimelineSink; recorded: number };
  out.sink = {
    kind: 'file',
    record: async () => {
      out.recorded += 1;
      return null;
    },
    workspaceFor: async () => null,
  };
  return out;
}

describe('the activity store', () => {
  it('ignores a row whose id it already has, and filters by window, type and box', async () => {
    const at = (m: number): string => new Date(Date.UTC(2026, 10, 1, 0, m)).toISOString();
    const rows = [
      { id: 'a', type: 'box.started', at: at(0), boxId: 'b1', source: 'live' },
      { id: 'b', type: 'box.paused', at: at(5), boxId: 'b1', source: 'live' },
      { id: 'c', type: 'box.resumed', at: at(10), boxId: 'b2', source: 'live' },
      {
        id: 'd',
        type: 'git.push',
        at: at(15),
        boxId: 'b1',
        commits: 2,
        filesChanged: 3,
        additions: 10,
        deletions: 1,
        hostOnly: false,
        pr: undefined,
        source: 'live',
      },
    ] as const;
    expect(await store.append(rows)).toBe(4);
    expect(await store.append(rows)).toBe(0);
    expect((await store.list()).map((e) => e.id)).toEqual(['a', 'b', 'c', 'd']);
    const win = await store.list({ sinceMs: Date.parse(at(5)), untilMs: Date.parse(at(15)) });
    expect(win.map((e) => e.id)).toEqual(['b', 'c']);
    expect((await store.list({ types: ['box.paused', 'box.resumed'] })).map((e) => e.id)).toEqual([
      'b',
      'c',
    ]);
    expect((await store.list({ boxId: 'b1', limit: 2 })).map((e) => e.id)).toEqual(['a', 'b']);
    const push = (await store.list({ types: ['git.push'] }))[0];
    expect(push).toMatchObject({ commits: 2, filesChanged: 3, additions: 10, deletions: 1 });
    expect(push?.hostOnly).toBe(false);
  });

  it('answers which ids it holds, and takes the newest rows with order desc', async () => {
    const at = (m: number): string => new Date(Date.UTC(2026, 10, 1, 0, m)).toISOString();
    await store.append(
      [0, 1, 2, 3].map((m) => ({
        id: `r${String(m)}`,
        type: 'box.started' as const,
        at: at(m),
        source: 'live' as const,
      })),
    );
    expect([...(await store.has(['r1', 'nope', 'r3']))].sort()).toEqual(['r1', 'r3']);
    expect((await store.list({ limit: 2, order: 'desc' })).map((e) => e.id)).toEqual(['r2', 'r3']);
    expect((await store.list({ limit: 2 })).map((e) => e.id)).toEqual(['r0', 'r1']);
  });

  it('lists each open branch once, by its newest work, and drops a merged one', async () => {
    const at = (m: number): string => new Date(Date.UTC(2026, 10, 1, 0, m)).toISOString();
    const row = (
      id: string,
      type: ActivityEvent['type'],
      m: number,
      branch: string,
      boxId: string,
    ) => ({
      id,
      type,
      at: at(m),
      branch,
      boxId,
      projectKey: 'github.com/acme/x',
      repoUrl: 'git@github.com:acme/x.git',
      source: 'live' as const,
    });
    await store.append([
      row('a1', 'box.ready', 0, 'open', 'old-box'),
      row('a2', 'git.push', 5, 'open', 'new-box'),
      row('b1', 'git.push', 1, 'merged', 'box-b'),
      row('b2', 'pr.merged', 2, 'merged', 'box-b'),
      row('c1', 'git.push', 3, 'reopened', 'box-c'),
      row('c2', 'pr.merged', 4, 'reopened', 'box-c'),
      row('c3', 'git.push', 6, 'reopened', 'box-c'),
    ]);
    const open = await store.openBranches(Date.UTC(2026, 10, 1), 10);
    expect(open.map((e) => [e.branch, e.boxId])).toEqual([
      ['reopened', 'box-c'],
      ['open', 'new-box'],
    ]);
    expect(await store.openBranches(Date.UTC(2026, 10, 1), 1)).toHaveLength(1);
  });

  it('stamps its creation time once', async () => {
    const first = await store.getMeta('created_at');
    expect(Number(first)).toBeGreaterThan(0);
    await store.migrate();
    expect(await store.getMeta('created_at')).toBe(first);
  });
});

describe('recordActivity', () => {
  it('is a no-op with no ledger installed', async () => {
    configureActivityLedger(null);
    expect(await recordActivity({ type: 'box.started', boxId: 'b1' })).toBeNull();
  });

  it('fills the box context under what the caller said, and derives the project key', async () => {
    configureActivityBoxContext(async () => ({
      boxName: 'from-record',
      provider: 'hetzner',
      agent: 'claude',
      account: 'claude/work',
      repoUrl: 'git@github.com:Acme/Store.git',
    }));
    const ev = await recordActivity({ type: 'box.stopped', boxId: 'b1', boxName: 'given' });
    expect(ev).toMatchObject({
      type: 'box.stopped',
      boxName: 'given',
      provider: 'hetzner',
      account: 'claude/work',
      projectKey: 'github.com/acme/store',
      source: 'live',
    });
  });
});

async function gitRepo(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'agentbox-activity-git-')));
  const git = (...args: string[]) => run('git', ['-C', dir, ...args]);
  await git('init', '-q', '-b', 'main');
  await git('config', 'user.email', 't@example.com');
  await git('config', 'user.name', 't');
  await git('config', 'commit.gpgsign', 'false');
  await writeFile(join(dir, 'base.txt'), 'base\n');
  await git('add', '.');
  await git('commit', '-q', '-m', 'base');
  await git('checkout', '-q', '-b', 'agentbox/smoke');
  for (const [file, lines] of [
    ['a.txt', 3],
    ['b.txt', 2],
  ] as const) {
    await writeFile(join(dir, file), 'x\n'.repeat(lines));
    await git('add', file);
    await git('commit', '-q', '-m', file);
  }
  return dir;
}

describe('a push from a box outside any workspace', () => {
  const ctx = {
    boxId: 'box1',
    boxName: 'smoke',
    hostPath: '/nowhere',
    branch: 'agentbox/smoke',
    originUrl: 'git@github.com:acme/storefront.git',
  };

  it('lands in the ledger with commits and files, measured on the host repo', async () => {
    const { sink, recorded } = noWorkspaceSink();
    configureTimelineSink(sink);
    const repo = await gitRepo();
    await recordBoxGitPush(
      ctx,
      { hostInitiated: false, hostOnly: false },
      { exitCode: 0 },
      { repo, ref: 'refs/heads/agentbox/smoke', branch: 'agentbox/smoke' },
    );
    expect(recorded).toBe(0);
    const rows = await store.list({ types: ['git.push'] });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      boxId: 'box1',
      boxName: 'smoke',
      branch: 'agentbox/smoke',
      commits: 2,
      filesChanged: 2,
      additions: 5,
      deletions: 0,
      projectKey: 'github.com/acme/storefront',
      actor: 'box',
    });
    expect(rows[0]?.workspaceId).toBeUndefined();
  });

  it('lands once for a box-reported push, measured in the box, however often it is reported', async () => {
    configureTimelineSink(noWorkspaceSink().sink);
    configureBoxPushStat(async () => ({
      additions: 12,
      deletions: 3,
      commits: 4,
      filesChanged: 5,
    }));
    const notice = { branch: 'agentbox/smoke', before: 'a'.repeat(40), after: 'b'.repeat(40) };
    await recordBoxPushed(ctx, notice);
    await recordBoxPushed(ctx, notice);
    const rows = await store.list({ types: ['git.push'] });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: `push:box1:${'b'.repeat(40)}`,
      commits: 4,
      filesChanged: 5,
      additions: 12,
      deletions: 3,
    });
  });

  it('records a host-only landing flagged, and keeps it off the timeline', async () => {
    const { sink } = noWorkspaceSink();
    let asked = 0;
    configureTimelineSink({ ...sink, workspaceFor: async () => (asked++, { id: 'ws1' }) });
    configureBoxPushStat(async () => ({ additions: 1, deletions: 0, commits: 1, filesChanged: 1 }));
    await recordBoxGitPush(ctx, { hostInitiated: false, hostOnly: true }, { exitCode: 0 });
    const rows = await store.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ type: 'git.push', hostOnly: true, commits: 1 });
    expect(rows[0]?.workspaceId).toBeUndefined();
    expect(asked).toBe(0);
  });

  it('skips a failed push and a host-initiated one (the hub route records that)', async () => {
    configureTimelineSink(noWorkspaceSink().sink);
    await recordBoxGitPush(ctx, { hostInitiated: false, hostOnly: false }, { exitCode: 1 });
    await recordBoxGitPush(ctx, { hostInitiated: true, hostOnly: false }, { exitCode: 0 });
    expect(await store.list()).toEqual([]);
  });
});

describe('a create job outside any workspace', () => {
  it('records box.ready under the timeline key', async () => {
    configureTimelineSink(noWorkspaceSink().sink);
    const job = {
      id: 'j1',
      status: 'done',
      kind: 'create',
      agent: 'claude-code',
      boxId: 'box9',
      boxName: 'nine',
      providerName: 'docker',
      createOpts: { workspace: '/tmp/x' },
      maxConcurrent: 1,
      createdAt: new Date().toISOString(),
      logPath: '/tmp/j1.log',
    } as unknown as QueueJob;
    await recordCreateJobTimeline(job);
    await recordCreateJobTimeline(job);
    const rows = await store.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 'job:j1:ready',
      type: 'box.ready',
      boxId: 'box9',
      boxName: 'nine',
      agent: 'claude',
      provider: 'docker',
      jobId: 'j1',
    });
  });
});

function tl(over: Partial<TimelineEvent> & Pick<TimelineEvent, 'id' | 'type' | 'at'>): string {
  return JSON.stringify({ actor: 'hub', ...over });
}

async function timelineRoot(lines: string[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'agentbox-activity-ws-'));
  const dir = join(root, 'ws1');
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'workspace.json'),
    JSON.stringify({
      id: 'ws1',
      projects: [{ id: 'p1', repoUrl: 'git@github.com:acme/storefront.git' }],
    }),
  );
  await writeFile(join(dir, 'timeline.jsonl'), lines.join('\n') + '\n');
  return root;
}

describe('the timeline backfill', () => {
  const lines = [
    tl({
      id: '1',
      type: 'box.created',
      at: '2026-09-01T10:00:00.000Z',
      key: 'job:j1:created',
      boxName: 'one',
    }),
    tl({
      id: '2',
      type: 'box.ready',
      at: '2026-09-01T10:02:00.000Z',
      key: 'job:j1:ready',
      boxId: 'b1',
    }),
    tl({ id: '3', type: 'box.stopped', at: '2026-09-01T12:00:00.000Z', boxId: 'b1' }),
    tl({
      id: '4',
      type: 'git.push',
      at: '2026-09-01T11:00:00.000Z',
      boxId: 'b1',
      branch: 'agentbox/one',
      additions: 40,
      deletions: 2,
    }),
    tl({
      id: '5',
      type: 'pr.merged',
      at: '2026-09-02T09:00:00.000Z',
      key: 'pr:acme/storefront#7:merged',
      pr: {
        repo: 'acme/storefront',
        number: 7,
        title: 'x',
        url: 'https://github.com/acme/storefront/pull/7',
        base: 'main',
        head: 'agentbox/one',
      },
    }),
    tl({ id: '6', type: 'task.created', at: '2026-09-01T09:00:00.000Z' }),
    'not json',
    tl({ id: '7', type: 'box.destroyed', at: '2099-01-01T00:00:00.000Z', boxId: 'b1' }),
  ];

  it('imports the ledger types before the cutoff, and a rerun inserts nothing', async () => {
    const root = await timelineRoot(lines);
    const cutoffMs = Date.parse('2030-01-01T00:00:00.000Z');
    const first = await backfillActivityFromTimelines(store, { root, cutoffMs });
    expect(first).toMatchObject({ workspaces: 1, read: 8, mapped: 5, inserted: 5 });
    expect(first.byType).toEqual({
      'box.created': 1,
      'box.ready': 1,
      'box.stopped': 1,
      'git.push': 1,
      'pr.merged': 1,
    });
    const again = await backfillActivityFromTimelines(store, { root, cutoffMs });
    expect(again.inserted).toBe(0);
    const rows = await store.list();
    expect(rows.map((r) => r.id)).toEqual([
      'job:j1:created',
      'job:j1:ready',
      'tl:4',
      'tl:3',
      'pr:acme/storefront#7:merged',
    ]);
    expect(rows.every((r) => r.source === 'backfill' && r.workspaceId === 'ws1')).toBe(true);
    expect(rows[0]).toMatchObject({ jobId: 'j1', projectKey: 'github.com/acme/storefront' });
    expect(rows[4]).toMatchObject({ pr: { repo: 'acme/storefront', number: 7 } });
  });

  it('dedupes against a live row with the same key, and runs once through ensureActivityBackfill', async () => {
    await recordActivity({ id: 'job:j1:ready', type: 'box.ready', boxId: 'b1' });
    const root = await timelineRoot(lines);
    const first = await ensureActivityBackfill(store, { root, cutoffMs: Date.parse('2030-01-01') });
    expect(first?.inserted).toBe(4);
    expect(await ensureActivityBackfill(store, { root })).toBeNull();
    const ready = await store.list({ types: ['box.ready'] });
    expect(ready).toHaveLength(1);
    expect(ready[0]?.source).toBe('live');
  });

  it('takes the ledger creation time as the default cutoff', async () => {
    const root = await timelineRoot([
      tl({ id: 'old', type: 'box.started', at: '2026-01-01T00:00:00.000Z', boxId: 'b1' }),
      tl({ id: 'new', type: 'box.started', at: '2099-01-01T00:00:00.000Z', boxId: 'b1' }),
    ]);
    const r = await backfillActivityFromTimelines(store, { root });
    expect(r.inserted).toBe(1);
    expect((await store.list())[0]?.id).toBe('tl:old');
  });

  // The bound catches a per-row transaction (tens of seconds for 5000 rows), not
  // jitter: shared CI runners take over a second for the batched import.
  it('imports 5000 lines in a few seconds', async () => {
    const many: string[] = [];
    const start = Date.parse('2026-09-01T00:00:00.000Z');
    for (let i = 0; i < 5000; i++) {
      many.push(
        tl({
          id: `e${String(i)}`,
          type: i % 2 ? 'box.started' : 'box.stopped',
          at: new Date(start + i * 60_000).toISOString(),
          boxId: `b${String(i % 20)}`,
        }),
      );
    }
    const root = await timelineRoot(many);
    const t0 = Date.now();
    const r = await backfillActivityFromTimelines(store, {
      root,
      cutoffMs: Date.parse('2030-01-01'),
    });
    expect(r.inserted).toBe(5000);
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it('maps no line the ledger does not keep', () => {
    expect(
      activityFromTimeline(
        { id: 'x', at: '2026-09-01T00:00:00.000Z', type: 'manager.note', actor: 'manager' },
        'ws',
      ),
    ).toBeNull();
  });
});
