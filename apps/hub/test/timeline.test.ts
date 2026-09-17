import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { assertTempHome } from '../../../scripts/test-home.js';
import { backgroundSettled } from '../lib/backend/background';
import { createManagerBackend } from '../lib/backend/managers';
import { createWorkspaceBackend } from '../lib/backend/workspaces';
import { createGithubPrSync } from '../lib/backend/github-prs';
import {
  aggregateTimeline,
  branchUrlOf,
  buildTimelineSummary,
  createTimelineBackend,
  liveReadyItems,
  parseShortstat,
  repoUrlOfPrUrl,
  stampInWorkspace,
  withBoxTimeline,
  type RepoWebLookup,
} from '../lib/backend/timeline';
import type { BackendDeps, TimelineBoxFact } from '../lib/backend/deps';
import type { HubBackend } from '../lib/boxes/backend-types';
import { hashProjectPath } from '@agentbox/config';
import { scratchBranchName } from '@agentbox/sandbox-core';
import {
  attachBoxToManager,
  readTimeline,
  readWorkspace,
  recordTimelineEvent,
  resolveWorkspaceDir,
  timelineFile,
  type TimelineEvent,
} from '@agentbox/relay';

const S1 = '5edc0ee0-ce9a-4e30-962d-bc630388d8bc';
const S2 = '6fdc0ee0-ce9a-4e30-962d-bc630388d8bc';
const S3 = '7fdc0ee0-ce9a-4e30-962d-bc630388d8bc';
const MGR = '0123456789abcdef';

let seq = 0;
function ev(over: Partial<TimelineEvent> & Pick<TimelineEvent, 'type'>): TimelineEvent {
  seq += 1;
  return {
    id: `id${String(seq).padStart(4, '0')}`,
    at: new Date(Date.UTC(2026, 8, 13, 10, 0, seq)).toISOString(),
    actor: 'manager',
    ...over,
  };
}

function created(taskId: string, over: Partial<TimelineEvent> = {}): TimelineEvent {
  return ev({
    type: 'task.created',
    managerId: MGR,
    turn: 12,
    prompt: 'plan the checkout work',
    task: { id: taskId, title: taskId, to: 'todo' },
    taskIds: [taskId],
    ...over,
  });
}

const pr = (number: number, over: Partial<NonNullable<TimelineEvent['pr']>> = {}) => ({
  repo: 'o/r',
  number,
  title: `PR ${String(number)}`,
  url: `https://github.com/o/r/pull/${String(number)}`,
  base: 'main',
  head: `agentbox/b${String(number)}`,
  ...over,
});

describe('aggregateTimeline', () => {
  it('collapses 3+ task creates from one manager turn into one plan item', () => {
    const items = aggregateTimeline([created('T-1'), created('T-2'), created('T-3')]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      type: 'plan',
      count: 3,
      managerId: MGR,
      turn: 12,
      prompt: 'plan the checkout work',
      taskIds: ['T-1', 'T-2', 'T-3'],
    });
  });

  it('leaves two creates, other turns and creates outside the window alone', () => {
    expect(aggregateTimeline([created('T-1'), created('T-2')]).map((i) => i.type)).toEqual([
      'task.created',
      'task.created',
    ]);
    const spread = aggregateTimeline([
      created('T-1'),
      created('T-2', { turn: 13 }),
      created('T-3', { at: '2026-09-13T11:00:00.000Z' }),
    ]);
    expect(spread.every((i) => i.type === 'task.created')).toBe(true);
  });

  it('drops a move to in_progress that is just the assignment, and marks an approved merge', () => {
    const items = aggregateTimeline([
      ev({ type: 'task.assigned', taskIds: ['T-4'] }),
      ev({ type: 'task.status', task: { id: 'T-4', title: 'x', from: 'todo', to: 'in_progress' } }),
      ev({
        type: 'manager.message',
        actor: 'human',
        managerId: MGR,
        pr: pr(409),
        text: 'Approved',
      }),
      ev({ type: 'pr.merged', actor: 'github', pr: pr(409) }),
      ev({ type: 'pr.merged', actor: 'github', pr: pr(405) }),
    ]);
    expect(items.map((i) => i.type)).toEqual([
      'pr.merged',
      'pr.merged',
      'manager.message',
      'task.assigned',
    ]);
    expect(items.find((i) => i.pr?.number === 409)?.approvedByYou).toBe(true);
    expect(items.find((i) => i.pr?.number === 405)?.approvedByYou).toBeUndefined();
  });

  it('matches a message by repo and number, and a repo-less one only when the number is unambiguous', () => {
    const other = pr(409, { repo: 'o/other', url: 'https://github.com/o/other/pull/409' });
    const merged = ev({ type: 'pr.merged', actor: 'github', pr: pr(409) });
    const wrongRepo = ev({ type: 'manager.message', actor: 'human', pr: other });
    expect(
      aggregateTimeline([wrongRepo, merged]).find((i) => i.type === 'pr.merged')?.approvedByYou,
    ).toBeUndefined();

    const bare = ev({ type: 'manager.message', actor: 'human', pr: pr(409, { repo: '' }) });
    const single = aggregateTimeline([
      bare,
      ev({ type: 'pr.merged', actor: 'github', pr: pr(409) }),
    ]);
    expect(single.find((i) => i.type === 'pr.merged')?.approvedByYou).toBe(true);

    const ambiguous = aggregateTimeline([
      ev({ type: 'pr.ready', actor: 'github', pr: other }),
      bare,
      ev({ type: 'pr.merged', actor: 'github', pr: pr(409) }),
    ]);
    expect(ambiguous.find((i) => i.type === 'pr.merged')?.approvedByYou).toBeUndefined();
  });
});

