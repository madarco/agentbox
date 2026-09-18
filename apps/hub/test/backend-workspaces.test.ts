import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { assertTempHome } from '../../../scripts/test-home.js';
import { workspaceAdd } from './_workspace-input';
import { createWorkspaceBackend } from '../lib/backend/workspaces';
import type { BackendDeps } from '../lib/backend/deps';
import { attachBoxToManager, readManagers, upsertDetectedManager } from '@agentbox/relay';
import type { QueueJob } from '@agentbox/relay';

// The slice's whole point: it is drivable with three seams and no relay handle.
function makeDeps(
  over: Partial<{ boxIds: string[]; jobs: Partial<QueueJob>[] }> = {},
): BackendDeps & {
  notify: ReturnType<typeof vi.fn>;
} {
  const notify = vi.fn();
  return {
    notify,
    liveBoxIds: async () => new Set(over.boxIds ?? []),
    jobs: async () => (over.jobs ?? []) as QueueJob[],
  };
}

async function makeFolder(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'agentbox-hubws-')));
  await mkdir(join(root, 'app', '.git'), { recursive: true });
  await mkdir(join(root, 'api', '.git'), { recursive: true });
  return root;
}

beforeEach(async () => {
  await rm(join(assertTempHome(), '.agentbox'), { recursive: true, force: true });
});

