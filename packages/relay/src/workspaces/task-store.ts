import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { withFileLock } from '@agentbox/config';
import {
  resolveWorkspaceDir,
  tasksFile,
  updateWorkspace,
  WORKSPACE_LOCK,
  workspaceDir,
} from './workspace-store.js';
import { managerIdForTarget } from './manager.js';
import type {
  BoxTaskSummary,
  TaskFile,
  WorkTask,
  WorkTaskExternalRef,
  WorkTaskStatus,
} from './types.js';

export interface TaskFilter {
  projectId?: string;
  boxId?: string;
  status?: WorkTaskStatus;
  managerId?: string;
}

export interface AddTaskInput {
  title: string;
  description?: string;
  projectId?: string;
  dependsOn?: string[];
  createdBy?: WorkTask['createdBy'];
  externalRef?: WorkTaskExternalRef;
  boxId?: string;
  boxJobId?: string;
  managerId?: string;
}

export interface UpdateTaskInput {
  title?: string;
  description?: string;
  status?: WorkTaskStatus;
  /** `null` clears the project scope; `undefined` leaves it alone. */
  projectId?: string | null;
  dependsOn?: string[];
  externalRef?: WorkTaskExternalRef;
  /** `null` clears the manager; `undefined` leaves it alone. */
  managerId?: string | null;
}

/** Which box (or pending create job) a task is assigned to. */
export type AssignTarget = { boxId: string } | { boxJobId: string };

export function nextTaskId(counter: number): string {
  return `T-${String(counter + 1)}`;
}

async function tasksPathFor(wsId: string, root?: string): Promise<string> {
  const dir = (await resolveWorkspaceDir(wsId)) ?? workspaceDir(wsId, root);
  return tasksFile(dir);
}

export async function readTasks(wsId: string): Promise<WorkTask[]> {
  try {
    const raw = await readFile(await tasksPathFor(wsId), 'utf8');
    const parsed = JSON.parse(raw) as TaskFile;
    return Array.isArray(parsed.tasks) ? parsed.tasks : [];
  } catch {
    // Missing or malformed: an empty list is the right answer either way — a
    // workspace with no tasks.json has no tasks.
    return [];
  }
}

export async function writeTasks(wsId: string, tasks: WorkTask[]): Promise<void> {
  const final = await tasksPathFor(wsId);
  await mkdir(final.slice(0, final.lastIndexOf('/')), { recursive: true });
  const tmp = `${final}.tmp.${String(process.pid)}.${Date.now().toString(36)}`;
  const doc: TaskFile = { version: 1, tasks };
  await writeFile(tmp, JSON.stringify(doc, null, 2) + '\n', 'utf8');
  await rename(tmp, final);
}

/** Locked read-modify-write of a workspace's task list. */
export async function updateTasks<T>(
  wsId: string,
  fn: (
    tasks: WorkTask[],
  ) => { tasks: WorkTask[]; result: T } | Promise<{ tasks: WorkTask[]; result: T }>,
): Promise<T> {
  const path = await tasksPathFor(wsId);
  return withFileLock(
    path,
    async () => {
      const current = await readTasks(wsId);
      const { tasks, result } = await fn(current);
      await writeTasks(wsId, tasks);
      return result;
    },
    WORKSPACE_LOCK,
  );
}

export function sortTasksByOrder(tasks: WorkTask[]): WorkTask[] {
  return [...tasks].sort((a, b) => a.order - b.order);
}

export function filterTasks(tasks: WorkTask[], f: TaskFilter = {}): WorkTask[] {
  return sortTasksByOrder(tasks).filter((t) => {
    if (f.projectId !== undefined && t.projectId !== f.projectId) return false;
    if (f.boxId !== undefined && t.boxId !== f.boxId) return false;
    if (f.status !== undefined && t.status !== f.status) return false;
    if (f.managerId !== undefined && t.managerId !== f.managerId) return false;
    return true;
  });
}