describe('live rows and summary', () => {
  it('keeps a ready PR live until it merges, and marks it approved once messaged', () => {
    const ready409 = ev({ type: 'pr.ready', actor: 'github', pr: pr(409), boxId: 'b1' });
    const ready405 = ev({ type: 'pr.ready', actor: 'github', pr: pr(405) });
    const merged405 = ev({ type: 'pr.merged', actor: 'github', pr: pr(405) });
    expect(liveReadyItems([ready409, ready405, merged405])).toEqual([
      expect.objectContaining({ type: 'pr.ready', boxId: 'b1', awaiting: true }),
    ]);
    const message = ev({ type: 'manager.message', actor: 'human', pr: pr(409) });
    expect(liveReadyItems([ready409, message])[0]?.approved).toBe(true);
    // The last sync saw it go red: not awaiting anyone any more.
    expect(liveReadyItems([ready409], () => 'open')).toEqual([]);
    // No sync since the hub started: only a PR the sync already confirmed is live.
    expect(liveReadyItems([ready409], () => undefined, false)).toEqual([]);
    expect(liveReadyItems([ready409], () => 'ready', false)).toHaveLength(1);
    const summary = buildTimelineSummary(
      [ready409],
      '2000-01-01T00:00:00.000Z',
      liveReadyItems([ready409], () => undefined, false),
      0,
    );
    expect(summary.awaiting).toBe(0);
  });

  it('sums merges and finished tasks since a time, and counts what awaits you', () => {
    const events = [
      ev({
        type: 'pr.merged',
        pr: pr(1, { additions: 100, deletions: 20 }),
        at: '2026-09-13T09:00:00.000Z',
      }),
      ev({
        type: 'pr.merged',
        pr: pr(2, { additions: 5, deletions: 1 }),
        at: '2026-09-13T12:00:00.000Z',
      }),
      ev({
        type: 'task.status',
        task: { id: 'T-1', title: 'x', to: 'done' },
        at: '2026-09-13T12:00:00.000Z',
      }),
    ];
    const live = liveReadyItems([ev({ type: 'pr.ready', pr: pr(3) })]);
    expect(buildTimelineSummary(events, '2026-09-13T10:00:00.000Z', live, 2)).toEqual({
      since: '2026-09-13T10:00:00.000Z',
      merged: 1,
      additions: 5,
      deletions: 1,
      tasksDone: 1,
      awaiting: 3,
    });
  });

  it('parses git diff --shortstat', () => {
    expect(parseShortstat(' 3 files changed, 84 insertions(+), 31 deletions(-)\n')).toEqual({
      filesChanged: 3,
      additions: 84,
      deletions: 31,
    });
    expect(parseShortstat(' 1 file changed, 1 deletion(-)')).toEqual({
      filesChanged: 1,
      additions: 0,
      deletions: 1,
    });
  });
});

// ── against the store ──

interface Harness {
  deps: BackendDeps;
  spawned: string[][];
  tmux: Set<string>;
  alive: Set<number>;
  boxes: TimelineBoxFact[];
  gh: ReturnType<typeof vi.fn>;
}

function harness(): Harness {
  const spawned: string[][] = [];
  const tmux = new Set<string>();
  const alive = new Set<number>();
  const boxes: TimelineBoxFact[] = [];
  const gh = vi.fn(async (_args: string[]) => ({ exitCode: 1, stdout: '', stderr: 'no gh' }));
  const deps: BackendDeps = {
    notify: vi.fn(),
    liveBoxIds: async () => new Set(boxes.map((b) => b.id)),
    jobs: async () => [],
    hostname: () => 'laptop',
    isPidAlive: (pid) => alive.has(pid),
    processStartTime: async () => undefined,
    managerExec: async (_file, args) => {
      spawned.push(args);
      if (args[0] === 'new-session') tmux.add(args[3]!);
      if (args[0] === 'has-session' && !tmux.has(args[2]!.slice(1))) throw new Error('no session');
      return { exitCode: 0 };
    },
    boxFacts: async () => boxes,
    boxFact: async (id) => boxes.find((b) => b.id === id),
    boxDiffStat: async () => ({ filesChanged: 3, additions: 84, deletions: 31 }),
    pendingApprovalBoxIds: () => [],
    ghExec: gh,
  };
  return { deps, spawned, tmux, alive, boxes, gh };
}

function backends(h: Harness) {
  const workspaces = createWorkspaceBackend(h.deps);
  const managers = createManagerBackend(h.deps, {
    workspaceView: (id) => workspaces.getWorkspace(id),
    sessionTurn: async () => ({ turn: 41, prompt: 'hold B until A merges' }),
    sleep: async () => {},
  });
  return { workspaces, managers };
}

async function folder(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'agentbox-hubtl-')));
  await mkdir(join(root, '.git'), { recursive: true });
  return root;
}

beforeEach(async () => {
  await rm(join(assertTempHome(), '.agentbox'), { recursive: true, force: true });
});

