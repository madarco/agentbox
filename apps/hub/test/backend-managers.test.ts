import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { workspaceAdd } from './_workspace-input';
import { assertTempHome } from '../../../scripts/test-home.js';
import { createManagerBackend, HEARTBEAT_STALE_MS } from '../lib/backend/managers';
import { createWorkspaceBackend } from '../lib/backend/workspaces';
import type { BackendDeps } from '../lib/backend/deps';
import {
  configureTimelineSink,
  MANAGER_SEEN_WINDOW_MS,
  resolveWorkspaceDir,
  type ManagerRecord,
  type ManagerRecordStore,
  type ManagerView,
  type QueueJob,
  type TimelineEventInput,
} from '@agentbox/relay';

const S1 = '5edc0ee0-ce9a-4e30-962d-bc630388d8bc';
const S2 = '01a09ad5-8f51-7ec0-b8f4-2daa8be67500';

interface Harness {
  deps: BackendDeps & { notify: ReturnType<typeof vi.fn> };
  spawned: string[][];
  alive: Set<number>;
  started: Map<number, string>;
  tmux: Set<string>;
}

// Every process seam is faked: a regression in a guard must never start a real
// agent or tmux session on the machine running the suite.
function harness(over: { boxIds?: string[]; jobs?: Partial<QueueJob>[] } = {}): Harness {
  const spawned: string[][] = [];
  const alive = new Set<number>();
  const started = new Map<number, string>();
  const tmux = new Set<string>();
  const deps = {
    notify: vi.fn(),
    liveBoxIds: async () => new Set(over.boxIds ?? []),
    jobs: async () => (over.jobs ?? []) as QueueJob[],
    hostname: () => 'laptop',
    isPidAlive: (pid: number) => alive.has(pid),
    processStartTime: async (pid: number) => started.get(pid),
    managerExec: async (file: string, args: string[]) => {
      // Read-only probes (`claude agents`, `ps`, `tmux list-sessions`) answer nothing
      // here and are not what these tests assert.
      if (file !== 'tmux' || args[0] === 'list-sessions') return { exitCode: 0 };
      spawned.push(args);
      if (args[0] === 'new-session') tmux.add(args[3]!);
      if (args[0] === 'kill-session') tmux.delete(args[2]!.slice(1));
      if (args[0] === 'has-session' && !tmux.has(args[2]!.slice(1))) throw new Error('no session');
      return { exitCode: 0 };
    },
  };
  return { deps, spawned, alive, started, tmux };
}

function backends(h: Harness) {
  const workspaces = createWorkspaceBackend(h.deps);
  const managers = createManagerBackend(h.deps, {
    workspaceView: (id) => workspaces.getWorkspace(id),
  });
  return { workspaces, managers };
}

async function makeFolder(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'agentbox-hubmgr-')));
  await mkdir(join(root, '.git'), { recursive: true });
  return root;
}

beforeEach(async () => {
  await rm(join(assertTempHome(), '.agentbox'), { recursive: true, force: true });
});

afterEach(() => {
  configureTimelineSink(null);
});

/** Counts what a hub forwards, so a row written twice is visible. */
function stubSink(): {
  sink: Parameters<typeof configureTimelineSink>[0];
  rows: TimelineEventInput[];
} {
  const rows: TimelineEventInput[] = [];
  return {
    rows,
    sink: {
      kind: 'remote',
      record: async (_wsId: string, input: TimelineEventInput) => {
        rows.push(input);
        return null;
      },
      workspaceFor: async () => null,
    },
  };
}