/** Error message for an unusable `dependsOn`, or null when it is fine. */
export function validateDependsOn(
  tasks: WorkTask[],
  taskId: string,
  dependsOn: string[],
): string | null {
  const known = new Set(tasks.map((t) => t.id));
  for (const dep of dependsOn) {
    if (dep === taskId) return `task ${taskId} cannot depend on itself`;
    if (!known.has(dep)) return `unknown task ${dep}`;
  }
  return null;
}

/**
 * Append a task. The id counter lives on the workspace record, so this takes the
 * workspace lock too; the order is always tasks-then-workspace so two concurrent
 * writers cannot deadlock against each other.
 */
export async function addTask(wsId: string, input: AddTaskInput): Promise<WorkTask> {
  const target = input.boxId
    ? { boxId: input.boxId }
    : input.boxJobId
      ? { boxJobId: input.boxJobId }
      : null;
  const managerId =
    input.managerId ??
    (target ? await managerIdForTarget(target, { workspaceId: wsId }) : undefined);
  return updateTasks(wsId, async (tasks) => {
    if (input.dependsOn?.length) {
      const err = validateDependsOn(tasks, '', input.dependsOn);
      if (err) throw new Error(err);
    }
    const bumped = await updateWorkspace(wsId, (rec) => ({
      ...rec,
      taskCounter: rec.taskCounter + 1,
    }));
    if (!bumped) throw new Error(`unknown workspace ${wsId}`);
    const now = new Date().toISOString();
    const task: WorkTask = {
      id: nextTaskId(bumped.taskCounter - 1),
      workspaceId: wsId,
      title: input.title,
      status: 'todo',
      order: tasks.reduce((max, t) => Math.max(max, t.order), 0) + 1,
      createdBy: input.createdBy ?? 'human',
      createdAt: now,
      updatedAt: now,
      ...(input.description ? { description: input.description } : {}),
      ...(input.projectId ? { projectId: input.projectId } : {}),
      ...(input.dependsOn?.length ? { dependsOn: input.dependsOn } : {}),
      ...(input.externalRef ? { externalRef: input.externalRef } : {}),
      ...(managerId ? { managerId } : {}),
      ...(input.boxId ? { boxId: input.boxId, status: 'in_progress' as const } : {}),
      ...(input.boxJobId ? { boxJobId: input.boxJobId, status: 'in_progress' as const } : {}),
    };
    return { tasks: [...tasks, task], result: task };
  });
}

export async function patchTask(
  wsId: string,
  taskId: string,
  patch: UpdateTaskInput,
): Promise<WorkTask | null> {
  return updateTasks(wsId, (tasks) => {
    const idx = tasks.findIndex((t) => t.id === taskId);
    if (idx === -1) return { tasks, result: null };
    if (patch.dependsOn) {
      const err = validateDependsOn(tasks, taskId, patch.dependsOn);
      if (err) throw new Error(err);
    }
    const prev = tasks[idx]!;
    const next: WorkTask = { ...prev, updatedAt: new Date().toISOString() };
    if (patch.title !== undefined) next.title = patch.title;
    if (patch.description !== undefined) {
      if (patch.description === '') delete next.description;
      else next.description = patch.description;
    }
    if (patch.projectId !== undefined) {
      if (patch.projectId === null) delete next.projectId;
      else next.projectId = patch.projectId;
    }
    if (patch.dependsOn !== undefined) {
      if (patch.dependsOn.length === 0) delete next.dependsOn;
      else next.dependsOn = patch.dependsOn;
    }
    if (patch.externalRef !== undefined) next.externalRef = patch.externalRef;
    if (patch.managerId !== undefined) {
      if (patch.managerId === null) delete next.managerId;
      else next.managerId = patch.managerId;
    }
    if (patch.status !== undefined) applyStatus(next, patch.status);
    const out = [...tasks];
    out[idx] = next;
    return { tasks: out, result: next };
  });
}

