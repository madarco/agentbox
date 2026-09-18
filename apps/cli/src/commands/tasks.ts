/**
 * `agentbox tasks` — the workspace's units of work. Both the human and the
 * manager agent drive this surface; the manager reaches it with
 * `$AGENTBOX_WORKSPACE` already set inside its own session.
 *
 * Note: these are NOT the `tasks:` block in `agentbox.yaml` (setup commands the
 * in-box supervisor runs) — see `agentbox services` for those.
 */
import { confirm, isCancel, log } from '@agentbox/cli-kit';
import { Command } from 'commander';
import { withHubClient } from '../control-plane/with-hub.js';
import {
  resolveWorkspace,
  resolveWorkspaceAndManager,
  workspaceHub,
  WorkspaceRefError,
} from '../lib/workspace-ref.js';
import { detectHostSession } from '../lib/host-session.js';
import { renderTable } from '../lib/text-table.js';
import { parseTaskIds, TaskIdError } from '../lib/tasks-assign.js';
import type {
  HubApiClient,
  HubApiTask,
  HubApiTaskStatus,
  HubApiWorkspace,
} from '../control-plane/hub-api-client.js';

const STATUSES: readonly HubApiTaskStatus[] = ['todo', 'in_progress', 'blocked', 'done'];

interface WorkspaceOpt {
  workspace?: string;
}

async function mustResolve(client: HubApiClient, ref?: string): Promise<HubApiWorkspace> {
  return (
    await mustResolveWith(() => resolveWorkspace(client, ref).then((workspace) => ({ workspace })))
  ).workspace;
}

async function mustResolveWith<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof WorkspaceRefError) {
      log.error(err.message);
      process.exit(2);
    }
    throw err;
  }
}

function mustStatus(value: string | undefined): HubApiTaskStatus | undefined {
  if (value === undefined) return undefined;
  if (!(STATUSES as readonly string[]).includes(value)) {
    log.error(`unknown status "${value}" (expected ${STATUSES.join(', ')})`);
    process.exit(4);
  }
  return value as HubApiTaskStatus;
}

function mustIds(raw: string[]): string[] {
  try {
    return parseTaskIds(raw.join(','));
  } catch (err) {
    if (err instanceof TaskIdError) {
      log.error(err.message);
      process.exit(4);
    }
    throw err;
  }
}

/** Where a task is being worked, as one short cell. */
function whereOf(t: HubApiTask): string {
  if (t.boxId) return t.boxId;
  if (t.boxJobId) return `job:${t.boxJobId}`;
  return 'backlog';
}

function taskRows(tasks: HubApiTask[]): string[][] {
  return tasks.map((t) => [t.id, t.status, t.title, whereOf(t), t.projectId ?? '-']);
}

/** Group by box the way the manager plans: one section per box, backlog last. */
function renderByBox(tasks: HubApiTask[]): void {
  const groups = new Map<string, HubApiTask[]>();
  for (const t of tasks) {
    const key = whereOf(t);
    const list = groups.get(key);
    if (list) list.push(t);
    else groups.set(key, [t]);
  }
  const backlog = groups.get('backlog');
  groups.delete('backlog');
  for (const [box, list] of groups) {
    const done = list.filter((t) => t.status === 'done').length;
    process.stdout.write(`\n${box}  (${String(done)} / ${String(list.length)})\n`);
    renderTable(
      ['id', 'status', 'title', 'project'],
      list.map((t) => [t.id, t.status, t.title, t.projectId ?? '-']),
    );
  }
  if (backlog?.length) {
    process.stdout.write('\nBacklog\n');
    renderTable(
      ['id', 'status', 'title', 'project'],
      backlog.map((t) => [t.id, t.status, t.title, t.projectId ?? '-']),
    );
  }
}