describe('detectManager', () => {
  it('creates a workspace at the cwd when none contains it, then refreshes the same record', async () => {
    const h = harness();
    const { workspaces, managers } = backends(h);
    const root = await makeFolder();
    h.alive.add(4242);
    const first = await managers.detectManager({
      agent: 'claude',
      sessionId: S1,
      cwd: root,
      pid: 4242,
      host: 'laptop',
    });
    if (!first.ok) throw new Error(first.error);
    expect(first.created).toBe(true);
    expect(first.workspace).toMatchObject({ root, managers: { running: 1, total: 1 } });
    expect(first.manager).toMatchObject({ kind: 'external', status: 'running', pid: 4242 });
    expect(h.deps.notify).toHaveBeenCalled();

    const again = await managers.detectManager({ agent: 'claude', sessionId: S1, cwd: root });
    if (!again.ok) throw new Error(again.error);
    expect(again.created).toBe(false);
    expect(again.manager.id).toBe(first.manager.id);
    expect(await workspaces.listWorkspaces()).toHaveLength(1);
    expect(h.spawned).toEqual([]);
  });

  it('reuses the workspace containing the cwd, and attaches a box in the same call', async () => {
    const h = harness({ boxIds: ['b1'] });
    const { workspaces, managers } = backends(h);
    const root = await makeFolder();
    await mkdir(join(root, 'sub'));
    const added = await workspaces.addWorkspace(await workspaceAdd(root, { host: 'laptop' }));
    if (!added.ok) throw new Error(added.error);
    const res = await managers.detectManager({
      agent: 'codex',
      sessionId: S2,
      cwd: join(root, 'sub'),
      boxId: 'b1',
    });
    if (!res.ok) throw new Error(res.error);
    expect(res.created).toBe(true);
    expect(res.workspace.id).toBe(added.workspace.id);
    expect(res.manager.boxIds).toEqual(['b1']);
    expect((await managers.managerByBox()).get('b1')).toBe(res.manager.id);
  });
});

describe('detectManager refusals', () => {
  it('never creates a workspace at /, the home folder or above it', async () => {
    const { workspaces, managers } = backends(harness());
    const home = await realpath(homedir());
    for (const cwd of ['/', home, dirname(home)]) {
      const res = await managers.detectManager({ agent: 'claude', sessionId: S1, cwd });
      expect(res).toMatchObject({
        ok: false,
        invalid: true,
        error: expect.stringContaining('agentbox workspace add <project folder>'),
      });
    }
    expect(await workspaces.listWorkspaces()).toEqual([]);
  });

  it('registers a folder this hub cannot see: it is on the caller machine', async () => {
    const { workspaces, managers } = backends(harness());
    const cwd = '/home/dev/work';
    const res = await managers.detectManager({
      agent: 'claude',
      sessionId: S1,
      cwd,
      host: 'pc',
      home: '/home/dev',
      projects: [{ path: '/home/dev/work/app', repoUrl: 'git@github.com:acme/app.git' }],
    });
    expect(res).toMatchObject({ ok: true, created: true });
    const [ws] = await workspaces.listWorkspaces();
    expect(ws?.hosts['pc']?.root).toBe(cwd);
    expect(ws?.projects).toHaveLength(1);
    // The folder is not this hub's, so it claims none of it.
    expect(ws?.root).toBeUndefined();
  });

  it("applies the folder rules to the CALLER's home, not this hub's", async () => {
    const { workspaces, managers } = backends(harness());
    const res = await managers.detectManager({
      agent: 'claude',
      sessionId: S1,
      cwd: '/home/dev',
      host: 'pc',
      home: '/home/dev',
    });
    expect(res).toMatchObject({
      ok: false,
      invalid: true,
      error: expect.stringContaining('is your home folder'),
    });
    expect(await workspaces.listWorkspaces()).toEqual([]);
    expect(await managers.listManagers()).toEqual([]);
  });

  it('refuses a task a manager of another workspace would own, on add and on update', async () => {
    const { workspaces, managers } = backends(harness());
    const a = await managers.detectManager({
      agent: 'claude',
      sessionId: S1,
      cwd: await makeFolder(),
    });
    const b = await managers.detectManager({
      agent: 'codex',
      sessionId: S2,
      cwd: await makeFolder(),
    });
    if (!a.ok || !b.ok) throw new Error('detect failed');
    expect(
      await workspaces.addTask(a.workspace.id, { title: 't', managerId: b.manager.id }),
    ).toMatchObject({
      ok: false,
      invalid: true,
      error: expect.stringContaining('belongs to workspace'),
    });
    expect(
      await workspaces.addTask(a.workspace.id, { title: 't', managerId: 'ffffffffffffffff' }),
    ).toMatchObject({ ok: false, invalid: true });
    const own = await workspaces.addTask(a.workspace.id, { title: 't', managerId: a.manager.id });
    if (!own.ok) throw new Error(own.error);
    expect(own.task.managerId).toBe(a.manager.id);
    expect(
      await workspaces.updateTask(a.workspace.id, own.task.id, { managerId: b.manager.id }),
    ).toMatchObject({ ok: false, invalid: true });
    expect(
      await workspaces.updateTask(a.workspace.id, own.task.id, { managerId: null }),
    ).toMatchObject({ ok: true });
  });
});