describe('timeline writes and reads', () => {
  it('logs a manager plan, a note and gave-more-work, and shows the box working live', async () => {
    const h = harness();
    const { workspaces, managers } = backends(h);
    const root = await folder();
    h.alive.add(4242);
    const detected = await managers.detectManager({
      agent: 'claude',
      sessionId: S1,
      cwd: root,
      pid: 4242,
      host: 'laptop',
    });
    if (!detected.ok) throw new Error(detected.error);
    const wsId = detected.workspace.id;
    const stamp = await managers.timelineStamp({ agent: 'claude', sessionId: S1 }, wsId);
    expect(stamp).toEqual({
      actor: 'manager',
      managerId: detected.manager.id,
      turn: 41,
      prompt: 'hold B until A merges',
    });
    expect(
      await managers.timelineStamp({ agent: 'claude', sessionId: S1 }, 'ffffffffffffffff'),
    ).toBeUndefined();

    for (const title of ['A', 'B', 'C']) {
      const r = await workspaces.addTask(wsId, { title }, { stamp });
      if (!r.ok) throw new Error(r.error);
    }
    h.boxes.push({
      id: 'box1',
      name: 'payment-retries',
      branches: ['agentbox/payment-retries'],
      state: 'running',
      agent: 'claude',
      projectRoot: root,
      projectId: 'p1',
    });
    const assigned = await workspaces.assignTasks(
      wsId,
      ['T-1'],
      { boxId: 'box1' },
      {
        stamp,
        note: 'A first: B depends on it',
      },
    );
    if (!assigned.ok) throw new Error(assigned.error);
    await backgroundSettled();
    const note = await managers.addManagerNote(detected.manager.id, {
      text: 'holding B until A merges',
      kind: 'replan',
    });
    if (!note.ok) throw new Error(note.error);
    expect(note.event).toMatchObject({ type: 'manager.note', turn: 41, noteKind: 'replan' });

    const timeline = createTimelineBackend(h.deps);
    const res = await timeline.getTimeline(wsId, { since: '2000-01-01T00:00:00.000Z' });
    expect(res?.github).toBe('syncing');
    const types = res!.items.map((i) => i.type);
    expect(types).toContain('plan');
    expect(types).toContain('manager.joined');
    expect(res!.items.find((i) => i.type === 'plan')).toMatchObject({
      count: 3,
      turn: 41,
      managerId: detected.manager.id,
    });
    expect(res!.items.find((i) => i.type === 'task.assigned')).toMatchObject({
      boxRunning: true,
      boxName: 'payment-retries',
      taskIds: ['T-1'],
    });
    expect(res!.items.filter((i) => i.type === 'manager.note').map((i) => i.text)).toEqual([
      'holding B until A merges',
      'A first: B depends on it',
    ]);
    expect(res!.live).toEqual([
      expect.objectContaining({
        type: 'task.in_progress',
        boxId: 'box1',
        task: { id: 'T-1', title: 'A' },
        filesChanged: 3,
      }),
    ]);
    expect(res!.summary).toMatchObject({ merged: 0, tasksDone: 0, awaiting: 0 });
  });

  it('syncs PRs from GitHub once, however often it runs', async () => {
    const h = harness();
    const { workspaces } = backends(h);
    const root = await folder();
    const added = await workspaces.addWorkspace({ path: root });
    if (!added.ok) throw new Error(added.error);
    h.boxes.push({
      id: 'box1',
      name: 'checkout-copy',
      branches: ['agentbox/checkout-copy'],
      state: 'running',
      projectRoot: root,
      projectId: 'p1',
    });
    const prs = [
      {
        number: 405,
        title: 'Retry failed charges',
        url: 'https://github.com/o/r/pull/405',
        headRefName: 'agentbox/checkout-copy',
        baseRefName: 'main',
        state: 'MERGED',
        createdAt: new Date(Date.now() - 3_600_000).toISOString(),
        mergedAt: new Date(Date.now() - 60_000).toISOString(),
        additions: 196,
        deletions: 52,
        statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }],
        mergeStateStatus: 'UNKNOWN',
        autoMergeRequest: { enabledAt: 'x' },
        mergedBy: { login: 'me' },
        author: { login: 'someone' },
      },
      {
        number: 409,
        title: 'Checkout copy',
        url: 'https://github.com/o/r/pull/409',
        headRefName: 'feature/by-me',
        baseRefName: 'main',
        state: 'OPEN',
        createdAt: new Date(Date.now() - 600_000).toISOString(),
        additions: 84,
        deletions: 31,
        statusCheckRollup: [{ state: 'SUCCESS' }],
        mergeStateStatus: 'CLEAN',
        author: { login: 'me' },
      },
      {
        number: 410,
        title: 'Someone else, unknown branch',
        url: 'https://github.com/o/r/pull/410',
        headRefName: 'other',
        baseRefName: 'main',
        state: 'OPEN',
        author: { login: 'stranger' },
      },
    ];
    h.gh.mockImplementation(async (args: string[]) => {
      if (args[0] === 'api') return { exitCode: 0, stdout: 'me\n', stderr: '' };
      if (args[0] === 'repo') {
        return {
          exitCode: 0,
          stdout: JSON.stringify({ nameWithOwner: 'o/r', url: 'https://github.com/o/r' }),
          stderr: '',
        };
      }
      return { exitCode: 0, stdout: JSON.stringify(prs), stderr: '' };
    });
    const sync = createGithubPrSync(h.deps);
    const ws = (await readWorkspace(added.workspace.id))!;
    expect(await sync.syncNow(ws)).toBe('ok');
    expect(await sync.syncNow(ws)).toBe('ok');
    const events = await readTimeline(ws.id);
    expect(events.filter((e) => e.type === 'pr.merged')).toHaveLength(1);
    expect(events.find((e) => e.type === 'pr.merged')).toMatchObject({
      actor: 'github',
      boxId: 'box1',
      boxName: 'checkout-copy',
      pr: { number: 405, additions: 196, deletions: 52, autoMerge: true, mergedBy: 'me' },
    });
    expect(events.find((e) => e.type === 'pr.ready')?.pr?.number).toBe(409);
    expect(events.some((e) => e.pr?.number === 410)).toBe(false);

    const timeline = createTimelineBackend(h.deps, { sync });
    const res = await timeline.getTimeline(ws.id);
    expect(res!.live.find((l) => l.type === 'pr.ready')).toMatchObject({
      pr: expect.objectContaining({ number: 409 }),
      awaiting: true,
    });
  });

  it('starts no GitHub sync on a sync=0 read, and reports the last status', async () => {
    const h = harness();
    const { workspaces } = backends(h);
    const added = await workspaces.addWorkspace({ path: await folder() });
    if (!added.ok) throw new Error(added.error);
    const sync = createGithubPrSync(h.deps);
    const timeline = createTimelineBackend(h.deps, { sync });
    const res = await timeline.getTimeline(added.workspace.id, { limit: 2, sync: false });
    expect(res!.github).toBe('syncing');
    await backgroundSettled();
    expect(h.gh).not.toHaveBeenCalled();

    expect(await sync.syncNow((await readWorkspace(added.workspace.id))!)).toBe('unavailable');
    h.gh.mockClear();
    const after = await timeline.getTimeline(added.workspace.id, { sync: false });
    expect(after!.github).toBe('unavailable');
    expect(h.gh).not.toHaveBeenCalled();
  });

  it('reports GitHub unavailable when gh is not logged in', async () => {
    const h = harness();
    const { workspaces } = backends(h);
    const added = await workspaces.addWorkspace({ path: await folder() });
    if (!added.ok) throw new Error(added.error);
    const sync = createGithubPrSync(h.deps);
    expect(await sync.syncNow((await readWorkspace(added.workspace.id))!)).toBe('unavailable');
  });
});

describe('sendManagerMessage', () => {
  it('types into a running hub-run manager and logs the message with its PR', async () => {
    const h = harness();
    const { workspaces, managers } = backends(h);
    const added = await workspaces.addWorkspace({ path: await folder() });
    if (!added.ok) throw new Error(added.error);
    const started = await managers.startManager(added.workspace.id, { agent: 'claude' });
    if (!started.ok) throw new Error(started.error);
    const res = await managers.sendManagerMessage(started.manager.id, {
      text: 'Approved: merge PR #409',
      prNumber: 409,
    });
    if (!res.ok) throw new Error(res.error);
    expect(res.delivered).toBe('session');
    const session = `=agentbox-manager-${started.manager.id}:`;
    expect(h.spawned).toContainEqual([
      'send-keys',
      '-t',
      session,
      '-l',
      '--',
      'Approved: merge PR #409',
    ]);
    expect(h.spawned).toContainEqual(['send-keys', '-t', session, 'Enter']);
    expect(res.event).toMatchObject({
      type: 'manager.message',
      actor: 'human',
      pr: { number: 409 },
    });
  });

  it('refuses an external manager with no pane as unreachable, and types into one with a pane', async () => {
    const h = harness();
    const { managers } = backends(h);
    const root = await folder();
    h.alive.add(7);
    const bare = await managers.detectManager({
      agent: 'claude',
      sessionId: S1,
      cwd: root,
      pid: 7,
      host: 'laptop',
    });
    if (!bare.ok) throw new Error(bare.error);
    const refused = await managers.sendManagerMessage(bare.manager.id, { text: 'hello' });
    expect(refused).toMatchObject({ ok: false, code: 'manager_unreachable' });

    const paned = await managers.detectManager({
      agent: 'claude',
      sessionId: S1,
      cwd: root,
      pid: 7,
      host: 'laptop',
      tmuxPane: '%5',
    });
    if (!paned.ok) throw new Error(paned.error);
    const sent = await managers.sendManagerMessage(paned.manager.id, { text: 'hello' });
    expect(sent).toMatchObject({ ok: true, delivered: 'pane' });
    expect(h.spawned).toContainEqual(['send-keys', '-t', '%5', '-l', '--', 'hello']);
  });

  it('resumes a stopped manager with the message as its prompt', async () => {
    const h = harness();
    const { managers } = backends(h);
    const root = await folder();
    const detected = await managers.detectManager({
      agent: 'claude',
      sessionId: S1,
      cwd: root,
      pid: 8,
      host: 'laptop',
    });
    if (!detected.ok) throw new Error(detected.error);
    const res = await managers.sendManagerMessage(detected.manager.id, { text: 'keep going' });
    expect(res).toMatchObject({ ok: true, delivered: 'resumed' });
    const start = h.spawned.find((a) => a[0] === 'new-session');
    expect(start?.at(-1)).toContain(`'--resume' '${S1}' 'keep going'`);
  });
});