const addCommand = new Command('add')
  .description('Add a task to the workspace backlog')
  .argument('<title...>', 'what the task is')
  .option('-w, --workspace <ref>', 'workspace id or path (default: the one containing the cwd)')
  .option('-d, --description <text>', 'longer description')
  .option('-p, --project <id>', 'scope the task to one project')
  .option('--depends-on <ids>', 'comma-separated task ids this one waits on')
  .option('--box <id>', 'assign it to a box right away')
  .option('--by-manager', 'record the manager agent as the author (default: human)')
  .option('--no-manager', 'do not attach the task to the current agent session')
  .option('--note <text>', 'why: recorded on the workspace timeline next to the task')
  .option('-j, --json', 'print the task as JSON')
  .action(
    async (
      title: string[],
      opts: WorkspaceOpt & {
        description?: string;
        project?: string;
        dependsOn?: string;
        box?: string;
        byManager?: boolean;
        manager?: boolean;
        note?: string;
        json?: boolean;
      },
    ) => {
      await withHubClient(workspaceHub(), async (client) => {
        // Inside a claude/codex session the task belongs to that session, and a
        // folder with no workspace gets one — registering the session creates it.
        const { workspace: ws, managerId } = await mustResolveWith(() =>
          resolveWorkspaceAndManager(client, opts.workspace, { register: opts.manager !== false }),
        );
        const task = await client.addTask(ws.id, {
          ...(managerId && opts.manager !== false ? { managerId } : {}),
          title: title.join(' '),
          ...(opts.description ? { description: opts.description } : {}),
          ...(opts.project ? { projectId: opts.project } : {}),
          ...(opts.dependsOn ? { dependsOn: mustIds([opts.dependsOn]) } : {}),
          ...(opts.box ? { boxId: opts.box } : {}),
          ...(opts.byManager ? { createdBy: 'manager' as const } : {}),
          ...(opts.note ? { note: opts.note } : {}),
        });
        if (opts.json) process.stdout.write(JSON.stringify(task, null, 2) + '\n');
        else log.success(`${task.id}  ${task.title}`);
      });
    },
  );

const listCommand = new Command('list')
  .alias('ls')
  .description('List the workspace tasks in priority order')
  .option('-w, --workspace <ref>', 'workspace id or path (default: the one containing the cwd)')
  .option('-p, --project <id>', 'only tasks scoped to this project')
  .option('--box <id>', 'only tasks assigned to this box')
  .option('--status <status>', `only this status (${STATUSES.join(' | ')})`)
  .option('--manager <id>', 'only tasks belonging to this manager')
  .option('--mine', 'only tasks belonging to the agent session running this command')
  .option('-a, --all', 'include done tasks (hidden by default)')
  .option('--by-box', 'group by box, the way the manager plans them')
  .option('-j, --json', 'print the listing as JSON')
  .action(
    async (
      opts: WorkspaceOpt & {
        project?: string;
        box?: string;
        status?: string;
        manager?: string;
        mine?: boolean;
        all?: boolean;
        byBox?: boolean;
        json?: boolean;
      },
    ) => {
      await withHubClient(workspaceHub(), async (client) => {
        const ws = await mustResolve(client, opts.workspace);
        const status = mustStatus(opts.status);
        let managerId = opts.manager;
        if (opts.mine) {
          const hint = detectHostSession();
          if (!hint) {
            log.error('--mine needs to run inside a claude or codex session');
            process.exit(2);
          }
          const mine = (await client.listManagers()).find(
            (m) => m.agent === hint.agent && m.sessionId === hint.sessionId,
          );
          if (!mine) {
            log.info('this session is not registered as a manager yet, so it has no tasks.');
            return;
          }
          managerId = mine.id;
        }
        const all = await client.listTasks(ws.id, {
          ...(managerId ? { managerId } : {}),
          ...(opts.project ? { projectId: opts.project } : {}),
          ...(opts.box ? { boxId: opts.box } : {}),
          ...(status ? { status } : {}),
        });
        // `--status done` is an explicit ask for finished work; `--all` is the
        // general one. Otherwise done tasks are noise in a working list.
        const tasks = opts.all || status === 'done' ? all : all.filter((t) => t.status !== 'done');
        if (opts.json) {
          process.stdout.write(JSON.stringify(tasks, null, 2) + '\n');
          return;
        }
        if (tasks.length === 0) {
          log.info(opts.all ? 'no tasks yet.' : 'no open tasks (-a to include done).');
          return;
        }
        if (opts.byBox) renderByBox(tasks);
        else renderTable(['id', 'status', 'title', 'where', 'project'], taskRows(tasks));
      });
    },
  );