function applyStatus(task: WorkTask, status: WorkTaskStatus): void {
  task.status = status;
  if (status === 'done') task.doneAt = task.doneAt ?? new Date().toISOString();
  else delete task.doneAt;
}

export async function setTaskDone(wsId: string, taskId: string): Promise<WorkTask | null> {
  return patchTask(wsId, taskId, { status: 'done' });
}

/**
 * Delete a task and drop it from every other task's `dependsOn` — a dangling
 * dependency would block a task forever with nothing to point at.
 */
export async function removeTask(wsId: string, taskId: string): Promise<boolean> {
  return updateTasks(wsId, (tasks) => {
    if (!tasks.some((t) => t.id === taskId)) return { tasks, result: false };
    const out = tasks
      .filter((t) => t.id !== taskId)
      .map((t) => {
        if (!t.dependsOn?.includes(taskId)) return t;
        const deps = t.dependsOn.filter((d) => d !== taskId);
        const next = { ...t, updatedAt: new Date().toISOString() };
        if (deps.length) next.dependsOn = deps;
        else delete next.dependsOn;
        return next;
      });
    return { tasks: out, result: true };
  });
}

/**
 * Point tasks at a box (or the create job that will become one). A `todo` task
 * becomes `in_progress`; a `done` one is left alone, since re-assigning finished
 * work should not reopen it.
 */
export async function assignTasks(
  wsId: string,
  ids: string[],
  target: AssignTarget | null,
): Promise<WorkTask[]> {
  // A task with no manager joins the one that made its box: that session is the
  // one working it. Resolved before the lock — it reads every workspace's managers.
  const inherited = target ? await managerIdForTarget(target, { workspaceId: wsId }) : undefined;
  return updateTasks(wsId, (tasks) => {
    const wanted = new Set(ids);
    const missing = ids.filter((id) => !tasks.some((t) => t.id === id));
    if (missing.length) throw new Error(`unknown task ${missing.join(', ')}`);
    const now = new Date().toISOString();
    const out = tasks.map((t) => {
      if (!wanted.has(t.id)) return t;
      const next: WorkTask = { ...t, updatedAt: now };
      delete next.boxId;
      delete next.boxJobId;
      if (target && 'boxId' in target) next.boxId = target.boxId;
      else if (target) next.boxJobId = target.boxJobId;
      if (inherited && !next.managerId) next.managerId = inherited;
      if (target && next.status === 'todo') next.status = 'in_progress';
      if (!target && next.status === 'in_progress') next.status = 'todo';
      return next;
    });
    return { tasks: out, result: out.filter((t) => wanted.has(t.id)) };
  });
}

export async function unassignTasks(wsId: string, ids: string[]): Promise<WorkTask[]> {
  return assignTasks(wsId, ids, null);
}

/**
 * Set the whole priority order. `ids` must be an exact permutation of the
 * workspace's tasks: a partial list would silently renumber the rest, and the
 * order is what the manager reads as intent.
 */
export async function reorderTasks(wsId: string, ids: string[]): Promise<WorkTask[]> {
  return updateTasks(wsId, (tasks) => {
    const known = new Set(tasks.map((t) => t.id));
    const seen = new Set<string>();
    for (const id of ids) {
      if (!known.has(id)) throw new Error(`unknown task ${id}`);
      if (seen.has(id)) throw new Error(`duplicate task ${id}`);
      seen.add(id);
    }
    const missing = [...known].filter((id) => !seen.has(id));
    if (missing.length)
      throw new Error(`reorder must list every task; missing ${missing.join(', ')}`);
    const byId = new Map(tasks.map((t) => [t.id, t]));
    const now = new Date().toISOString();
    const out = ids.map((id, i) => ({ ...byId.get(id)!, order: i + 1, updatedAt: now }));
    return { tasks: out, result: out };
  });
}