describe('diffs on the live rows', () => {
  it('leaves the diff off a row whose exec is slow, and shares one exec between reads', async () => {
    const h = harness();
    const { workspaces } = backends(h);
    const root = await folder();
    const added = await workspaces.addWorkspace({ path: root });
    if (!added.ok) throw new Error(added.error);
    const wsId = added.workspace.id;
    for (const id of ['box1', 'box2']) {
      h.boxes.push({
        id,
        name: id,
        branches: [`agentbox/${id}`],
        state: 'running',
        projectRoot: root,
        projectId: 'p1',
      });
    }
    for (const [title, boxId] of [
      ['A', 'box1'],
      ['B', 'box2'],
    ] as const) {
      const t = await workspaces.addTask(wsId, { title });
      if (!t.ok) throw new Error(t.error);
      const a = await workspaces.assignTasks(wsId, [t.task.id], { boxId });
      if (!a.ok) throw new Error(a.error);
    }
    await backgroundSettled();
    let release: (v: {
      filesChanged: number;
      additions: number;
      deletions: number;
    }) => void = () => {};
    const slow = new Promise<{ filesChanged: number; additions: number; deletions: number }>(
      (resolve) => {
        release = resolve;
      },
    );
    const calls: string[] = [];
    h.deps.boxDiffStat = async (box) => {
      calls.push(box.id);
      return box.id === 'box1' ? slow : { filesChanged: 1, additions: 2, deletions: 3 };
    };
    const timeline = createTimelineBackend(h.deps, { diffTimeoutMs: 30 });
    const [first, second] = await Promise.all([
      timeline.getTimeline(wsId),
      timeline.getTimeline(wsId),
    ]);
    for (const res of [first, second]) {
      const rows = res!.live.filter((l) => l.type === 'task.in_progress');
      expect(rows.find((l) => l.boxId === 'box1')?.filesChanged).toBeUndefined();
      expect(rows.find((l) => l.boxId === 'box2')?.filesChanged).toBe(1);
    }
    expect(calls.sort()).toEqual(['box1', 'box2']);
    release({ filesChanged: 9, additions: 9, deletions: 9 });
    const later = await timeline.getTimeline(wsId);
    expect(later!.live.find((l) => l.boxId === 'box1')?.filesChanged).toBe(9);
    expect(calls).toHaveLength(2);
  });
});

describe('stamps from routes that do not name a workspace', () => {
  function fakeHub(): HubBackend {
    const okResult = async () => ({ ok: true as const });
    return {
      create: async () => ({ ok: true as const, jobId: 'job1' }),
      start: okResult,
      stop: okResult,
      destroy: okResult,
      gitPush: okResult,
      gitPushHost: okResult,
      gitCheckout: okResult,
      gitNewBranch: okResult,
    } as unknown as HubBackend;
  }

  it("never writes another workspace's manager into a log, and a create keeps its named manager", async () => {
    const h = harness();
    const { managers } = backends(h);
    const root1 = await folder();
    const root2 = await folder();
    const detect = async (sessionId: string, cwd: string) => {
      const d = await managers.detectManager({ agent: 'claude', sessionId, cwd, host: 'laptop' });
      if (!d.ok) throw new Error(d.error);
      return d;
    };
    const a = await detect(S1, root1);
    const c = await detect(S3, root1);
    const b = await detect(S2, root2);
    expect(a.workspace.id).not.toBe(b.workspace.id);
    const ws1 = a.workspace.id;

    const foreign = await stampInWorkspace(
      { session: { agent: 'claude', sessionId: S2 } },
      ws1,
      managers.timelineStamp,
    );
    expect(foreign).toEqual({ actor: 'human' });
    expect(
      await stampInWorkspace(
        { stamp: { actor: 'manager', managerId: b.manager.id } },
        ws1,
        managers.timelineStamp,
      ),
    ).toEqual({ actor: 'human' });

    h.boxes.push({
      id: 'box1',
      name: 'box-one',
      branches: ['agentbox/box-one'],
      state: 'running',
      projectRoot: root1,
      projectId: 'p1',
    });
    const hub = withBoxTimeline(fakeHub(), { deps: h.deps, stampFor: managers.timelineStamp });
    await hub.start('box1', { session: { agent: 'claude', sessionId: S2 } });
    await hub.stop('box1', { session: { agent: 'claude', sessionId: S1 } });
    const projectId = (await readWorkspace(ws1))!.projectIds[0]!;
    await hub.create(
      { projectId, managerId: c.manager.id, agent: 'claude', name: 'made' } as Parameters<
        HubBackend['create']
      >[0],
      { session: { agent: 'claude', sessionId: S1 } },
    );
    await backgroundSettled();

    const events = await readTimeline(ws1);
    const started = events.find((e) => e.type === 'box.started');
    expect(started).toMatchObject({ actor: 'human', boxName: 'box-one' });
    expect(started?.managerId).toBeUndefined();
    expect(started?.turn).toBeUndefined();
    expect(events.find((e) => e.type === 'box.stopped')).toMatchObject({
      actor: 'manager',
      managerId: a.manager.id,
      turn: 41,
    });
    expect(events.find((e) => e.type === 'box.created')).toMatchObject({
      actor: 'manager',
      managerId: c.manager.id,
    });
    expect((await readTimeline(b.workspace.id)).some((e) => e.type.startsWith('box.'))).toBe(false);
  });
});

