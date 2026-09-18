// The workspace domain: workspaces and their tasks (managers are their own
// slice, `managers.ts`). Everything here reaches state through @agentbox/relay's
// workspace store; nothing here knows about providers, containers or git.
import { hostname as osHostname } from 'node:os';
import { isAbsolute } from 'node:path';
import {
  addTask,
  addWorkspace,
  assignTasks,
  detachBoxFromManagers,
  filterTasks,
  findManager,
  listWorkspaces,
  managerStatus,
  patchTask,
  readManagers,
  readReconciledTasks,
  readTasks,
  timelineSink,
  readWorkspace,
  removeTask,
  removeWorkspace,
  renameWorkspace,
  reorderTasks,
  setTaskDone,
  stampFields,
  taskSummaryForBox,
  toWorkspaceView,
  unassignTasks,
  workspaceProjectIds,
  type AddWorkspaceInput,
  type BoxTaskSummary,
  type ManagerProbe,
  type ReconcileContext,
  type TimelineEventInput,
  type TimelineNoteKind,
  type Workspace,
  type WorkTask,
} from '@agentbox/relay';
import { inBackground } from './background';
import { reconcileContext as fleetContext, type BackendDeps } from './deps';
import type {
  ActionResult,
  AddTaskInput,
  AssignTarget,
  TaskFilter,
  TaskResult,
  TasksResult,
  TimelineMeta,
  UpdateTaskInput,
  WorkspaceBackend,
  WorkspaceResult,
} from '../boxes/backend-types';
import type { WorkspaceView } from '../boxes/types';

function err(message: string): { ok: false; error: string } {
  return { ok: false, error: message };
}

function unknownWorkspace(id: string): { ok: false; error: string } {
  return err(`unknown workspace ${id}`);
}