/**
 * The live-box facts reconciliation needs, so it stays pure and testable.
 *
 * `liveBoxIds` is read by the MANAGER reconciler only. A task's box assignment
 * is not healed from it: a hub holds the inventory of the boxes IT knows, and a
 * box created on another machine (a docker box on the PC, with the store on a
 * control box) is simply absent — unassigning on that would empty the task list
 * of every box the hub does not run. A destroy says the box is gone.
 */
export interface ReconcileContext {
  /** Ids of boxes that exist right now (local records + store registrations). */
  liveBoxIds: Set<string>;
  jobs: { id: string; status: string; boxId?: string }[];
}

const FAILED_JOB_STATUSES = new Set(['failed', 'cancelled']);

/**
 * Heal assignments against reality. A task assigned at create time carries a job
 * id until the worker records the box; the pointer is cleared when that create
 * explicitly failed.
 *
 * A box id is NOT healed here: only an explicit destroy (which unassigns the
 * box's tasks as it happens) is evidence the box is gone. Absence from this
 * hub's inventory is not — the box may live on another machine reporting to the
 * same store.
 *
 * Status is deliberately untouched: a half-finished task whose box went away is
 * still half-finished, and only a human (or the manager) decides otherwise.
 */
export function reconcileTasks(
  tasks: WorkTask[],
  ctx: ReconcileContext,
): { tasks: WorkTask[]; changed: boolean } {
  const jobById = new Map(ctx.jobs.map((j) => [j.id, j]));
  let changed = false;
  const out = tasks.map((t) => {
    if (t.boxJobId) {
      const job = jobById.get(t.boxJobId);
      if (job?.boxId) {
        changed = true;
        const next = { ...t, boxId: job.boxId };
        delete next.boxJobId;
        return next;
      }
      // A job the queue no longer has is NOT evidence the create failed: the
      // relay sweeps terminal manifests on a timer, so a box that came up fine
      // loses its manifest and would otherwise silently unassign its tasks.
      // Only an explicit failure clears the pointer; otherwise leave it, and let
      // the box-id branch below handle it once we learn the box.
      if (job && FAILED_JOB_STATUSES.has(job.status)) {
        changed = true;
        const next = { ...t };
        delete next.boxJobId;
        return next;
      }
      return t;
    }
    return t;
  });
  return { tasks: out, changed };
}

/**
 * Roll a box's tasks up for a list row. `current` is the task the box is on now
 * (lowest-order `in_progress`), else the next one it would pick up.
 */
export function taskSummaryForBox(
  tasks: WorkTask[],
  key: { boxId?: string; boxJobId?: string },
): BoxTaskSummary | undefined {
  const mine = sortTasksByOrder(
    tasks.filter((t) =>
      key.boxId !== undefined ? t.boxId === key.boxId : t.boxJobId === key.boxJobId,
    ),
  );
  if (mine.length === 0) return undefined;
  const done = mine.filter((t) => t.status === 'done').length;
  const current =
    mine.find((t) => t.status === 'in_progress') ?? mine.find((t) => t.status !== 'done');
  return {
    total: mine.length,
    done,
    current: current ? { id: current.id, title: current.title } : null,
  };
}

/**
 * Read a workspace's tasks with their assignments healed against reality.
 *
 * The correction is written back only when something actually moved, and the
 * whole read-modify-write runs under the tasks lock: this is the DASHBOARD POLL
 * path, so an unlocked write-back would race a concurrent `addTask` and drop the
 * task that was just created.
 */
export async function readReconciledTasks(
  wsId: string,
  ctx: ReconcileContext,
): Promise<WorkTask[]> {
  const current = await readTasks(wsId);
  if (current.length === 0) return current;
  // Cheap check first: the common case is "nothing moved", and taking a lock on
  // every poll of every workspace would serialize reads for no reason.
  if (!reconcileTasks(current, ctx).changed) return current;
  return updateTasks(wsId, (tasks) => {
    const { tasks: healed } = reconcileTasks(tasks, ctx);
    return { tasks: healed, result: healed };
  });
}