const showCommand = new Command('show')
  .description('Show one task')
  .argument('<id>', 'task id (e.g. T-11)')
  .option('-w, --workspace <ref>', 'workspace id or path (default: the one containing the cwd)')
  .option('-j, --json', 'print the task as JSON')
  .action(async (id: string, opts: WorkspaceOpt & { json?: boolean }) => {
    await withHubClient(workspaceHub(), async (client) => {
      const ws = await mustResolve(client, opts.workspace);
      const task = await client.getTask(ws.id, mustIds([id])[0]!);
      if (opts.json) {
        process.stdout.write(JSON.stringify(task, null, 2) + '\n');
        return;
      }
      log.info(`${task.id}  ${task.title}`);
      process.stdout.write(`  status   ${task.status}\n`);
      process.stdout.write(`  where    ${whereOf(task)}\n`);
      process.stdout.write(`  project  ${task.projectId ?? '-'}\n`);
      if (task.managerId) process.stdout.write(`  manager  ${task.managerId}\n`);
      if (task.dependsOn?.length) process.stdout.write(`  after    ${task.dependsOn.join(', ')}\n`);
      if (task.description) process.stdout.write(`\n${task.description}\n`);
    });
  });

const updateCommand = new Command('update')
  .alias('edit')
  .description('Update a task')
  .argument('<id>', 'task id (e.g. T-11)')
  .option('-w, --workspace <ref>', 'workspace id or path (default: the one containing the cwd)')
  .option('--title <title>', 'new title')
  .option('-d, --description <text>', 'new description')
  .option('--status <status>', `new status (${STATUSES.join(' | ')})`)
  .option('-p, --project <id>', 'scope the task to this project')
  .option('--no-project', 'clear the project scope')
  .option('--depends-on <ids>', 'comma-separated task ids this one waits on ("" clears)')
  .option('--note <text>', 'why: recorded on the workspace timeline next to the change')
  .option('-j, --json', 'print the task as JSON')
  .action(
    async (
      id: string,
      opts: WorkspaceOpt & {
        title?: string;
        description?: string;
        status?: string;
        project?: string | boolean;
        dependsOn?: string;
        note?: string;
        json?: boolean;
      },
    ) => {
      await withHubClient(workspaceHub(), async (client) => {
        const ws = await mustResolve(client, opts.workspace);
        const status = mustStatus(opts.status);
        // commander turns `--no-project` into `project === false`.
        const clearProject = opts.project === false;
        const body = {
          ...(opts.title ? { title: opts.title } : {}),
          ...(opts.description !== undefined ? { description: opts.description } : {}),
          ...(status ? { status } : {}),
          ...(clearProject ? { projectId: null } : {}),
          ...(typeof opts.project === 'string' ? { projectId: opts.project } : {}),
          ...(opts.dependsOn !== undefined
            ? { dependsOn: opts.dependsOn === '' ? [] : mustIds([opts.dependsOn]) }
            : {}),
        };
        if (Object.keys(body).length === 0) {
          log.error(
            'nothing to update — pass at least one of --title, --description, --status, --project, --depends-on',
          );
          process.exit(4);
        }
        const task = await client.updateTask(ws.id, mustIds([id])[0]!, {
          ...body,
          ...(opts.note ? { note: opts.note } : {}),
        });
        if (opts.json) process.stdout.write(JSON.stringify(task, null, 2) + '\n');
        else log.success(`${task.id}  ${task.status}  ${task.title}`);
      });
    },
  );