describe('liveness and lifecycle', () => {
  async function external(h: Harness) {
    const { managers, workspaces } = backends(h);
    const root = await makeFolder();
    h.alive.add(99);
    const res = await managers.detectManager({
      agent: 'claude',
      sessionId: S1,
      cwd: root,
      pid: 99,
      host: 'laptop',
    });
    if (!res.ok) throw new Error(res.error);
    return { managers, workspaces, manager: res.manager, root };
  }

  it('records the pid start time and reads a reused pid as stopped', async () => {
    const h = harness();
    h.started.set(99, 'Sun Sep 13 10:00:00 2026');
    const { managers, manager } = await external(h);
    expect(manager).toMatchObject({ pidStartedAt: 'Sun Sep 13 10:00:00 2026', status: 'running' });
    // The session exited and the system handed pid 99 to something else.
    h.started.set(99, 'Sun Sep 13 12:00:00 2026');
    expect((await managers.getManager(manager.id))?.status).toBe('stopped');
  });

  it('never stamps a pid reported from another host', async () => {
    const h = harness();
    h.started.set(7, 'whatever');
    const { managers } = backends(h);
    const res = await managers.detectManager({
      agent: 'claude',
      sessionId: S2,
      cwd: await makeFolder(),
      pid: 7,
      host: 'desktop',
    });
    if (!res.ok) throw new Error(res.error);
    expect(res.manager.pidStartedAt).toBeUndefined();
  });

  it('forgets a running manager and removes its workspace with force', async () => {
    const h = harness();
    const { managers, workspaces, manager } = await external(h);
    expect(await managers.removeManager(manager.id)).toMatchObject({ ok: false });
    expect(await workspaces.removeWorkspace(manager.workspaceId)).toMatchObject({ ok: false });
    expect(await workspaces.removeWorkspace(manager.workspaceId, { force: true })).toEqual({
      ok: true,
    });
    const again = await external(h);
    expect(await again.managers.removeManager(again.manager.id, { force: true })).toEqual({
      ok: true,
    });
    expect(await again.managers.getManager(again.manager.id)).toBeNull();
  });

  it('flips to stopped when the pid dies, and filters by status', async () => {
    const h = harness();
    const { managers, manager } = await external(h);
    expect((await managers.listManagers({ status: 'running' })).map((m) => m.id)).toEqual([
      manager.id,
    ]);
    h.alive.delete(99);
    expect((await managers.getManager(manager.id))?.status).toBe('stopped');
    expect(await managers.listManagers({ status: 'running' })).toEqual([]);
  });

  it('refuses to resume, stop, forget or unregister around a live external session', async () => {
    const h = harness();
    const { managers, workspaces, manager } = await external(h);
    expect(await managers.resumeManager(manager.id)).toMatchObject({
      ok: false,
      error: expect.stringContaining('still running in a terminal'),
    });
    expect(await managers.stopManager(manager.id)).toMatchObject({ ok: false });
    expect(await managers.removeManager(manager.id)).toMatchObject({ ok: false });
    expect(await workspaces.removeWorkspace(manager.workspaceId)).toMatchObject({ ok: false });
    expect(h.spawned.filter((a) => a[0] === 'new-session')).toEqual([]);
  });

  it('resumes a stopped external session in tmux as a hub manager, then stops it', async () => {
    const h = harness();
    const { managers, manager, root } = await external(h);
    expect(manager.resumable).toBe(false);
    h.alive.delete(99);
    expect((await managers.getManager(manager.id))?.resumable).toBe(true);
    const resumed = await managers.resumeManager(manager.id);
    if (!resumed.ok) throw new Error(resumed.error);
    const start = h.spawned.find((a) => a[0] === 'new-session')!;
    expect(start.slice(0, 6)).toEqual([
      'new-session',
      '-d',
      '-s',
      `agentbox-manager-${manager.id}`,
      '-c',
      root,
    ]);
    expect(start[9]).toContain(`'claude' '--resume' '${S1}'`);
    expect(resumed.manager).toMatchObject({ kind: 'tmux', status: 'running', hostIsHub: true });
    expect(resumed.manager.attachCommand).toBe(`tmux attach -t =agentbox-manager-${manager.id}`);

    const stopped = await managers.stopManager(manager.id);
    if (!stopped.ok) throw new Error(stopped.error);
    expect(stopped.manager.status).toBe('stopped');
    expect(await managers.removeManager(manager.id)).toEqual({ ok: true });
    expect(await managers.getManager(manager.id)).toBeNull();
  });

  it('refuses every process op on a manager that runs on another machine', async () => {
    const h = harness();
    const { managers } = backends(h);
    const root = await makeFolder();
    const res = await managers.detectManager({
      agent: 'claude',
      sessionId: S2,
      cwd: root,
      pid: 7,
      host: 'desktop',
    });
    if (!res.ok) throw new Error(res.error);
    // The view says WHERE, not "not resumable": a client compares `host` to its
    // own hostname and retries against the hub there.
    expect(res.manager).toMatchObject({ host: 'desktop', hostIsHub: false });
    for (const op of [
      await managers.resumeManager(res.manager.id),
      await managers.attachManager(res.manager.id),
      await managers.stopManager(res.manager.id),
    ]) {
      expect(op).toMatchObject({
        ok: false,
        code: 'wrong_host',
        details: { host: 'desktop' },
        error: expect.stringMatching(/runs on desktop, not on laptop/),
      });
    }
    const typed = await managers.sendManagerMessage(res.manager.id, { text: 'hi' });
    expect(typed).toMatchObject({
      ok: false,
      code: 'manager_unreachable',
      details: { host: 'desktop' },
    });
    expect(h.spawned.filter((a) => a[0] === 'new-session')).toEqual([]);
  });

  it('answers unknown-manager errors the envelope maps to 404', async () => {
    const { managers } = backends(harness());
    for (const res of [
      await managers.resumeManager('ffffffffffffffff'),
      await managers.stopManager('ffffffffffffffff'),
      await managers.removeManager('ffffffffffffffff'),
      await managers.attachManagerBox('ffffffffffffffff', { boxJobId: 'j1' }),
    ]) {
      expect(res).toMatchObject({ ok: false, error: 'unknown manager ffffffffffffffff' });
    }
    expect(await managers.listWorkspaceManagers('deadbeef')).toBeNull();
    expect(await managers.listManagerSessions('deadbeef')).toBeNull();
  });
});

