import { spawn } from 'node:child_process';
import { log } from '@clack/prompts';
import { Command } from 'commander';
import type { StatusReply, WaitReadyReply } from '@agentbox/ctl';
import {
  AmbiguousBoxError,
  attachedContainerUri,
  BoxNotFoundError,
  ensureAgentboxTasksFile,
  execInBox,
  findBox,
  inspectBox,
  readState,
  startBox,
  unpauseBox,
} from '@agentbox/sandbox-docker';
import { handleLifecycleError } from './_errors.js';

interface CodeOptions {
  noWait?: boolean;
  timeout: string;
  noAutoTerminals?: boolean;
  regenTasks?: boolean;
  print?: boolean;
}

export const codeCommand = new Command('code')
  .description('Open a box in VS Code Desktop via the Dev Containers extension')
  .argument('<box>', 'box id, id prefix, name, or container name')
  .option('--no-wait', "don't block on agentbox-ctl wait-ready before opening")
  .option('--timeout <ms>', 'wait-ready timeout in milliseconds', '120000')
  .option('--no-auto-terminals', "don't generate /workspace/.vscode/tasks.json")
  .option('--regen-tasks', 'overwrite a user-owned tasks.json (skips sentinel check)', false)
  .option(
    '--print',
    'print the vscode:// URL instead of launching `open` (still refreshes/waits)',
  )
  .action(async (idOrName: string, opts: CodeOptions) => {
    try {
      const state = await readState();
      const result = findBox(idOrName, state);
      if (result.kind === 'none') throw new BoxNotFoundError(idOrName);
      if (result.kind === 'ambiguous') throw new AmbiguousBoxError(idOrName, result.matches);
      const box = result.box;

      // Bring the box online if it isn't already.
      const insp = await inspectBox(box.id);
      if (insp.state === 'paused') {
        log.info(`box is paused; unpausing`);
        await unpauseBox(box.id);
      } else if (insp.state === 'stopped') {
        log.info(`box is stopped; starting (remounting overlay)`);
        await startBox(box.id);
      } else if (insp.state === 'missing') {
        throw new Error(`box ${box.name} has no container; was it destroyed?`);
      }

      // Wait for tasks + autostart services to be ready (unless --no-wait).
      if (!opts.noWait) {
        const reply = await runWaitReady(box.container, opts.timeout);
        if (!reply.ready) {
          const lines: string[] = [];
          if (reply.timedOut.length > 0) lines.push(`timed out: ${reply.timedOut.join(', ')}`);
          if (reply.failed.length > 0) lines.push(`failed: ${reply.failed.join(', ')}`);
          log.warn(`box not fully ready (${lines.join('; ')}). Opening anyway.`);
        } else {
          log.success('all units ready');
        }
      }

      // Inject .vscode/tasks.json so VS Code auto-opens terminal panels.
      if (!opts.noAutoTerminals) {
        try {
          const services = await fetchServiceNames(box.container);
          const r = await ensureAgentboxTasksFile(box.container, services, {
            regen: opts.regenTasks,
          });
          if (r.status === 'wrote') {
            log.info(`wrote /workspace/.vscode/tasks.json (${String(services.length)} service(s))`);
          } else if (r.status === 'skipped-user-owned') {
            log.warn(
              'user-owned .vscode/tasks.json detected; skipping auto-terminals (pass --regen-tasks to overwrite)',
            );
          }
        } catch (err) {
          // Don't fail the open command if tasks.json injection has issues.
          log.warn(
            `auto-terminals failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      const url = attachedContainerUri(box.container, '/workspace');
      if (opts.print) {
        process.stdout.write(url + '\n');
        return;
      }
      const code = await spawnOpen(url);
      if (code !== 0) {
        log.error(`failed to launch VS Code (exit ${String(code)})`);
        process.stdout.write(url + '\n');
        process.exit(1);
      }
      log.success(`opening ${box.container} in VS Code`);
    } catch (err) {
      handleLifecycleError(err);
    }
  });

async function runWaitReady(container: string, timeoutMs: string): Promise<WaitReadyReply> {
  const proc = await execInBox(
    container,
    ['agentbox-ctl', 'wait-ready', '--json', '--timeout', timeoutMs],
    { user: 'vscode' },
  );
  // wait-ready exits 0 on ready / 1 on not-ready; both write JSON.
  try {
    return JSON.parse(proc.stdout) as WaitReadyReply;
  } catch {
    throw new Error(
      `agentbox-ctl wait-ready returned unparseable output: ${proc.stderr || proc.stdout}`,
    );
  }
}

function spawnOpen(url: string): Promise<number> {
  // macOS `open` dispatches the vscode:// URL handler. Linux fallback (xdg-open)
  // can be added later when remote providers land.
  return new Promise((resolve) => {
    const child = spawn('open', [url], { stdio: 'ignore' });
    child.once('error', () => resolve(127));
    child.once('exit', (code) => resolve(code ?? -1));
  });
}

async function fetchServiceNames(container: string): Promise<{ name: string }[]> {
  const proc = await execInBox(container, ['agentbox-ctl', 'status', '--json'], {
    user: 'vscode',
  });
  if (proc.exitCode !== 0) return [];
  try {
    const reply = JSON.parse(proc.stdout) as StatusReply;
    return reply.services.map((s) => ({ name: s.name }));
  } catch {
    return [];
  }
}