export function createWorkspaceBackend(deps: BackendDeps): WorkspaceBackend {
  const reconcileContext = (): Promise<ReconcileContext> => fleetContext(deps);
  const probe: ManagerProbe = {
    ...(deps.managerExec ? { exec: deps.managerExec } : {}),
    ...(deps.hostname ? { hostname: deps.hostname } : {}),
    ...(deps.isPidAlive ? { isPidAlive: deps.isPidAlive } : {}),
    ...(deps.processStartTime ? { processStartTime: deps.processStartTime } : {}),
  };

  /** How many of a workspace's managers are running right now. */
  async function managerCounts(wsId: string): Promise<{ running: number; total: number }> {
    const managers = await readManagers(wsId);
    const statuses = await Promise.all(managers.map((m) => managerStatus(m, probe)));
    return { running: statuses.filter((s) => s === 'running').length, total: managers.length };
  }

  /**
   * A workspace's tasks with their assignments healed against reality. The
   * write-back is locked and change-gated inside the store — this is the poll
   * path, and racing a concurrent `addTask` would drop the new task.
   */
  async function tasksOf(wsId: string, ctx?: ReconcileContext): Promise<WorkTask[]> {
    return readReconciledTasks(wsId, ctx ?? (await reconcileContext()));
  }

  /** Workspace + the derived counts a list row shows. */
  async function viewOf(
    rec: Awaited<ReturnType<typeof readWorkspace>>,
    ctx?: ReconcileContext,
  ): Promise<WorkspaceView | null> {
    if (!rec) return null;
    const [tasks, managers] = await Promise.all([tasksOf(rec.id, ctx), managerCounts(rec.id)]);
    const base: Workspace = toWorkspaceView(rec, (deps.hostname ?? osHostname)());
    return {
      ...base,
      taskCounts: {
        open: tasks.filter((t) => t.status !== 'done').length,
        done: tasks.filter((t) => t.status === 'done').length,
      },
      managers,
    };
  }

  /**
   * A task's manager must be one of its own workspace's: a manager from another
   * workspace would list tasks it can never see in its folder.
   */
  async function managerRefusal(wsId: string, managerId: string | null | undefined) {
    if (!managerId) return null;
    const rec = await findManager(managerId);
    if (!rec) return `unknown manager ${managerId}`;
    if (rec.workspaceId !== wsId) {
      return `manager ${managerId} belongs to workspace ${rec.workspaceId}, not ${wsId}`;
    }
    return null;
  }

  /**
   * Log a task event. Awaited before `notify()` so a client refetching on the
   * change event already sees it; best-effort inside the store, so a log failure
   * never fails the mutation that already happened.
   */
  async function record(wsId: string, input: TimelineEventInput): Promise<void> {
    await timelineSink().record(wsId, input);
  }

  /** The note a mutation carried, as its own event right after the mutation's. */
  async function recordNote(
    wsId: string,
    meta: TimelineMeta | undefined,
    taskIds: string[],
    kind: TimelineNoteKind = 'note',
  ): Promise<void> {
    if (!meta?.note) return;
    await record(wsId, {
      type: 'manager.note',
      ...stampFields(meta.stamp),
      text: meta.note,
      noteKind: kind,
      ...(taskIds.length ? { taskIds } : {}),
    });
  }

  async function taskBefore(wsId: string, taskId: string): Promise<WorkTask | undefined> {
    return (await readTasks(wsId).catch(() => [])).find((t) => t.id === taskId);
  }

  /** Unassign, log it, and fan out — shared by the route and by a box's destroy. */
  async function dropAssignment(
    wsId: string,
    ids: string[],
    meta?: TimelineMeta,
  ): Promise<WorkTask[]> {
    const tasks = await unassignTasks(wsId, ids);
    await record(wsId, {
      type: 'task.unassigned',
      ...stampFields(meta?.stamp),
      taskIds: tasks.map((t) => t.id),
      ...(tasks.length === 1 ? { task: { id: tasks[0]!.id, title: tasks[0]!.title } } : {}),
    });
    deps.notify();
    return tasks;
  }

  /** A box id must exist; a job id must be a create job that has not failed. */
  async function validateTarget(target: AssignTarget): Promise<string | null> {
    if ('boxId' in target) {
      const live = await deps.liveBoxIds();
      return live.has(target.boxId) ? null : `unknown box ${target.boxId}`;
    }
    const job = (await deps.jobs()).find((j) => j.id === target.boxJobId);
    if (!job) return `unknown job ${target.boxJobId}`;
    if (job.kind === 'prepare') return `job ${target.boxJobId} is an image bake, not a box create`;
    return null;
  }

  return {
    async listWorkspaces(): Promise<WorkspaceView[]> {
      const recs = await listWorkspaces();
      if (recs.length === 0) return [];
      const ctx = await reconcileContext();
      const views = await Promise.all(recs.map((r) => viewOf(r, ctx)));
      return views.filter((v): v is WorkspaceView => v !== null);
    },

    async getWorkspace(id: string): Promise<WorkspaceView | null> {
      return viewOf(await readWorkspace(id));
    },

    /**
     * The folders are on the CLIENT's machine, not necessarily this hub's: the
     * scan runs there and arrives as facts. Nothing here stats a path — a
     * control box holds no checkout of the repos it owns boxes for.
     */
    async addWorkspace(input: AddWorkspaceInput): Promise<WorkspaceResult> {
      if (!isAbsolute(input.root)) return err('an absolute path is required');
      const bad = input.projects.find((p) => !isAbsolute(p.path));
      if (bad) return err(`project paths must be absolute: ${bad.path}`);
      try {
        const rec = await addWorkspace(input);
        deps.notify();
        const view = await viewOf(rec);
        return view ? { ok: true, workspace: view } : err('workspace was not written');
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },

    async renameWorkspace(id: string, name: string): Promise<WorkspaceResult> {
      const rec = await renameWorkspace(id, name);
      if (!rec) return unknownWorkspace(id);
      deps.notify();
      const view = await viewOf(rec);
      return view ? { ok: true, workspace: view } : unknownWorkspace(id);
    },

    async removeWorkspace(id: string, opts: { force?: boolean } = {}): Promise<ActionResult> {
      const rec = await readWorkspace(id);
      if (!rec) return unknownWorkspace(id);
      // A live manager is a running process in that folder: unregistering under
      // it would drop the only record pointing at that session and its boxes.
      if (!opts.force && (await managerCounts(id)).running > 0) {
        return err(
          'a manager of this workspace is running; stop it before removing the workspace (or force it)',
        );
      }
      await removeWorkspace(id);
      deps.notify();
      return { ok: true };
    },

    async listTasks(wsId: string, filter?: TaskFilter): Promise<WorkTask[] | null> {
      if (!(await readWorkspace(wsId))) return null;
      return filterTasks(await tasksOf(wsId), filter);
    },

    async listAllTasks(filter?: TaskFilter & { workspaceId?: string }): Promise<WorkTask[]> {
      const recs = await listWorkspaces();
      const wanted = filter?.workspaceId ? recs.filter((r) => r.id === filter.workspaceId) : recs;
      if (wanted.length === 0) return [];
      const ctx = await reconcileContext();
      const lists = await Promise.all(
        wanted.map(async (r) => filterTasks(await tasksOf(r.id, ctx), filter)),
      );
      return lists.flat();
    },

    async getTask(wsId: string, taskId: string): Promise<WorkTask | null> {
      return (await tasksOf(wsId)).find((t) => t.id === taskId) ?? null;
    },

    async addTask(wsId: string, input: AddTaskInput, meta?: TimelineMeta): Promise<TaskResult> {
      if (!(await readWorkspace(wsId))) return unknownWorkspace(wsId);
      const wrongManager = await managerRefusal(wsId, input.managerId);
      if (wrongManager) return { ok: false, error: wrongManager, invalid: true };
      if (input.boxId || input.boxJobId) {
        const bad = await validateTarget(
          input.boxId ? { boxId: input.boxId } : { boxJobId: input.boxJobId! },
        );
        if (bad) return err(bad);
      }
      try {
        const task = await addTask(wsId, input);
        await record(wsId, {
          type: 'task.created',
          ...stampFields(meta?.stamp),
          ...(!meta?.stamp?.managerId && task.managerId ? { managerId: task.managerId } : {}),
          task: { id: task.id, title: task.title, to: task.status },
          taskIds: [task.id],
          ...(task.projectId ? { projectId: task.projectId } : {}),
          ...(task.boxId ? { boxId: task.boxId } : {}),
        });
        await recordNote(wsId, meta, [task.id]);
        deps.notify();
        return { ok: true, task };
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },

    async updateTask(
      wsId: string,
      taskId: string,
      patch: UpdateTaskInput,
      meta?: TimelineMeta,
    ): Promise<TaskResult> {
      if (!(await readWorkspace(wsId))) return unknownWorkspace(wsId);
      const wrongManager = await managerRefusal(wsId, patch.managerId);
      if (wrongManager) return { ok: false, error: wrongManager, invalid: true };
      try {
        const prev = await taskBefore(wsId, taskId);
        const task = await patchTask(wsId, taskId, patch);
        if (!task) return err(`unknown task ${taskId}`);
        if (prev && prev.status !== task.status) {
          await record(wsId, {
            type: 'task.status',
            ...stampFields(meta?.stamp),
            task: { id: task.id, title: task.title, from: prev.status, to: task.status },
            taskIds: [task.id],
            ...(task.boxId ? { boxId: task.boxId } : {}),
          });
        }
        await recordNote(wsId, meta, [task.id]);
        deps.notify();
        return { ok: true, task };
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },

    async completeTask(wsId: string, taskId: string, meta?: TimelineMeta): Promise<TaskResult> {
      if (!(await readWorkspace(wsId))) return unknownWorkspace(wsId);
      const prev = await taskBefore(wsId, taskId);
      const task = await setTaskDone(wsId, taskId);
      if (!task) return err(`unknown task ${taskId}`);
      if (prev && prev.status !== 'done') {
        await record(wsId, {
          type: 'task.status',
          ...stampFields(meta?.stamp),
          task: { id: task.id, title: task.title, from: prev.status, to: 'done' },
          taskIds: [task.id],
          ...(task.boxId ? { boxId: task.boxId } : {}),
        });
      }
      deps.notify();
      return { ok: true, task };
    },

    async removeTask(wsId: string, taskId: string, meta?: TimelineMeta): Promise<ActionResult> {
      if (!(await readWorkspace(wsId))) return unknownWorkspace(wsId);
      const prev = await taskBefore(wsId, taskId);
      if (!(await removeTask(wsId, taskId))) return err(`unknown task ${taskId}`);
      await record(wsId, {
        type: 'task.removed',
        ...stampFields(meta?.stamp),
        task: { id: taskId, title: prev?.title ?? taskId, ...(prev ? { from: prev.status } : {}) },
        taskIds: [taskId],
      });
      deps.notify();
      return { ok: true };
    },

    async assignTasks(
      wsId: string,
      ids: string[],
      target: AssignTarget,
      meta?: TimelineMeta,
    ): Promise<TasksResult> {
      if (!(await readWorkspace(wsId))) return unknownWorkspace(wsId);
      const bad = await validateTarget(target);
      if (bad) return err(bad);
      try {
        const tasks = await assignTasks(wsId, ids, target);
        deps.notify();
        // Naming the box probes its state, so the event is written after the answer.
        inBackground(async () => {
          const box =
            'boxId' in target && deps.boxFact
              ? await deps.boxFact(target.boxId, { withState: true }).catch(() => undefined)
              : undefined;
          await record(wsId, {
            type: 'task.assigned',
            ...stampFields(meta?.stamp),
            taskIds: tasks.map((t) => t.id),
            ...(tasks.length === 1 ? { task: { id: tasks[0]!.id, title: tasks[0]!.title } } : {}),
            ...('boxId' in target ? { boxId: target.boxId } : {}),
            ...(box ? { boxName: box.name } : {}),
            ...(box?.agent ? { agent: box.agent } : {}),
            ...(box?.branches[0] ? { branch: box.branches[0] } : {}),
            // "Gave more work to a running box" rather than "planned into a new one".
            boxRunning: box?.state === 'running',
          });
          await recordNote(wsId, meta, ids);
          deps.notify();
        });
        return { ok: true, tasks };
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },

    async unassignTasks(wsId: string, ids: string[], meta?: TimelineMeta): Promise<TasksResult> {
      if (!(await readWorkspace(wsId))) return unknownWorkspace(wsId);
      try {
        return { ok: true, tasks: await dropAssignment(wsId, ids, meta) };
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },

    /**
     * The box is gone: its tasks go back to the backlog and no manager still
     * claims it. Reconciliation cannot do this from a box listing any more — a
     * box absent from THIS hub's inventory may simply live on another machine —
     * so destroy and prune, the two events that KNOW, say it explicitly.
     */
    async boxGone(boxId: string): Promise<void> {
      for (const ws of await listWorkspaces()) {
        const ids = (await readTasks(ws.id).catch(() => []))
          .filter((t) => t.boxId === boxId)
          .map((t) => t.id);
        if (ids.length) await dropAssignment(ws.id, ids);
        await detachBoxFromManagers(ws.id, boxId).catch(() => {});
      }
    },

    async reorderTasks(wsId: string, ids: string[], meta?: TimelineMeta): Promise<TasksResult> {
      if (!(await readWorkspace(wsId))) return unknownWorkspace(wsId);
      try {
        const tasks = await reorderTasks(wsId, ids);
        // An order change alone is not news; the reason for it is.
        await recordNote(wsId, meta, ids, 'replan');
        deps.notify();
        return { ok: true, tasks };
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },

    // ── hooks getData() calls, so the dashboard read stays in one place ──

    async workspaceIdByProject(): Promise<Map<string, string>> {
      const out = new Map<string, string>();
      const host = (deps.hostname ?? osHostname)();
      for (const ws of await listWorkspaces()) {
        for (const pid of workspaceProjectIds(ws, host)) out.set(pid, ws.id);
      }
      return out;
    },

    async taskSummaries(): Promise<{
      byBox: Map<string, BoxTaskSummary>;
      byJob: Map<string, BoxTaskSummary>;
    }> {
      const byBox = new Map<string, BoxTaskSummary>();
      const byJob = new Map<string, BoxTaskSummary>();
      const recs = await listWorkspaces();
      if (recs.length === 0) return { byBox, byJob };
      const ctx = await reconcileContext();
      for (const ws of recs) {
        const tasks = await tasksOf(ws.id, ctx);
        for (const boxId of new Set(
          tasks.map((t) => t.boxId).filter((b): b is string => Boolean(b)),
        )) {
          const summary = taskSummaryForBox(tasks, { boxId });
          if (summary) byBox.set(boxId, summary);
        }
        for (const jobId of new Set(
          tasks.map((t) => t.boxJobId).filter((b): b is string => Boolean(b)),
        )) {
          const summary = taskSummaryForBox(tasks, { boxJobId: jobId });
          if (summary) byJob.set(jobId, summary);
        }
      }
      return { byBox, byJob };
    },
  };
}