describe('startManager', () => {
  it('starts several hub managers in one workspace, and resumes a held session instead of duplicating it', async () => {
    const h = harness();
    const { workspaces, managers } = backends(h);
    const added = await workspaces.addWorkspace(
      await workspaceAdd(await makeFolder(), { host: 'laptop' }),
    );
    if (!added.ok) throw new Error(added.error);
    const wsId = added.workspace.id;
    const a = await managers.startManager(wsId, { agent: 'claude' });
    const b = await managers.startManager(wsId, { agent: 'codex' });
    if (!a.ok || !b.ok) throw new Error('start failed');
    expect(a.manager.id).not.toBe(b.manager.id);
    expect((await workspaces.getWorkspace(wsId))?.managers).toEqual({ running: 2, total: 2 });

    // The hub-run claude reports its session id from inside its own tmux.
    await managers.detectManager({
      agent: 'claude',
      sessionId: S1,
      cwd: added.workspace.root!,
      managerId: a.manager.id,
    });
    expect(await managers.startManager(wsId, { agent: 'claude', sessionId: S1 })).toMatchObject({
      ok: false,
      error: expect.stringContaining('already running'),
    });
    const restarted = await managers.startManager(wsId, {
      agent: 'claude',
      sessionId: S1,
      restart: true,
    });
    if (!restarted.ok) throw new Error(restarted.error);
    expect(restarted.manager.id).toBe(a.manager.id);
    expect(await managers.listWorkspaceManagers(wsId)).toHaveLength(2);
  });

  it('rejects a session resume for an agent whose format we cannot resume', async () => {
    const h = harness();
    const { workspaces, managers } = backends(h);
    const added = await workspaces.addWorkspace(
      await workspaceAdd(await makeFolder(), { host: 'laptop' }),
    );
    if (!added.ok) throw new Error(added.error);
    const res = await managers.startManager(added.workspace.id, {
      agent: 'opencode',
      sessionId: 's1',
    });
    expect(res).toMatchObject({
      ok: false,
      error: expect.stringContaining('only supported for claude, codex'),
    });
    expect(h.spawned.filter((a) => a[0] === 'new-session')).toEqual([]);
  });
});