describe('narrowed to one manager session', () => {
  /** Two sessions in one workspace, each with a box: A on `box1`, B on `box2`. */
  async function twoSessions() {
    const h = harness();
    const { workspaces, managers } = backends(h);
    const root = await folder();
    h.alive.add(4242);
    h.alive.add(4343);
    const a = await managers.detectManager({
      agent: 'claude',
      sessionId: S1,
      cwd: root,
      pid: 4242,
      host: 'laptop',
    });
    if (!a.ok) throw new Error(a.error);
    const b = await managers.detectManager({
      agent: 'codex',
      sessionId: S2,
      cwd: root,
      pid: 4343,
      host: 'laptop',
    });
    if (!b.ok) throw new Error(b.error);
    const wsId = a.workspace.id;
    for (const [id, name] of [
      ['box1', 'payment-retries'],
      ['box2', 'refund-flow'],
    ] as const) {
      h.boxes.push({
        id,
        name,
        branches: [`agentbox/${name}`],
        state: 'running',
        agent: 'claude',
        projectRoot: root,
        projectId: 'p1',
      });
    }
    await attachBoxToManager(wsId, a.manager.id, { boxId: 'box1' });
    await attachBoxToManager(wsId, b.manager.id, { boxId: 'box2' });
    return { h, workspaces, managers, wsId, a: a.manager.id, b: b.manager.id };
  }

  it("keeps the session's own rows and its boxes', drops the other's, and narrows the summary", async () => {
    const { h, wsId, a, b } = await twoSessions();
    // Never stamped with a manager: the kind of row `managerIdForTarget` could not resolve, and
    // the reason the filter has to fall back to the box.
    await recordTimelineEvent(wsId, {
      type: 'git.push',
      actor: 'box',
      boxId: 'box1',
      branch: 'agentbox/payment-retries',
      additions: 12,
      deletions: 3,
    });
    await recordTimelineEvent(wsId, {
      type: 'manager.note',
      actor: 'manager',
      managerId: b,
      text: "B's own note",
    });
    await recordTimelineEvent(wsId, {
      type: 'pr.merged',
      actor: 'github',
      boxId: 'box1',
      pr: pr(1, { additions: 10, deletions: 2 }),
    });
    await recordTimelineEvent(wsId, {
      type: 'pr.merged',
      actor: 'github',
      boxId: 'box2',
      pr: pr(2, { additions: 500, deletions: 400 }),
    });

    const timeline = createTimelineBackend(h.deps);
    const since = '2000-01-01T00:00:00.000Z';
    const mine = await timeline.getTimeline(wsId, { managerId: a, since, sync: false });

    expect(mine!.items.map((i) => i.type)).toContain('git.push');
    expect(mine!.items.some((i) => i.boxId === 'box2')).toBe(false);
    expect(mine!.items.some((i) => i.text === "B's own note")).toBe(false);
    // The other session's 500/400 merge is not this session's work.
    expect(mine!.summary).toMatchObject({ merged: 1, additions: 10, deletions: 2 });

    const theirs = await timeline.getTimeline(wsId, { managerId: b, since, sync: false });
    expect(theirs!.items.some((i) => i.text === "B's own note")).toBe(true);
    expect(theirs!.items.some((i) => i.boxId === 'box1')).toBe(false);
    expect(theirs!.summary).toMatchObject({ merged: 1, additions: 500, deletions: 400 });
  });

  it('narrows the live rows to the session whose box is working', async () => {
    const { h, workspaces, wsId, a, b } = await twoSessions();
    const added = await workspaces.addTask(wsId, { title: "B's task" });
    if (!added.ok) throw new Error(added.error);
    const assigned = await workspaces.assignTasks(wsId, [added.task.id], { boxId: 'box2' });
    if (!assigned.ok) throw new Error(assigned.error);

    const timeline = createTimelineBackend(h.deps);
    const theirs = await timeline.getTimeline(wsId, { managerId: b, sync: false });
    expect(theirs!.live).toEqual([
      expect.objectContaining({ type: 'task.in_progress', boxId: 'box2' }),
    ]);
    const mine = await timeline.getTimeline(wsId, { managerId: a, sync: false });
    expect(mine!.live).toEqual([]);
  });

  it('assigns lanes over the whole log, so a narrowed read keeps the unfiltered lane ids', async () => {
    const { h, wsId, a } = await twoSessions();
    for (const boxId of ['box1', 'box2', 'box1']) {
      await recordTimelineEvent(wsId, {
        type: 'git.push',
        actor: 'box',
        boxId,
        branch: `agentbox/${boxId}`,
      });
    }
    const timeline = createTimelineBackend(h.deps);
    const full = await timeline.getTimeline(wsId, { sync: false });
    const mine = await timeline.getTimeline(wsId, { managerId: a, sync: false });

    const lanesById = new Map(full!.items.map((i) => [i.id, i.lane]));
    expect(mine!.items.length).toBeGreaterThan(0);
    for (const item of mine!.items) expect(item.lane).toEqual(lanesById.get(item.id));
  });

  it('counts a box that is still building by its job, and reads an unknown session as empty', async () => {
    const { h, wsId, a } = await twoSessions();
    await attachBoxToManager(wsId, a, { boxJobId: 'J1' });
    // Written at queue time: the box has no id yet, so only the job key ties it to the manager.
    await recordTimelineEvent(wsId, {
      type: 'box.created',
      actor: 'hub',
      key: 'job:J1:created',
      boxName: 'not-up-yet',
    });

    const timeline = createTimelineBackend(h.deps);
    const mine = await timeline.getTimeline(wsId, { managerId: a, sync: false });
    expect(mine!.items.some((i) => i.boxName === 'not-up-yet')).toBe(true);

    const nobody = await timeline.getTimeline(wsId, { managerId: 'ffffffffffffffff', sync: false });
    expect(nobody).not.toBeNull();
    expect(nobody!.items).toEqual([]);
    expect(nobody!.live).toEqual([]);
  });

  it("keeps a destroyed box's history, which the manager record no longer lists", async () => {
    const { h, wsId, a } = await twoSessions();
    // Attached, then gone: it is not among the live boxes, so `readReconciledManagers` prunes it
    // out of `boxIds` (and writes that back). Only the log still ties this box to the session.
    await attachBoxToManager(wsId, a, { boxId: 'gone1' });
    await recordTimelineEvent(wsId, {
      type: 'box.created',
      actor: 'manager',
      managerId: a,
      boxId: 'gone1',
      boxName: 'retired',
    });
    // The row that matters: never stamped, so it hangs entirely off owning the box.
    await recordTimelineEvent(wsId, {
      type: 'git.push',
      actor: 'box',
      boxId: 'gone1',
      branch: 'agentbox/retired',
      additions: 7,
      deletions: 1,
    });

    const timeline = createTimelineBackend(h.deps);
    const mine = await timeline.getTimeline(wsId, { managerId: a, sync: false });
    expect(mine!.items.filter((i) => i.type === 'git.push' && i.boxId === 'gone1')).toHaveLength(1);
  });

  it('joins a create job to its box, the way the real rows are written', async () => {
    const { h, wsId, a } = await twoSessions();
    // The real shape, and the one a hand-written test gets wrong: the queued row carries the
    // session and the job key but NO box id, and the row that finally carries the id is written
    // by the worker without a manager. Neither row alone attributes the box.
    await recordTimelineEvent(wsId, {
      type: 'box.created',
      actor: 'manager',
      managerId: a,
      key: 'job:J7:created',
      boxName: 'late-riser',
    });
    await recordTimelineEvent(wsId, {
      type: 'box.ready',
      actor: 'hub',
      key: 'job:J7:ready',
      boxId: 'gone7',
      boxName: 'late-riser',
    });
    // Destroyed since, so the manager record lists neither the job nor the box.
    await recordTimelineEvent(wsId, {
      type: 'git.push',
      actor: 'box',
      boxId: 'gone7',
      branch: 'agentbox/late-riser',
    });

    const timeline = createTimelineBackend(h.deps);
    const mine = await timeline.getTimeline(wsId, { managerId: a, sync: false });
    expect(mine!.items.filter((i) => i.type === 'git.push' && i.boxId === 'gone7')).toHaveLength(1);
    expect(mine!.items.some((i) => i.boxId === 'gone7' && i.type === 'box.ready')).toBe(true);
  });

  it("does not claim another session's box from a row it merely touched", async () => {
    const { h, wsId, a, b } = await twoSessions();
    // A assigns work onto B's box: stamped by A, naming box2. That must not hand A the box.
    await recordTimelineEvent(wsId, {
      type: 'task.assigned',
      actor: 'manager',
      managerId: a,
      boxId: 'box2',
      taskIds: ['T-9'],
    });
    await recordTimelineEvent(wsId, {
      type: 'git.push',
      actor: 'box',
      boxId: 'box2',
      branch: 'agentbox/refund-flow',
    });

    const timeline = createTimelineBackend(h.deps);
    const mine = await timeline.getTimeline(wsId, { managerId: a, sync: false });
    expect(mine!.items.some((i) => i.type === 'git.push')).toBe(false);
    const theirs = await timeline.getTimeline(wsId, { managerId: b, sync: false });
    expect(theirs!.items.some((i) => i.type === 'git.push')).toBe(true);
  });
});

