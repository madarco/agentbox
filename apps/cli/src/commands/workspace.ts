/**
 * `agentbox workspace` — register and inspect workspaces: one or more projects
 * grouped together, owning a task list and its manager sessions.
 *
 * A thin client over the hub's `/api/v1/workspaces`, except the folder SCAN,
 * which runs here: the folders are on this machine, and the hub may be a control
 * box that has none of them. `preferLocal` throughout until routing moves.
 */
import { hostname } from 'node:os';
import { resolve } from 'node:path';
import { confirm, isCancel, log } from '@agentbox/cli-kit';
import { Command } from 'commander';
import { withHubClient } from '../control-plane/with-hub.js';
import { scanWorkspace } from '../lib/workspace-scan.js';
import { resolveWorkspace, WorkspaceRefError } from '../lib/workspace-ref.js';
import type { HubApiClient, HubApiWorkspace } from '../control-plane/hub-api-client.js';
import { renderTable } from '../lib/text-table.js';

interface GlobalOpts {
  json?: boolean;
}

/** Resolve a ref, printing the actionable message and exiting 2 when it fails. */
async function mustResolve(client: HubApiClient, ref?: string): Promise<HubApiWorkspace> {
  try {
    return await resolveWorkspace(client, ref);
  } catch (err) {
    if (err instanceof WorkspaceRefError) {
      log.error(err.message);
      process.exit(2);
    }
    throw err;
  }
}

function printWorkspace(ws: HubApiWorkspace): void {
  const here = ws.hosts[hostname()]?.root;
  log.info(`${ws.name}  (${ws.id})`);
  process.stdout.write(`  root      ${here ?? '(no folder on this machine)'}\n`);
  process.stdout.write(`  projects  ${String(ws.projects.length)}\n`);
  const elsewhere = Object.entries(ws.hosts).filter(([h]) => h !== hostname());
  for (const [host, m] of elsewhere) {
    process.stdout.write(`  on ${host}  ${m.root}\n`);
  }
  if (ws.taskCounts) {
    process.stdout.write(
      `  tasks     ${String(ws.taskCounts.open)} open, ${String(ws.taskCounts.done)} done\n`,
    );
  }
  if (ws.managers) {
    process.stdout.write(
      `  managers  ${String(ws.managers.running)} running, ${String(ws.managers.total)} total\n`,
    );
  }
}

const addCommand = new Command('add')
  .description('Register a folder as a workspace and discover the projects in it')
  .argument('[path]', 'folder to register (default: the current directory)')
  .option('--name <name>', 'display name (default: the folder basename)')
  .option('-j, --json', 'print the workspace as JSON')
  .action(async (path: string | undefined, opts: GlobalOpts & { name?: string }) => {
    await withHubClient({ preferLocal: true }, async (client) => {
      // The scan runs HERE: the hub records the folders under this machine's
      // hostname and never looks for them on its own disk.
      const scan = await scanWorkspace(resolve(path ?? process.cwd()));
      const ws = await client.addWorkspace({
        ...scan,
        ...(opts.name ? { name: opts.name } : {}),
      });
      if (opts.json) {
        process.stdout.write(JSON.stringify(ws, null, 2) + '\n');
        return;
      }
      printWorkspace(ws);
      if (scan.projects.length === 0) {
        log.warn('no projects found in this folder (looked for .git or agentbox.yaml, depth 1)');
      }
    });
  });

const listCommand = new Command('list')
  .alias('ls')
  .description('List registered workspaces')
  .option('-j, --json', 'print the listing as JSON')
  .action(async (opts: GlobalOpts) => {
    await withHubClient({ preferLocal: true }, async (client) => {
      const workspaces = await client.listWorkspaces();
      if (opts.json) {
        process.stdout.write(JSON.stringify(workspaces, null, 2) + '\n');
        return;
      }
      if (workspaces.length === 0) {
        log.info('no workspaces yet. Register one with `agentbox workspace add <path>`.');
        return;
      }
      renderTable(
        ['id', 'name', 'projects', 'tasks', 'managers', 'root'],
        workspaces.map((w) => [
          w.id,
          w.name,
          String(w.projects.length),
          w.taskCounts
            ? `${String(w.taskCounts.open)}/${String(w.taskCounts.open + w.taskCounts.done)}`
            : '-',
          w.managers ? `${String(w.managers.running)}/${String(w.managers.total)}` : '-',
          w.hosts[hostname()]?.root ?? '-',
        ]),
      );
    });
  });

const showCommand = new Command('show')
  .description('Show one workspace')
  .argument('[workspace]', 'workspace id or path (default: the one containing the cwd)')
  .option('-j, --json', 'print the workspace as JSON')
  .action(async (ref: string | undefined, opts: GlobalOpts) => {
    await withHubClient({ preferLocal: true }, async (client) => {
      const ws = await mustResolve(client, ref);
      if (opts.json) {
        process.stdout.write(JSON.stringify(ws, null, 2) + '\n');
        return;
      }
      printWorkspace(ws);
    });
  });

const rescanCommand = new Command('rescan')
  .description('Re-discover the projects in a workspace folder')
  .argument('[workspace]', 'workspace id or path (default: the one containing the cwd)')
  .action(async (ref: string | undefined) => {
    await withHubClient({ preferLocal: true }, async (client) => {
      const ws = await mustResolve(client, ref);
      const root = ws.hosts[hostname()]?.root;
      if (!root) {
        log.error(
          `${ws.name} has no folder on ${hostname()}; rescan it from the machine that has one.`,
        );
        process.exit(2);
      }
      // A rescan IS an add of the same folder, aimed at this record.
      printWorkspace(await client.addWorkspace({ ...(await scanWorkspace(root)), id: ws.id }));
    });
  });

const renameCommand = new Command('rename')
  .description('Rename a workspace')
  .argument('<name>', 'new display name')
  .option('-w, --workspace <ref>', 'workspace id or path (default: the one containing the cwd)')
  .action(async (name: string, opts: { workspace?: string }) => {
    await withHubClient({ preferLocal: true }, async (client) => {
      const ws = await mustResolve(client, opts.workspace);
      printWorkspace(await client.renameWorkspace(ws.id, name));
    });
  });

const removeCommand = new Command('remove')
  .alias('rm')
  .description('Unregister a workspace (the folder and its boxes are untouched)')
  .argument('[workspace]', 'workspace id or path (default: the one containing the cwd)')
  .option('-y, --yes', 'skip the confirmation')
  .option('--force', 'remove it even while one of its managers reads as running')
  .action(async (ref: string | undefined, opts: { yes?: boolean; force?: boolean }) => {
    await withHubClient({ preferLocal: true }, async (client) => {
      const ws = await mustResolve(client, ref);
      if (!opts.yes) {
        const open = ws.taskCounts?.open ?? 0;
        const answer = await confirm({
          message: `Unregister ${ws.name}${open > 0 ? ` and drop its ${String(open)} open task(s)` : ''}?`,
          initialValue: false,
        });
        if (isCancel(answer) || !answer) {
          log.info('cancelled.');
          return;
        }
      }
      await client.removeWorkspace(ws.id, { force: Boolean(opts.force) });
      log.success(`unregistered ${ws.name}`);
    });
  });

export const workspaceCommand = new Command('workspace')
  .alias('ws')
  .description('Workspaces: a folder grouping projects, with its own task list and manager')
  .addCommand(addCommand)
  .addCommand(listCommand)
  .addCommand(showCommand)
  .addCommand(rescanCommand)
  .addCommand(renameCommand)
  .addCommand(removeCommand);