describe("a tmux session in the manager's own folder", () => {
  async function legacyWorkspace(h: Harness) {
    const { workspaces, managers } = backends(h);
    const root = await makeFolder();
    const added = await workspaces.addWorkspace(await workspaceAdd(root, { host: 'laptop' }));
    if (!added.ok) throw new Error(added.error);
    const wsId = added.workspace.id;
    const dir = (await resolveWorkspaceDir(wsId))!;
    return { workspaces, managers, root, wsId, dir };
  }

  it('never folds a terminal session into a current hub-run manager in its folder', async () => {
    const h = harness();
    const { managers, root, wsId } = await legacyWorkspace(h);
    const started = await managers.startManager(wsId, { agent: 'claude' });
    if (!started.ok) throw new Error(started.error);
    const res = await managers.detectManager({
      agent: 'claude',
      sessionId: S1,
      cwd: root,
      pid: 5,
      host: 'laptop',
    });
    if (!res.ok) throw new Error(res.error);
    expect(res.manager.id).not.toBe(started.manager.id);
    expect(res.manager.kind).toBe('external');
  });
});

describe('session titles', () => {
  it('never caches an untitled lookup, and retries a miss only after the TTL', async () => {
    const h = harness();
    let clock = 1_000_000;
    let answer: string | null = '(untitled)';
    const lookups: string[] = [];
    const workspaces = createWorkspaceBackend(h.deps);
    const managers = createManagerBackend(h.deps, {
      workspaceView: (id) => workspaces.getWorkspace(id),
      sessionTitle: async (_agent, _cwd, id) => {
        lookups.push(id);
        return answer;
      },
      now: () => clock,
    });
    const res = await managers.detectManager({
      agent: 'codex',
      sessionId: S2,
      cwd: await makeFolder(),
      host: 'laptop',
    });
    if (!res.ok) throw new Error(res.error);
    expect(res.manager.title).toBeUndefined();
    await managers.listManagers();
    await managers.listManagers();
    expect(lookups).toHaveLength(1);

    answer = null;
    clock += 10 * 60 * 1000 + 1;
    expect((await managers.getManager(res.manager.id))?.title).toBeUndefined();
    expect(lookups).toHaveLength(2);

    answer = 'Fix the login redirect';
    clock += 10 * 60 * 1000 + 1;
    expect((await managers.listManagers())[0]?.title).toBe('Fix the login redirect');
    await managers.listManagers();
    expect(lookups).toHaveLength(3);
  });
});

describe('box pointers', () => {
  it('attaches a create job and heals it to the box the worker recorded', async () => {
    const h = harness({
      boxIds: ['box-9'],
      jobs: [{ id: 'job-1', status: 'done', boxId: 'box-9' }],
    });
    const { managers, workspaces } = backends(h);
    const root = await makeFolder();
    const res = await managers.detectManager({ agent: 'claude', sessionId: S1, cwd: root });
    if (!res.ok) throw new Error(res.error);
    expect(await managers.attachManagerBox(res.manager.id, { boxJobId: 'job-1' })).toEqual({
      ok: true,
    });
    const byBox = await managers.managerByBox();
    expect(byBox.get('box-9')).toBe(res.manager.id);
    expect((await managers.getManager(res.manager.id))?.boxIds).toEqual(['box-9']);

    // A task assigned to that box joins the manager that made it.
    await workspaces.addTask(res.workspace.id, { title: 'x' });
    const assigned = await workspaces.assignTasks(res.workspace.id, ['T-1'], { boxId: 'box-9' });
    if (!assigned.ok) throw new Error(assigned.error);
    expect(assigned.tasks[0]?.managerId).toBe(res.manager.id);
    expect(
      await workspaces.listTasks(res.workspace.id, { managerId: res.manager.id }),
    ).toHaveLength(1);
    expect((await managers.getManager(res.manager.id))?.taskCounts).toEqual({ open: 1, done: 0 });
  });
});