describe('push rows', () => {
  it('records the lines a push moved, and a push-host from the merge base', async () => {
    const h = harness();
    const { managers } = backends(h);
    const root = await realpath(await mkdtemp(join(tmpdir(), 'agentbox-hubpush-')));
    const git = (...args: string[]): string =>
      execFileSync(
        'git',
        [
          '-c',
          'user.name=t',
          '-c',
          'user.email=t@t',
          '-c',
          'commit.gpgsign=false',
          '-C',
          root,
          ...args,
        ],
        { encoding: 'utf8' },
      ).trim();
    const commit = async (file: string, lines: number): Promise<string> => {
      await writeFile(join(root, file), 'x\n'.repeat(lines));
      git('add', file);
      git('commit', '-q', '-m', file);
      return git('rev-parse', 'HEAD');
    };
    git('init', '-q', '-b', 'main');
    await commit('base.txt', 2);
    git('checkout', '-q', '-b', 'agentbox/box-one');
    git('update-ref', 'refs/remotes/origin/agentbox/box-one', await commit('a.txt', 5));
    const next = await commit('b.txt', 3);
    const d = await managers.detectManager({
      agent: 'claude',
      sessionId: S1,
      cwd: root,
      host: 'laptop',
    });
    if (!d.ok) throw new Error(d.error);
    h.boxes.push({
      id: 'box1',
      name: 'box-one',
      branches: ['agentbox/box-one'],
      state: 'running',
      projectRoot: root,
      projectId: 'p1',
    });
    const okResult = async () => ({ ok: true as const });
    const hub = withBoxTimeline(
      {
        create: okResult,
        start: okResult,
        stop: okResult,
        destroy: okResult,
        gitPush: async () => {
          git('update-ref', 'refs/remotes/origin/agentbox/box-one', next);
          return { ok: true as const };
        },
        gitPushHost: async () => {
          git('branch', 'landed', next);
          return { ok: true as const };
        },
        gitCheckout: okResult,
        gitNewBranch: okResult,
      } as unknown as HubBackend,
      { deps: h.deps, stampFor: managers.timelineStamp },
    );
    await hub.gitPush('box1', {});
    await hub.gitPushHost('box1', { as: 'landed' });
    await backgroundSettled();

    const pushes = (await readTimeline(d.workspace.id)).filter((e) => e.type === 'git.push');
    // The push moved origin's ref by b.txt; the landing had no old tip, so it is measured from main.
    expect(pushes.map((e) => [e.additions, e.deletions]).sort()).toEqual([
      [3, 0],
      [8, 0],
    ]);
  });
});

describe('a push on a box hydrated during the push', () => {
  it('still records the push row, without a diff', async () => {
    const h = harness();
    const { managers } = backends(h);
    const root = await folder();
    const d = await managers.detectManager({
      agent: 'claude',
      sessionId: S1,
      cwd: root,
      host: 'laptop',
    });
    if (!d.ok) throw new Error(d.error);
    const okResult = async () => ({ ok: true as const });
    const hub = withBoxTimeline(
      {
        create: okResult,
        start: okResult,
        stop: okResult,
        destroy: okResult,
        // The box is only known once the op registered it from the Store.
        gitPush: async () => {
          h.boxes.push({
            id: 'box1',
            name: 'box-one',
            branches: ['agentbox/box-one'],
            state: 'running',
            projectRoot: root,
            projectId: 'p1',
          });
          return { ok: true as const };
        },
        gitPushHost: okResult,
        gitCheckout: okResult,
        gitNewBranch: okResult,
      } as unknown as HubBackend,
      { deps: h.deps, stampFor: managers.timelineStamp },
    );
    await hub.gitPush('box1', {});
    await backgroundSettled();

    const pushes = (await readTimeline(d.workspace.id)).filter((e) => e.type === 'git.push');
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toMatchObject({ boxId: 'box1', boxName: 'box-one' });
    expect(pushes[0]!.additions).toBeUndefined();
  });
});

describe('a message about a PR in a workspace over several repos', () => {
  it('ties the message to the repo it names, and to none when the number alone is ambiguous', async () => {
    const h = harness();
    const { workspaces, managers } = backends(h);
    const added = await workspaces.addWorkspace({ path: await folder() });
    if (!added.ok) throw new Error(added.error);
    const wsId = added.workspace.id;
    const { recordTimelineEvent } = await import('@agentbox/relay');
    await recordTimelineEvent(wsId, { type: 'pr.ready', actor: 'github', pr: pr(12) });
    await recordTimelineEvent(wsId, {
      type: 'pr.ready',
      actor: 'github',
      pr: pr(12, { repo: 'o/web', url: 'https://github.com/o/web/pull/12' }),
    });
    const started = await managers.startManager(wsId, { agent: 'claude' });
    if (!started.ok) throw new Error(started.error);
    const named = await managers.sendManagerMessage(started.manager.id, {
      text: 'merge it',
      prNumber: 12,
      repo: 'o/web',
    });
    if (!named.ok) throw new Error(named.error);
    expect(named.event?.pr).toMatchObject({ repo: 'o/web', number: 12, title: 'PR 12' });
    const bare = await managers.sendManagerMessage(started.manager.id, {
      text: 'merge 12',
      prNumber: 12,
    });
    if (!bare.ok) throw new Error(bare.error);
    expect(bare.event?.pr).toMatchObject({ repo: '', number: 12 });
    const live = liveReadyItems(await readTimeline(wsId));
    expect(live.find((l) => l.pr?.repo === 'o/web')?.approved).toBe(true);
    expect(live.find((l) => l.pr?.repo === 'o/r')?.approved).toBeUndefined();
  });
});