describe('addWorkspace', () => {
  it('records the scan the client sent and notifies', async () => {
    const deps = makeDeps();
    const backend = createWorkspaceBackend(deps);
    const root = await makeFolder();
    const res = await backend.addWorkspace(await workspaceAdd(root));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.workspace.projects).toHaveLength(2);
    expect(res.workspace.root).toBe(root);
    expect(res.workspace.hosts[hostname()]?.root).toBe(root);
    // A local folder answers to its path hash too, so the project registry joins.
    expect(res.workspace.projectIds.length).toBeGreaterThanOrEqual(2);
    expect(res.workspace.taskCounts).toEqual({ open: 0, done: 0 });
    expect(res.workspace.managers).toEqual({ running: 0, total: 0 });
    expect(deps.notify).toHaveBeenCalledTimes(1);
    expect(await backend.listWorkspaces()).toHaveLength(1);
  });

  it("registers a folder it cannot see: the hub never stats the caller's paths", async () => {
    const backend = createWorkspaceBackend(makeDeps());
    const res = await backend.addWorkspace({
      host: 'laptop',
      root: '/home/dev/work',
      projects: [{ path: '/home/dev/work/app', repoUrl: 'git@github.com:acme/app.git' }],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // No folder HERE, so no root in the view — and no path-hash project id.
    expect(res.workspace.root).toBeUndefined();
    expect(res.workspace.hosts['laptop']?.root).toBe('/home/dev/work');
    expect(res.workspace.projectIds).toHaveLength(1);
  });

  it('refuses a relative root or project path', async () => {
    const backend = createWorkspaceBackend(makeDeps());
    expect(
      await backend.addWorkspace({ host: 'pc', root: 'relative', projects: [] }),
    ).toMatchObject({ ok: false, error: expect.stringContaining('absolute') });
    expect(
      await backend.addWorkspace({ host: 'pc', root: '/ok', projects: [{ path: 'nope' }] }),
    ).toMatchObject({ ok: false, error: expect.stringContaining('absolute') });
  });

  it('is idempotent on (host, root), and merges a second machine by repo', async () => {
    const backend = createWorkspaceBackend(makeDeps());
    const root = await makeFolder();
    const scan = await workspaceAdd(root);
    const withRepos = {
      ...scan,
      projects: scan.projects.map((p, i) => ({
        ...p,
        repoUrl: `git@github.com:acme/${i === 0 ? 'api' : 'app'}.git`,
      })),
    };
    const first = await backend.addWorkspace(withRepos);
    const again = await backend.addWorkspace(withRepos);
    expect(first.ok && again.ok && again.workspace.id).toBe(first.ok ? first.workspace.id : null);
    expect(await backend.listWorkspaces()).toHaveLength(1);

    // Another machine's checkout of one of the same repos, spelled over https.
    const merged = await backend.addWorkspace({
      host: 'laptop',
      root: '/home/dev/work',
      projects: [{ path: '/home/dev/work/app', repoUrl: 'https://github.com/acme/app' }],
    });
    expect(merged.ok && merged.workspace.id).toBe(first.ok ? first.workspace.id : null);
    expect(merged.ok && merged.workspace.hosts['laptop']?.root).toBe('/home/dev/work');
    expect(await backend.listWorkspaces()).toHaveLength(1);
  });

  it('answers not-found shaped errors for an unknown workspace', async () => {
    const backend = createWorkspaceBackend(makeDeps());
    expect(await backend.getWorkspace('deadbeef')).toBeNull();
    expect(await backend.listTasks('deadbeef')).toBeNull();
    // The route maps this string to a 404 via failFromAction.
    expect(await backend.renameWorkspace('deadbeef', 'x')).toMatchObject({
      ok: false,
      error: 'unknown workspace deadbeef',
    });
  });
});

describe('tasks', () => {
  async function seeded() {
    const deps = makeDeps({ boxIds: ['box1'] });
    const backend = createWorkspaceBackend(deps);
    const root = await makeFolder();
    const res = await backend.addWorkspace(await workspaceAdd(root));
    if (!res.ok) throw new Error(res.error);
    deps.notify.mockClear();
    return { backend, deps, wsId: res.workspace.id };
  }

  it('adds, lists in order, updates and completes', async () => {
    const { backend, deps, wsId } = await seeded();
    await backend.addTask(wsId, { title: 'first' });
    await backend.addTask(wsId, { title: 'second' });
    const tasks = await backend.listTasks(wsId);
    expect(tasks?.map((t) => t.title)).toEqual(['first', 'second']);
    await backend.updateTask(wsId, 'T-2', { status: 'blocked' });
    expect((await backend.getTask(wsId, 'T-2'))?.status).toBe('blocked');
    const done = await backend.completeTask(wsId, 'T-1');
    expect(done).toMatchObject({ ok: true });
    expect((await backend.getWorkspace(wsId))?.taskCounts).toEqual({ open: 1, done: 1 });
    // Every mutation fires the live-update fan-out.
    expect(deps.notify.mock.calls.length).toBe(4);
  });

  it('filters by status, project and box', async () => {
    const { backend, wsId } = await seeded();
    await backend.addTask(wsId, { title: 'a', projectId: 'p1' });
    await backend.addTask(wsId, { title: 'b' });
    await backend.assignTasks(wsId, ['T-2'], { boxId: 'box1' });
    expect((await backend.listTasks(wsId, { projectId: 'p1' }))?.map((t) => t.id)).toEqual(['T-1']);
    expect((await backend.listTasks(wsId, { boxId: 'box1' }))?.map((t) => t.id)).toEqual(['T-2']);
    expect((await backend.listTasks(wsId, { status: 'todo' }))?.map((t) => t.id)).toEqual(['T-1']);
  });

  it('refuses an assignment to a box or job that does not exist', async () => {
    const { backend, wsId } = await seeded();
    await backend.addTask(wsId, { title: 'a' });
    expect(await backend.assignTasks(wsId, ['T-1'], { boxId: 'ghost' })).toMatchObject({
      ok: false,
      error: 'unknown box ghost',
    });
    expect(await backend.assignTasks(wsId, ['T-1'], { boxJobId: 'ghost' })).toMatchObject({
      ok: false,
      error: 'unknown job ghost',
    });
  });

  it('reorders and refuses a partial order', async () => {
    const { backend, wsId } = await seeded();
    for (const t of ['a', 'b', 'c']) await backend.addTask(wsId, { title: t });
    const res = await backend.reorderTasks(wsId, ['T-3', 'T-2', 'T-1']);
    expect(res.ok && res.tasks.map((t) => t.id)).toEqual(['T-3', 'T-2', 'T-1']);
    expect(await backend.reorderTasks(wsId, ['T-1'])).toMatchObject({ ok: false });
  });

  it('answers unknown-task errors the routes can map to 404', async () => {
    const { backend, wsId } = await seeded();
    expect(await backend.completeTask(wsId, 'T-9')).toMatchObject({
      ok: false,
      error: 'unknown task T-9',
    });
    expect(await backend.removeTask(wsId, 'T-9')).toMatchObject({
      ok: false,
      error: 'unknown task T-9',
    });
    expect(await backend.updateTask(wsId, 'T-9', { title: 'x' })).toMatchObject({ ok: false });
  });
});

describe('reconciliation through the backend', () => {
  it('promotes a pending create job to its box id once the worker records it', async () => {
    const deps = makeDeps({ jobs: [{ id: 'j1', kind: 'create', status: 'queued' }] });
    const backend = createWorkspaceBackend(deps);
    const root = await makeFolder();
    const added = await backend.addWorkspace(await workspaceAdd(root));
    if (!added.ok) throw new Error(added.error);
    const wsId = added.workspace.id;
    await backend.addTask(wsId, { title: 'a', boxJobId: 'j1' });
    expect((await backend.listTasks(wsId))?.[0]).toMatchObject({ boxJobId: 'j1' });

    // The worker finishes: the job now carries a box id and the box is live.
    const after = createWorkspaceBackend(
      makeDeps({
        boxIds: ['box9'],
        jobs: [{ id: 'j1', kind: 'create', status: 'done', boxId: 'box9' }],
      }),
    );
    const healed = await after.listTasks(wsId);
    expect(healed?.[0]).toMatchObject({ boxId: 'box9' });
    expect(healed?.[0]?.boxJobId).toBeUndefined();
  });

  it('keeps a task on a box this hub has no record of, and drops it when the box is gone', async () => {
    const deps = makeDeps({ boxIds: ['box1'] });
    const backend = createWorkspaceBackend(deps);
    const root = await makeFolder();
    const added = await backend.addWorkspace(await workspaceAdd(root));
    if (!added.ok) throw new Error(added.error);
    const wsId = added.workspace.id;
    await backend.addTask(wsId, { title: 'a', boxId: 'box1' });
    // A box created on another machine is simply not in this hub's inventory:
    // that is not evidence it is gone, so the assignment stands.
    const other = createWorkspaceBackend(makeDeps({ boxIds: [] }));
    expect((await other.listTasks(wsId))?.[0]?.boxId).toBe('box1');
    // A manager holding the box keeps it for the same reason.
    const { manager } = await upsertDetectedManager(wsId, {
      agent: 'claude',
      sessionId: '11111111-2222-3333-4444-555555555555',
      cwd: root,
    });
    await attachBoxToManager(wsId, manager.id, { boxId: 'box1' });
    // The destroy (or a prune) says so explicitly.
    await backend.boxGone('box1');
    const healed = await backend.listTasks(wsId);
    expect(healed?.[0]?.boxId).toBeUndefined();
    // Back in the backlog, exactly as a manual unassign leaves it.
    expect(healed?.[0]?.status).toBe('todo');
    // ... and the manager no longer claims it.
    expect((await readManagers(wsId))[0]?.boxIds).toEqual([]);
  });
});

describe('an add that names an id', () => {
  it('is a not-found, never a new record, when the id names nothing', async () => {
    const backend = createWorkspaceBackend(makeDeps());
    const root = await makeFolder();
    const res = await backend.addWorkspace(await workspaceAdd(root, { id: 'deadbeefdeadbeef' }));
    expect(res.ok).toBe(false);
    // The wording the route turns into a 404.
    if (!res.ok) expect(res.error).toBe('unknown workspace deadbeefdeadbeef');
    expect(await backend.listWorkspaces()).toEqual([]);
  });
});

describe('getData hooks', () => {
  it('maps projects to their workspace and rolls tasks up per box and per job', async () => {
    const deps = makeDeps({
      boxIds: ['box1'],
      jobs: [{ id: 'j1', kind: 'create', status: 'running' }],
    });
    const backend = createWorkspaceBackend(deps);
    const root = await makeFolder();
    const added = await backend.addWorkspace(await workspaceAdd(root));
    if (!added.ok) throw new Error(added.error);
    const wsId = added.workspace.id;
    const projectId = added.workspace.projectIds[0]!;

    await backend.addTask(wsId, { title: 'a', boxId: 'box1' });
    await backend.addTask(wsId, { title: 'b', boxId: 'box1' });
    await backend.completeTask(wsId, 'T-1');
    await backend.addTask(wsId, { title: 'c', boxJobId: 'j1' });

    expect((await backend.workspaceIdByProject()).get(projectId)).toBe(wsId);
    const { byBox, byJob } = await backend.taskSummaries();
    expect(byBox.get('box1')).toEqual({ total: 2, done: 1, current: { id: 'T-2', title: 'b' } });
    expect(byJob.get('j1')?.total).toBe(1);
    expect(byBox.get('nothing')).toBeUndefined();
  });
});