describe('a record whose manager runs on another machine', () => {
  // The record's own `lastSeenAt` comes from the real clock at detect time, and
  // the window fallback measures against it, so the test clock starts from now.
  const BEAT_AT = Date.now();

  /** A record on this disk for a session running on `desktop`, plus a clock. */
  async function remoteManager(clock: { now: number }) {
    const h = harness();
    const workspaces = createWorkspaceBackend(h.deps);
    const managers = createManagerBackend(h.deps, {
      workspaceView: (id) => workspaces.getWorkspace(id),
      now: () => clock.now,
    });
    const res = await managers.detectManager({
      agent: 'claude',
      sessionId: S1,
      cwd: await makeFolder(),
      host: 'desktop',
    });
    if (!res.ok) throw new Error(res.error);
    return { h, managers, id: res.manager.id };
  }

  it('shows what the last heartbeat reported, and never probes a process it cannot see', async () => {
    const clock = { now: BEAT_AT };
    const { h, managers, id } = await remoteManager(clock);
    const beat = await managers.reportManager(id, {
      status: 'running',
      sessionId: S1,
      title: 'plan the migration',
      turn: 4,
      background: { id: '885c3dca', status: 'busy' },
    });
    if (!beat.ok) throw new Error(beat.error);
    expect(beat.manager).toMatchObject({
      status: 'running',
      title: 'plan the migration',
      host: 'desktop',
      hostIsHub: false,
      background: { id: '885c3dca' },
    });
    // No tmux, `ps` or `claude agents` call: that process is not on this machine.
    expect(h.spawned).toEqual([]);
  });

  it('falls back to the last-seen window after three missed heartbeats', async () => {
    const clock = { now: BEAT_AT };
    const { managers, id } = await remoteManager(clock);
    const reported = await managers.reportManager(id, { status: 'running' });
    if (!reported.ok) throw new Error(reported.error);
    expect(reported.manager.status).toBe('running');

    // Stale, but the record was seen recently enough to still read as running.
    clock.now = BEAT_AT + HEARTBEAT_STALE_MS + 1;
    expect((await managers.getManager(id))?.status).toBe('running');
    // Past the last-seen window too: nothing says it is alive any more.
    clock.now = BEAT_AT + MANAGER_SEEN_WINDOW_MS * 2;
    expect((await managers.getManager(id))?.status).toBe('stopped');
  });

  it('refuses a heartbeat for a manager this hub runs itself', async () => {
    const h = harness();
    const { managers } = backends(h);
    const res = await managers.detectManager({
      agent: 'claude',
      sessionId: S2,
      cwd: await makeFolder(),
      host: 'laptop',
    });
    if (!res.ok) throw new Error(res.error);
    expect(await managers.reportManager(res.manager.id, { status: 'stopped' })).toMatchObject({
      ok: false,
      code: 'wrong_host',
      details: { host: 'laptop' },
      error: expect.stringMatching(/probed here, not reported/),
    });
    // The report is not believed: the probe still decides.
    expect((await managers.getManager(res.manager.id))?.status).toBe('running');
  });
});