describe('branch links', () => {
  const none: RepoWebLookup = {
    repo: () => undefined,
    project: () => undefined,
    box: () => undefined,
  };
  const lookup: RepoWebLookup = {
    repo: (r) =>
      r === 'acme/storefront-web' ? 'https://github.com/acme/storefront-web' : undefined,
    project: (id) => (id === 'p1' ? 'https://ghe.acme.dev/acme/api' : undefined),
    box: (id) => (id === 'box1' ? 'https://github.com/acme/box-repo' : undefined),
  };

  it("takes a PR row's repo from its URL, on whatever host it names", () => {
    expect(repoUrlOfPrUrl('https://ghe.acme.dev/acme/api/pull/12')).toBe(
      'https://ghe.acme.dev/acme/api',
    );
    expect(repoUrlOfPrUrl('https://github.com/acme/api/issues/12')).toBeUndefined();
    const row = {
      pr: pr(409, {
        repo: 'acme/storefront-web',
        url: 'https://github.com/acme/storefront-web/pull/409',
        head: 'feat/checkout-copy',
      }),
      projectId: 'p1',
      boxId: 'box1',
    };
    expect(branchUrlOf(row, none)).toBe(
      'https://github.com/acme/storefront-web/tree/feat/checkout-copy',
    );
  });

  it('falls back to a repo the sync resolved, then the project, then the box', () => {
    const noUrl = pr(1, { repo: 'acme/storefront-web', url: '', head: 'feat/a' });
    expect(branchUrlOf({ pr: noUrl, projectId: 'p1' }, lookup)).toBe(
      'https://github.com/acme/storefront-web/tree/feat/a',
    );
    expect(branchUrlOf({ pr: { ...noUrl, repo: 'other/repo' }, projectId: 'p1' }, lookup)).toBe(
      'https://ghe.acme.dev/acme/api/tree/feat/a',
    );
    expect(branchUrlOf({ branch: 'agentbox/x', projectId: 'p1', boxId: 'box1' }, lookup)).toBe(
      'https://ghe.acme.dev/acme/api/tree/agentbox/x',
    );
    expect(branchUrlOf({ branch: 'agentbox/x', projectId: 'gone', boxId: 'box1' }, lookup)).toBe(
      'https://github.com/acme/box-repo/tree/agentbox/x',
    );
  });

  it('encodes each branch segment and keeps the slashes', () => {
    expect(branchUrlOf({ branch: 'feat/100% done#2/ü', boxId: 'box1' }, lookup)).toBe(
      'https://github.com/acme/box-repo/tree/feat/100%25%20done%232/%C3%BC',
    );
  });

  it('is absent with no branch, or no known repo', () => {
    expect(branchUrlOf({ projectId: 'p1', boxId: 'box1' }, lookup)).toBeUndefined();
    expect(
      branchUrlOf({ branch: 'feat/a', projectId: 'gone', boxId: 'gone' }, lookup),
    ).toBeUndefined();
    const message = { pr: { repo: '', number: 4, title: '', url: '', base: '', head: '' } };
    expect(branchUrlOf(message, lookup)).toBeUndefined();
    expect(
      branchUrlOf({ branch: 'feat/a', pr: pr(2, { url: '', repo: 'x/y' }) }, none),
    ).toBeUndefined();
  });

  it('adds branchUrl to items and live rows from the cache, and never stores it', async () => {
    const h = harness();
    const { workspaces } = backends(h);
    const root = await folder();
    const added = await workspaces.addWorkspace({ path: root });
    if (!added.ok) throw new Error(added.error);
    const wsId = added.workspace.id;
    h.boxes.push({
      id: 'box1',
      name: 'checkout-copy',
      branches: ['agentbox/checkout-copy'],
      state: 'running',
      projectRoot: root,
      projectId: hashProjectPath(root),
    });
    await recordTimelineEvent(wsId, {
      type: 'box.created',
      actor: 'human',
      boxName: 'fresh',
      branch: 'agentbox/fresh',
      projectId: hashProjectPath(root),
    });
    const task = await workspaces.addTask(wsId, { title: 'Copy' });
    if (!task.ok) throw new Error(task.error);
    const assigned = await workspaces.assignTasks(wsId, [task.task.id], { boxId: 'box1' });
    if (!assigned.ok) throw new Error(assigned.error);
    await backgroundSettled();

    const cold = createTimelineBackend(h.deps, { sync: createGithubPrSync(h.deps) });
    const before = await cold.getTimeline(wsId);
    expect(before!.items.some((i) => i.branchUrl)).toBe(false);
    expect(before!.live.some((l) => l.branchUrl)).toBe(false);

    h.gh.mockImplementation(async (args: string[]) => {
      if (args[0] === 'api') return { exitCode: 0, stdout: 'me\n', stderr: '' };
      if (args[0] === 'repo') {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            nameWithOwner: 'acme/api',
            url: 'https://ghe.acme.dev/acme/api',
          }),
          stderr: '',
        };
      }
      return {
        exitCode: 0,
        stdout: JSON.stringify([
          {
            number: 7,
            title: 'Copy',
            url: 'https://ghe.acme.dev/acme/api/pull/7',
            headRefName: 'agentbox/checkout-copy',
            baseRefName: 'main',
            state: 'OPEN',
            author: { login: 'someone' },
          },
        ]),
        stderr: '',
      };
    });
    const sync = createGithubPrSync(h.deps);
    const ws = (await readWorkspace(wsId))!;
    expect(await sync.syncNow(ws)).toBe('ok');
    expect(sync.webUrlForRepo('acme/api')).toBe('https://ghe.acme.dev/acme/api');
    h.gh.mockClear();

    const res = await createTimelineBackend(h.deps, { sync }).getTimeline(wsId);
    expect(res!.items.find((i) => i.type === 'pr.opened')?.branchUrl).toBe(
      'https://ghe.acme.dev/acme/api/tree/agentbox/checkout-copy',
    );
    expect(res!.items.find((i) => i.type === 'box.created')?.branchUrl).toBe(
      'https://ghe.acme.dev/acme/api/tree/agentbox/fresh',
    );
    expect(res!.live.find((l) => l.type === 'task.in_progress')?.branchUrl).toBe(
      'https://ghe.acme.dev/acme/api/tree/agentbox/checkout-copy',
    );
    expect(h.gh.mock.calls.some(([args]) => args[0] === 'repo')).toBe(false);
    const raw = await readFile(timelineFile((await resolveWorkspaceDir(wsId))!), 'utf8');
    expect(raw).not.toContain('branchUrl');
  });
});

