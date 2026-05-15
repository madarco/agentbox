import { log } from '@clack/prompts';
import { Command } from 'commander';
import {
  renderStatusTable,
  renderTaskTable,
  type ClaudeSessionStatus,
  type StatusReply,
} from '@agentbox/ctl';
import { execInBox } from '@agentbox/sandbox-docker';
import { resolveBoxOrExit } from '../box-ref.js';
import { handleLifecycleError } from './_errors.js';

interface StatusOptions {
  json?: boolean;
}

export const statusCommand = new Command('status')
  .description("Show service + task status from a box's agentbox-ctl daemon")
  .argument(
    '[box]',
    'box ref: project index, id, id prefix, name, or container (default: the only box in this project)',
  )
  .option('-j, --json', 'machine-readable JSON output')
  .action(async (idOrName: string | undefined, opts: StatusOptions) => {
    try {
      const box = await resolveBoxOrExit(idOrName);

      // Cross the docker boundary via `docker exec`: macOS hosts can see the
      // socket file in the bind mount but can't actually connect to it. The
      // daemon is reachable from the container itself, so we shell in.
      const proc = await execInBox(box.container, ['agentbox-ctl', 'status', '--json'], {
        user: 'vscode',
      });
      if (proc.exitCode !== 0) {
        log.error(`agentbox-ctl status failed: ${proc.stderr || proc.stdout}`);
        process.exit(1);
      }
      const reply = JSON.parse(proc.stdout) as StatusReply;
      const claude = await fetchClaudeSession(box.container);

      if (opts.json) {
        process.stdout.write(
          JSON.stringify({ ...reply, claudeSession: claude }, null, 2) + '\n',
        );
      } else {
        if (claude !== null) {
          process.stdout.write(`${renderClaudeLine(claude)}\n`);
        }
        if (reply.tasks.length > 0) {
          process.stdout.write('TASKS\n');
          process.stdout.write(renderTaskTable(reply.tasks) + '\n\n');
        }
        process.stdout.write('SERVICES\n');
        process.stdout.write(renderStatusTable(reply.services) + '\n');
      }
    } catch (err) {
      handleLifecycleError(err);
    }
  });

async function fetchClaudeSession(container: string): Promise<ClaudeSessionStatus | null> {
  const proc = await execInBox(container, ['agentbox-ctl', 'claude-session', '--json'], {
    user: 'vscode',
  });
  if (proc.exitCode !== 0) return null;
  try {
    return JSON.parse(proc.stdout) as ClaudeSessionStatus;
  } catch {
    return null;
  }
}

function renderClaudeLine(s: ClaudeSessionStatus): string {
  if (!s.running) return `claude session: not running ("${s.sessionName}")`;
  const since = s.startedAt ? ` since ${s.startedAt}` : '';
  return `claude session: running ("${s.sessionName}")${since}`;
}