const doneCommand = new Command('done')
  .description('Mark tasks finished')
  .argument('<ids...>', 'task ids (e.g. T-11 T-12)')
  .option('-w, --workspace <ref>', 'workspace id or path (default: the one containing the cwd)')
  .action(async (ids: string[], opts: WorkspaceOpt) => {
    await withHubClient(workspaceHub(), async (client) => {
      const ws = await mustResolve(client, opts.workspace);
      for (const id of mustIds(ids)) {
        const task = await client.completeTask(ws.id, id);
        log.success(`${task.id} done`);
      }
    });
  });

const assignCommand = new Command('assign')
  .description('Assign tasks to a box (or, with --box none, return them to the backlog)')
  .argument('<ids...>', 'task ids (e.g. T-11 T-12)')
  .requiredOption('--box <id>', 'box id, or "none" to unassign')
  .option('-w, --workspace <ref>', 'workspace id or path (default: the one containing the cwd)')
  .option('--note <text>', 'why: recorded on the workspace timeline next to the assignment')
  .action(async (ids: string[], opts: WorkspaceOpt & { box: string; note?: string }) => {
    await withHubClient(workspaceHub(), async (client) => {
      const ws = await mustResolve(client, opts.workspace);
      const taskIds = mustIds(ids);
      if (opts.box === 'none') {
        if (opts.note) log.warn('--note is not recorded when unassigning');
        for (const id of taskIds) await client.unassignTask(ws.id, id);
        log.success(`${taskIds.join(', ')} back in the backlog`);
        return;
      }
      await client.assignTasks(
        ws.id,
        taskIds,
        { boxId: opts.box },
        opts.note ? { note: opts.note } : {},
      );
      log.success(`${taskIds.join(', ')} -> ${opts.box}`);
    });
  });

const reorderCommand = new Command('reorder')
  .description('Set the whole priority order (list every task id)')
  .argument('<ids...>', 'every task id, in the order you want')
  .option('-w, --workspace <ref>', 'workspace id or path (default: the one containing the cwd)')
  .option('--note <text>', 'why the order changed: recorded on the workspace timeline')
  .action(async (ids: string[], opts: WorkspaceOpt & { note?: string }) => {
    await withHubClient(workspaceHub(), async (client) => {
      const ws = await mustResolve(client, opts.workspace);
      const tasks = await client.reorderTasks(
        ws.id,
        mustIds(ids),
        opts.note ? { note: opts.note } : {},
      );
      renderTable(['id', 'status', 'title', 'where', 'project'], taskRows(tasks));
    });
  });

const removeCommand = new Command('remove')
  .alias('rm')
  .description('Delete tasks')
  .argument('<ids...>', 'task ids (e.g. T-11 T-12)')
  .option('-w, --workspace <ref>', 'workspace id or path (default: the one containing the cwd)')
  .option('-y, --yes', 'skip the confirmation')
  .action(async (ids: string[], opts: WorkspaceOpt & { yes?: boolean }) => {
    await withHubClient(workspaceHub(), async (client) => {
      const ws = await mustResolve(client, opts.workspace);
      const taskIds = mustIds(ids);
      if (!opts.yes) {
        const answer = await confirm({
          message: `Delete ${taskIds.join(', ')} from ${ws.name}?`,
          initialValue: false,
        });
        if (isCancel(answer) || !answer) {
          log.info('cancelled.');
          return;
        }
      }
      for (const id of taskIds) await client.removeTask(ws.id, id);
      log.success(`deleted ${taskIds.join(', ')}`);
    });
  });

export const tasksCommand = new Command('tasks')
  .alias('task')
  .description('Workspace tasks: the units of work a manager groups into boxes')
  .addCommand(addCommand)
  .addCommand(listCommand)
  .addCommand(showCommand)
  .addCommand(updateCommand)
  .addCommand(doneCommand)
  .addCommand(assignCommand)
  .addCommand(reorderCommand)
  .addCommand(removeCommand);
