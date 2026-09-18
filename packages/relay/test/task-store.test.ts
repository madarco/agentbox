import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { assertTempHome } from '../../../scripts/test-home.js';
import {
  addTask,
  addWorkspace,
  assignTasks,
  attachBoxToManager,
  filterTasks,
  patchTask,
  readReconciledTasks,
  readTasks,
  readWorkspace,
  reconcileTasks,
  removeTask,
  reorderTasks,
  setTaskDone,
  taskSummaryForBox,
  unassignTasks,
  upsertDetectedManager,
  workspaceRootOn,
  type WorkTask,
} from '../src/workspaces/index.js';

const noRegister = { register: async () => {} };

async function makeWorkspace(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'agentbox-tasks-')));
  await mkdir(join(root, '.git'), { recursive: true });
  return (
    await addWorkspace(
      { host: hostname(), root, projects: [{ path: root, name: 'tasks' }] },
      noRegister,
    )
  ).id;
}

beforeEach(async () => {
  await rm(join(assertTempHome(), '.agentbox', 'workspaces'), { recursive: true, force: true });
});

/** A bare task row, for the pure selectors that take a list. */
function task(over: Partial<WorkTask> & { id: string }): WorkTask {
  return {
    workspaceId: 'ws',
    title: over.id,
    status: 'todo',
    order: 1,
    createdBy: 'human',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

describe('addTask', () => {
  it('numbers tasks sequentially and appends them in order', async () => {
    const ws = await makeWorkspace();
    const a = await addTask(ws, { title: 'first' });
    const b = await addTask(ws, { title: 'second' });
    expect([a.id, b.id]).toEqual(['T-1', 'T-2']);
    expect([a.order, b.order]).toEqual([1, 2]);
    expect(a.status).toBe('todo');
    expect(a.createdBy).toBe('human');
  });

  it('never reuses an id after a delete', async () => {
    const ws = await makeWorkspace();
    await addTask(ws, { title: 'first' });
    await removeTask(ws, 'T-1');
    expect((await addTask(ws, { title: 'again' })).id).toBe('T-2');
  });

  it('marks a task created against a box as in progress', async () => {
    const ws = await makeWorkspace();
    const t = await addTask(ws, { title: 'x', boxJobId: 'job1', createdBy: 'manager' });
    expect(t.boxJobId).toBe('job1');
    expect(t.status).toBe('in_progress');
    expect(t.createdBy).toBe('manager');
  });

  it('rejects a dependency on an unknown task', async () => {
    const ws = await makeWorkspace();
    await expect(addTask(ws, { title: 'x', dependsOn: ['T-9'] })).rejects.toThrow(
      /unknown task T-9/,
    );
  });
});

describe('patchTask', () => {
  it('updates fields, clears the project with null and stamps doneAt', async () => {
    const ws = await makeWorkspace();
    await addTask(ws, { title: 'x', projectId: 'p1', description: 'd' });
    expect((await patchTask(ws, 'T-1', { title: 'y' }))?.title).toBe('y');
    expect((await patchTask(ws, 'T-1', { projectId: null }))?.projectId).toBeUndefined();
    expect((await patchTask(ws, 'T-1', { description: '' }))?.description).toBeUndefined();
    const done = await patchTask(ws, 'T-1', { status: 'done' });
    expect(done?.doneAt).toBeTruthy();
    const reopened = await patchTask(ws, 'T-1', { status: 'todo' });
    expect(reopened?.doneAt).toBeUndefined();
  });

  it('answers null for an unknown task', async () => {
    const ws = await makeWorkspace();
    expect(await patchTask(ws, 'T-7', { title: 'x' })).toBeNull();
  });

  it('rejects a self-dependency', async () => {
    const ws = await makeWorkspace();
    await addTask(ws, { title: 'x' });
    await expect(patchTask(ws, 'T-1', { dependsOn: ['T-1'] })).rejects.toThrow(
      /cannot depend on itself/,
    );
  });
});

describe('removeTask', () => {
  it('drops the id from every other task dependsOn', async () => {
    const ws = await makeWorkspace();
    await addTask(ws, { title: 'a' });
    await addTask(ws, { title: 'b', dependsOn: ['T-1'] });
    expect(await removeTask(ws, 'T-1')).toBe(true);
    const [b] = await readTasks(ws);
    expect(b?.dependsOn).toBeUndefined();
  });
});

describe('assignTasks', () => {
  it('sets boxId exclusively and flips todo to in progress', async () => {
    const ws = await makeWorkspace();
    await addTask(ws, { title: 'a', boxJobId: 'job1' });
    const [t] = await assignTasks(ws, ['T-1'], { boxId: 'box1' });
    expect(t?.boxId).toBe('box1');
    expect(t?.boxJobId).toBeUndefined();
    expect(t?.status).toBe('in_progress');
  });

  it('unassign returns the task to the backlog without reopening finished work', async () => {
    const ws = await makeWorkspace();
    await addTask(ws, { title: 'a' });
    await addTask(ws, { title: 'b' });
    await assignTasks(ws, ['T-1', 'T-2'], { boxId: 'box1' });
    await setTaskDone(ws, 'T-2');
    const [a, b] = await unassignTasks(ws, ['T-1', 'T-2']);
    expect(a?.boxId).toBeUndefined();
    expect(a?.status).toBe('todo');
    expect(b?.status).toBe('done');
  });

  it('refuses an unknown task id', async () => {
    const ws = await makeWorkspace();
    await expect(assignTasks(ws, ['T-9'], { boxId: 'b' })).rejects.toThrow(/unknown task T-9/);
  });

  it('inherits the manager that made the box, without overriding one already set', async () => {
    const ws = await makeWorkspace();
    const root = workspaceRootOn((await readWorkspace(ws))!, hostname())!;
    const { manager } = await upsertDetectedManager(ws, {
      agent: 'claude',
      sessionId: 's1',
      cwd: root,
    });
    await attachBoxToManager(ws, manager.id, { boxJobId: 'job1' });
    await addTask(ws, { title: 'a' });
    await addTask(ws, { title: 'b', managerId: 'aaaaaaaaaaaaaaaa' });
    const [a, b] = await assignTasks(ws, ['T-1', 'T-2'], { boxJobId: 'job1' });
    expect(a?.managerId).toBe(manager.id);
    expect(b?.managerId).toBe('aaaaaaaaaaaaaaaa');
    // A task created straight onto the box inherits too.
    expect((await addTask(ws, { title: 'c', boxJobId: 'job1' })).managerId).toBe(manager.id);
    expect(filterTasks(await readTasks(ws), { managerId: manager.id }).map((t) => t.id)).toEqual([
      'T-1',
      'T-3',
    ]);
    expect((await patchTask(ws, 'T-1', { managerId: null }))?.managerId).toBeUndefined();
  });
});

describe('reorderTasks', () => {
  it('renumbers to the given order', async () => {
    const ws = await makeWorkspace();
    for (const t of ['a', 'b', 'c']) await addTask(ws, { title: t });
    const out = await reorderTasks(ws, ['T-3', 'T-1', 'T-2']);
    expect(out.map((t) => t.id)).toEqual(['T-3', 'T-1', 'T-2']);
    expect(out.map((t) => t.order)).toEqual([1, 2, 3]);
  });

  it('rejects a partial list, a duplicate and an unknown id', async () => {
    const ws = await makeWorkspace();
    await addTask(ws, { title: 'a' });
    await addTask(ws, { title: 'b' });
    await expect(reorderTasks(ws, ['T-1'])).rejects.toThrow(/missing T-2/);
    await expect(reorderTasks(ws, ['T-1', 'T-1'])).rejects.toThrow(/duplicate/);
    await expect(reorderTasks(ws, ['T-1', 'T-9'])).rejects.toThrow(/unknown task T-9/);
  });
});

describe('reconcileTasks', () => {
  const live = (...ids: string[]) => new Set(ids);

  it('promotes a job id to the box id the job recorded', () => {
    const r = reconcileTasks([task({ id: 'T-1', boxJobId: 'j1' })], {
      liveBoxIds: live('b1'),
      jobs: [{ id: 'j1', status: 'running', boxId: 'b1' }],
    });
    expect(r.changed).toBe(true);
    expect(r.tasks[0]).toMatchObject({ boxId: 'b1' });
    expect(r.tasks[0]?.boxJobId).toBeUndefined();
  });

  it('clears a job id whose job failed or was cancelled', () => {
    for (const status of ['failed', 'cancelled']) {
      const r = reconcileTasks([task({ id: 'T-1', boxJobId: 'j1' })], {
        liveBoxIds: live(),
        jobs: [{ id: 'j1', status }],
      });
      expect(r.changed).toBe(true);
      expect(r.tasks[0]?.boxJobId).toBeUndefined();
    }
  });

  it('keeps a job id whose manifest the queue has swept', () => {
    // The relay deletes terminal manifests on a timer, so a MISSING job is not
    // evidence the create failed — unassigning here would drop the tasks of a
    // box that came up fine.
    const r = reconcileTasks([task({ id: 'T-1', boxJobId: 'j1' })], {
      liveBoxIds: live('b1'),
      jobs: [],
    });
    expect(r.changed).toBe(false);
    expect(r.tasks[0]?.boxJobId).toBe('j1');
  });

  it('keeps a job id while the create is still queued', () => {
    const r = reconcileTasks([task({ id: 'T-1', boxJobId: 'j1' })], {
      liveBoxIds: live(),
      jobs: [{ id: 'j1', status: 'queued' }],
    });
    expect(r.changed).toBe(false);
    expect(r.tasks[0]?.boxJobId).toBe('j1');
  });

  it('drops a job id only when that create explicitly failed', () => {
    for (const status of ['failed', 'cancelled']) {
      const r = reconcileTasks([task({ id: 'T-1', boxJobId: 'j1' })], {
        liveBoxIds: live(),
        jobs: [{ id: 'j1', status }],
      });
      expect(r.changed, status).toBe(true);
      expect(r.tasks[0]?.boxJobId).toBeUndefined();
    }
  });

  it('keeps a box id this hub has no record of: absence is not a destroy', () => {
    // A docker box on the PC, with the store on a control box, is simply not in
    // THIS hub's inventory. Unassigning on that would empty every such list.
    const r = reconcileTasks([task({ id: 'T-1', boxId: 'b1', status: 'in_progress' })], {
      liveBoxIds: live('other'),
      jobs: [],
    });
    expect(r.changed).toBe(false);
    expect(r.tasks[0]?.boxId).toBe('b1');
    expect(r.tasks[0]?.status).toBe('in_progress');
  });

  it('keeps a box id the running create has recorded but not yet registered', () => {
    const r = reconcileTasks([task({ id: 'T-1', boxId: 'b1' })], {
      liveBoxIds: live(),
      jobs: [{ id: 'j1', status: 'running', boxId: 'b1' }],
    });
    expect(r.changed).toBe(false);
    expect(r.tasks[0]?.boxId).toBe('b1');
  });

  it('reports no change when everything already matches', () => {
    const r = reconcileTasks([task({ id: 'T-1', boxId: 'b1' })], {
      liveBoxIds: live('b1'),
      jobs: [],
    });
    expect(r.changed).toBe(false);
  });
});

describe('taskSummaryForBox', () => {
  const tasks = [
    task({ id: 'T-1', boxId: 'b1', status: 'done', order: 1 }),
    task({ id: 'T-2', boxId: 'b1', status: 'in_progress', order: 2 }),
    task({ id: 'T-3', boxId: 'b1', status: 'todo', order: 3 }),
    task({ id: 'T-4', boxId: 'b2', order: 4 }),
  ];

  it('counts a box tasks and names the one in progress', () => {
    expect(taskSummaryForBox(tasks, { boxId: 'b1' })).toEqual({
      total: 3,
      done: 1,
      current: { id: 'T-2', title: 'T-2' },
    });
  });

  it('falls back to the next unfinished task, then to null', () => {
    const queued = [
      task({ id: 'T-1', boxId: 'b1', status: 'done', order: 1 }),
      task({ id: 'T-2', boxId: 'b1', order: 2 }),
    ];
    expect(taskSummaryForBox(queued, { boxId: 'b1' })?.current?.id).toBe('T-2');
    const allDone = [task({ id: 'T-1', boxId: 'b1', status: 'done', order: 1 })];
    expect(taskSummaryForBox(allDone, { boxId: 'b1' })?.current).toBeNull();
  });

  it('is undefined for a box with no tasks, and matches a pending job id', () => {
    expect(taskSummaryForBox(tasks, { boxId: 'nope' })).toBeUndefined();
    const pending = [task({ id: 'T-1', boxJobId: 'j1' })];
    expect(taskSummaryForBox(pending, { boxJobId: 'j1' })?.total).toBe(1);
  });
});

describe('readReconciledTasks', () => {
  it('heals and persists the correction', async () => {
    const ws = await makeWorkspace();
    await addTask(ws, { title: 'a', boxJobId: 'j1' });
    const healed = await readReconciledTasks(ws, {
      liveBoxIds: new Set(['b1']),
      jobs: [{ id: 'j1', status: 'done', boxId: 'b1' }],
    });
    expect(healed[0]).toMatchObject({ boxId: 'b1' });
    // Persisted, not just returned — the next read must not redo the work.
    expect((await readTasks(ws))[0]).toMatchObject({ boxId: 'b1' });
  });

  it('writes nothing when nothing moved', async () => {
    const ws = await makeWorkspace();
    await addTask(ws, { title: 'a', boxId: 'b1' });
    const before = (await readTasks(ws))[0]!.updatedAt;
    await readReconciledTasks(ws, { liveBoxIds: new Set(['b1']), jobs: [] });
    // This runs on every dashboard poll; a write per poll would be a write storm.
    expect((await readTasks(ws))[0]!.updatedAt).toBe(before);
  });
});

describe('the task-id counter survives a rescan', () => {
  it('re-registering a workspace keeps the counter, so ids are never reused', async () => {
    const ws = await makeWorkspace();
    const root = workspaceRootOn((await readWorkspace(ws))!, hostname())!;
    await addTask(ws, { title: 'first' });
    await addTask(ws, { title: 'second' });
    // `POST /workspaces` on a known root rescans it, rewriting the whole record.
    // Dropping the counter here would hand `T-2` out twice.
    await addWorkspace(
      { host: hostname(), root, projects: [{ path: root, name: 'tasks' }] },
      noRegister,
    );
    expect((await addTask(ws, { title: 'third' })).id).toBe('T-3');
    expect(new Set((await readTasks(ws)).map((t) => t.id)).size).toBe(3);
  });
});