describe('with the records on a control box', () => {
  /** An in-memory stand-in for the control box's `/api/v1`, recording what travels. */
  function remoteStore(hostname: string): ManagerRecordStore & { calls: string[] } {
    const records = new Map<string, ManagerRecord>();
    const calls: string[] = [];
    const ws = {
      id: 'ws-remote',
      name: 'remote',
      hosts: {} as Record<string, { root: string }>,
    };
    const view = (rec: ManagerRecord): ManagerView => ({
      ...rec,
      status: 'running',
      hostIsHub: rec.host === hostname,
      resumable: false,
      workspaceName: ws.name,
      taskCounts: { open: 0, done: 0 },
    });
    return {
      kind: 'remote',
      calls,
      setRoot(root: string) {
        ws.hosts[hostname] = { root };
      },
      listManagers: async () => [...records.values()],
      readManagers: async () => [...records.values()],
      readWorkspace: async (id) => (id === ws.id ? ws : null),
      findManager: async (id) => records.get(id) ?? null,
      findManagerBySession: async (agent, sessionId) =>
        [...records.values()].find((m) => m.agent === agent && m.sessionId === sessionId) ?? null,
      async registerManager(wsId, input) {
        calls.push(`register ${input.host} ${input.tmuxSession}`);
        const at = new Date().toISOString();
        const id = input.id ?? 'aaaaaaaaaaaaaaaa';
        const rec: ManagerRecord = {
          id,
          workspaceId: wsId,
          agent: input.agent,
          kind: 'tmux',
          cwd: input.cwd,
          host: input.host,
          tmuxSession: input.tmuxSession,
          ...(input.sessionId ? { sessionId: input.sessionId } : {}),
          boxIds: [],
          boxJobIds: [],
          createdAt: at,
          lastSeenAt: at,
        };
        records.set(id, rec);
        return rec;
      },
      async reportManager(id, beat) {
        calls.push(`heartbeat ${id} ${beat.status}`);
      },
      async attachBox(_wsId, id, target) {
        calls.push(`attach-box ${id} ${JSON.stringify(target)}`);
        const rec = records.get(id);
        if (!rec) return;
        if ('boxId' in target) records.set(id, { ...rec, boxIds: [...rec.boxIds, target.boxId] });
        else records.set(id, { ...rec, boxJobIds: [...rec.boxJobIds, target.boxJobId] });
      },
      // The control box takes no other write from another host.
      patchManager: async () => null,
      upsertDetectedManager: () => Promise.reject(new Error('not here')),
      removeManagerRecord: async () => false,
      managerViews: async () => [...records.values()].map(view),
      managerView: async (id) => {
        const rec = records.get(id);
        return rec ? view(rec) : null;
      },
    } as ManagerRecordStore & { calls: string[]; setRoot(root: string): void };
  }

  it('starts the session here, registers it there, and answers with the control box view', async () => {
    const h = harness();
    const store = remoteStore('laptop');
    const root = await makeFolder();
    (store as unknown as { setRoot(r: string): void }).setRoot(root);
    const workspaces = createWorkspaceBackend(h.deps);
    const managers = createManagerBackend(h.deps, {
      workspaceView: (id) => workspaces.getWorkspace(id),
      store,
    });
    const started = await managers.startManager('ws-remote', { agent: 'claude' });
    if (!started.ok) throw new Error(started.error);
    // The tmux session is opened on THIS machine…
    expect(h.spawned.find((a) => a[0] === 'new-session')?.slice(0, 6)).toEqual([
      'new-session',
      '-d',
      '-s',
      `agentbox-manager-${started.manager.id}`,
      '-c',
      root,
    ]);
    // …and only the registration and the heartbeat travel.
    expect(store.calls).toEqual([
      `register laptop agentbox-manager-${started.manager.id}`,
      `heartbeat ${started.manager.id} running`,
    ]);
    expect(started.manager).toMatchObject({
      kind: 'tmux',
      host: 'laptop',
      hostIsHub: true,
      workspaceName: 'remote',
    });
    // Every listing is the control box's, not a local render.
    expect((await managers.listManagers()).map((m) => m.id)).toEqual([started.manager.id]);
  });

  /** A PC hub whose records live on the control box, with its folder ready. */
  async function remote(over: Partial<ManagerRecordStore> = {}) {
    const h = harness();
    const store = Object.assign(remoteStore('laptop'), over);
    const root = await makeFolder();
    (store as unknown as { setRoot(r: string): void }).setRoot(root);
    const workspaces = createWorkspaceBackend(h.deps);
    const managers = createManagerBackend(h.deps, {
      workspaceView: (id) => workspaces.getWorkspace(id),
      store,
    });
    return { h, store, managers, root };
  }

  it('leaves the started/resumed row to the hub that wrote the record', async () => {
    // The register route on the control box records `manager.started` where the
    // workspace is; forwarding a second one through the sink logged every start
    // and every resume twice.
    const { sink, rows } = stubSink();
    configureTimelineSink(sink);
    const { store, managers } = await remote();
    const started = await managers.startManager('ws-remote', { agent: 'claude', sessionId: S1 });
    if (!started.ok) throw new Error(started.error);
    expect(rows.map((r) => r.type)).toEqual([]);
    store.calls.length = 0;
    // Both resume branches: the one inside `startManager` (the same session id
    // again) and `resumeManager` itself.
    const restarted = await managers.startManager('ws-remote', {
      agent: 'claude',
      sessionId: S1,
      restart: true,
    });
    expect(restarted).toMatchObject({ ok: true });
    expect((await managers.stopManager(started.manager.id)).ok).toBe(true);
    expect((await managers.resumeManager(started.manager.id)).ok).toBe(true);
    // Only the stop — which no other hub could know — was forwarded.
    expect(rows.map((r) => r.type)).toEqual(['manager.stopped']);
    // …and the two registrations did travel, which is what writes the rows there.
    expect(store.calls.filter((c) => c.startsWith('register'))).toHaveLength(2);
  });

  it('writes the started and resumed rows itself when the records are on this disk', async () => {
    const { sink, rows } = stubSink();
    configureTimelineSink(sink);
    const h = harness();
    const { workspaces, managers } = backends(h);
    const added = await workspaces.addWorkspace(
      await workspaceAdd(await makeFolder(), { host: 'laptop' }),
    );
    if (!added.ok) throw new Error(added.error);
    const started = await managers.startManager(added.workspace.id, {
      agent: 'claude',
      sessionId: S1,
    });
    if (!started.ok) throw new Error(started.error);
    expect(rows.map((r) => r.type)).toEqual(['manager.started']);
    expect((await managers.stopManager(started.manager.id)).ok).toBe(true);
    expect((await managers.resumeManager(started.manager.id)).ok).toBe(true);
    expect(rows.map((r) => r.type)).toEqual([
      'manager.started',
      'manager.stopped',
      'manager.resumed',
    ]);
  });

  it('kills the session it just opened when the registration is refused', async () => {
    // Otherwise the agent keeps running with nothing pointing at it, and every
    // retry mints a new id and a second session in the same folder.
    const { h, managers } = await remote({
      registerManager: () => Promise.reject(new Error('control box down')),
    });
    const res = await managers.startManager('ws-remote', { agent: 'claude' });
    expect(res).toMatchObject({ ok: false });
    expect(h.tmux.size).toBe(0);
    expect(h.spawned.filter((a) => a[0] === 'kill-session')).toHaveLength(1);
  });

  it('refuses to forget a record it does not hold, instead of claiming it did', async () => {
    const { store, managers } = await remote();
    const started = await managers.startManager('ws-remote', { agent: 'claude' });
    if (!started.ok) throw new Error(started.error);
    const res = await managers.removeManager(started.manager.id, { force: true });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/lives on the hub that owns its workspace/);
    // Still there: the refusal is the truth.
    expect(await store.findManager(started.manager.id)).not.toBeNull();
  });

  it('answers a detect with a refusal rather than a 500', async () => {
    const { managers, root } = await remote();
    const res = await managers.detectManager({ agent: 'claude', sessionId: S2, cwd: root });
    expect(res).toMatchObject({ ok: false });
    expect(res.ok === false && res.error).toMatch(/register the session there/);
  });

  it('sends a box this hub built to the hub that holds the record', async () => {
    const h = harness();
    const store = remoteStore('laptop');
    (store as unknown as { setRoot(r: string): void }).setRoot(await makeFolder());
    const workspaces = createWorkspaceBackend(h.deps);
    const managers = createManagerBackend(h.deps, {
      workspaceView: (id) => workspaces.getWorkspace(id),
      store,
    });
    const started = await managers.startManager('ws-remote', { agent: 'claude' });
    if (!started.ok) throw new Error(started.error);
    store.calls.length = 0;
    expect(await managers.attachManagerBox(started.manager.id, { boxJobId: 'job-7' })).toEqual({
      ok: true,
    });
    expect(store.calls).toEqual([`attach-box ${started.manager.id} {"boxJobId":"job-7"}`]);
    expect((await managers.getManager(started.manager.id))?.boxJobIds).toEqual(['job-7']);
  });
});