describe('branch graph', () => {
  function branchHub(ok = true): HubBackend {
    const result = async () => (ok ? { ok: true as const } : { ok: false as const, error: 'no' });
    let jobs = 0;
    return {
      // Distinct jobs: one job's create key would dedupe the second create away.
      create: async () => ({ ok: true as const, jobId: `job${String((jobs += 1))}` }),
      start: result,
      stop: result,
      destroy: result,
      gitPush: result,
      gitPushHost: result,
      gitCheckout: result,
      gitNewBranch: result,
    } as unknown as HubBackend;
  }

  it("records a create's base: its fromBranch, else the project's current branch", async () => {
    const h = harness();
    const { workspaces, managers } = backends(h);
    const added = await workspaces.addWorkspace({ path: await folder() });
    if (!added.ok) throw new Error(added.error);
    const projectId = added.workspace.projectIds[0]!;
    const asked: string[] = [];
    h.deps.projectBranch = async (id) => {
      asked.push(id);
      return 'develop';
    };
    const hub = withBoxTimeline(branchHub(), { deps: h.deps, stampFor: managers.timelineStamp });
    type CreateInput = Parameters<HubBackend['create']>[0];
    await hub.create({ projectId, agent: 'claude', name: 'plain' } as CreateInput);
    await backgroundSettled();
    await hub.create({
      projectId,
      agent: 'claude',
      name: 'stacked',
      fromBranch: 'agentbox/plain',
    } as CreateInput);
    await backgroundSettled();

    const creates = (await readTimeline(added.workspace.id)).filter(
      (e) => e.type === 'box.created',
    );
    expect(creates.find((e) => e.boxName === 'plain')?.base).toBe('develop');
    expect(creates.find((e) => e.boxName === 'stacked')?.base).toBe('agentbox/plain');
    expect(asked).toEqual([projectId]);
  });

  it('writes box.branch for a switch the hub sanctioned, and nothing for paths, a detached HEAD or a failure', async () => {
    const h = harness();
    const { workspaces, managers } = backends(h);
    const root = await folder();
    const added = await workspaces.addWorkspace({ path: root });
    if (!added.ok) throw new Error(added.error);
    const box: TimelineBoxFact = {
      id: 'box1',
      name: 'box-one',
      branches: ['agentbox/box-one'],
      state: 'running',
      projectRoot: root,
      projectId: 'p1',
    };
    h.boxes.push(box);
    const seams = { deps: h.deps, stampFor: managers.timelineStamp };
    // What the real routes persist: the branch HEAD names after the op, none when detached.
    const sanction = (branch: string) => {
      box.branches = [branch, 'agentbox/box-one'];
    };
    const calls: string[][] = [];
    const hub = withBoxTimeline(
      {
        ...branchHub(),
        gitCheckout: async (_id: string, branch: string, args?: string[]) => {
          calls.push([branch, ...(args ?? [])]);
          if (!args?.length && !/^[0-9a-f]{7,40}$/u.test(branch)) sanction(branch);
          return { ok: true as const };
        },
        gitNewBranch: async (_id: string, input: { name: string }) => {
          sanction(scratchBranchName(input.name));
          return { ok: true as const };
        },
      } as unknown as HubBackend,
      seams,
    );
    await withBoxTimeline(branchHub(false), seams).gitCheckout('box1', 'feat/nope');
    await hub.gitCheckout('box1', 'main', ['--', 'src/x.ts']);
    await hub.gitCheckout('box1', 'abc1234');
    await backgroundSettled();
    await hub.gitCheckout('box1', 'feat/x');
    await backgroundSettled();
    await hub.gitNewBranch('box1', { name: 'retry' });
    await backgroundSettled();

    expect(calls).toEqual([['main', '--', 'src/x.ts'], ['abc1234'], ['feat/x']]);
    const rows = (await readTimeline(added.workspace.id)).filter((e) => e.type === 'box.branch');
    expect(rows).toHaveLength(2);
    expect(rows.find((e) => e.branch === 'feat/x')).toMatchObject({
      actor: 'human',
      boxId: 'box1',
      boxName: 'box-one',
      base: 'agentbox/box-one',
    });
    expect(rows.find((e) => e.branch === scratchBranchName('retry'))).toMatchObject({
      boxId: 'box1',
      base: 'feat/x',
    });
  });

  it('returns lanes on every row, the same on a short page, and never stores them', async () => {
    const h = harness();
    const { workspaces } = backends(h);
    const root = await folder();
    const added = await workspaces.addWorkspace({ path: root });
    if (!added.ok) throw new Error(added.error);
    const wsId = added.workspace.id;
    h.boxes.push({
      id: 'box1',
      name: 'box-one',
      branches: ['agentbox/box-one'],
      state: 'running',
      projectRoot: root,
      projectId: 'p1',
    });
    const at = (s: number) => new Date(Date.UTC(2026, 8, 13, 10, 0, s)).toISOString();
    await recordTimelineEvent(wsId, {
      type: 'box.created',
      actor: 'human',
      at: at(1),
      key: 'job:j1:created',
      boxName: 'box-one',
      branch: 'agentbox/box-one',
      base: 'main',
    });
    await recordTimelineEvent(wsId, {
      type: 'box.ready',
      actor: 'hub',
      at: at(2),
      key: 'job:j1:ready',
      boxId: 'box1',
      branch: 'agentbox/box-one',
    });
    await recordTimelineEvent(wsId, {
      type: 'manager.note',
      actor: 'human',
      at: at(3),
      text: 'pushing next',
    });
    await recordTimelineEvent(wsId, {
      type: 'git.push',
      actor: 'box',
      at: at(4),
      boxId: 'box1',
      branch: 'agentbox/box-one',
    });

    const timeline = createTimelineBackend(h.deps, { sync: createGithubPrSync(h.deps) });
    const res = await timeline.getTimeline(wsId, { sync: false });
    expect(res!.items.map((i) => [i.type, i.lane])).toEqual([
      ['git.push', { id: 'box:box1', kind: 'box', open: true }],
      ['manager.note', { id: 'trunk', kind: 'trunk' }],
      ['box.ready', { id: 'box:box1', kind: 'box' }],
      ['box.created', { id: 'box:box1', kind: 'box', from: 'trunk', branch: 'agentbox/box-one' }],
    ]);
    const page = await timeline.getTimeline(wsId, { sync: false, limit: 1 });
    expect(page!.items[0]!.lane).toEqual({ id: 'box:box1', kind: 'box', open: true });
    const raw = await readFile(timelineFile((await resolveWorkspaceDir(wsId))!), 'utf8');
    expect(raw).not.toContain('lane');
  });
});
