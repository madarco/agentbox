import { Command } from 'commander';
import {
  renderStatusTable,
  renderTaskTable,
  type BoxStatus,
  type StatusReply,
} from '@agentbox/ctl';
import { execInBox, inspectBox, type InspectedBox } from '@agentbox/sandbox-docker';
import { resolveBoxOrExit } from '../box-ref.js';
import { renderEndpointLines } from '../endpoints-render.js';
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
      const inspected = await inspectBox(box.id);
      const { state, endpoints, persistedStatus } = inspected;

      // Live path: only a running container is reachable via `docker exec`
      // (macOS can see the socket file but can't connect to it). When the box
      // is paused/stopped — or the exec fails — we fall back to the snapshot
      // the relay persisted to ~/.agentbox/boxes/<id>/status.json.
      let live: StatusReply | null = null;
      if (state === 'running') {
        const proc = await execInBox(box.container, ['agentbox-ctl', 'status', '--json'], {
          user: 'vscode',
        });
        if (proc.exitCode === 0) {
          try {
            live = JSON.parse(proc.stdout) as StatusReply;
          } catch {
            live = null;
          }
        }
      }

      if (opts.json) {
        process.stdout.write(
          JSON.stringify(
            {
              state,
              source: live ? 'live' : 'persisted',
              ...(live ?? {}),
              claudeSession: inspected.claudeSession,
              persisted: persistedStatus,
              endpoints,
            },
            null,
            2,
          ) + '\n',
        );
        return;
      }

      const epLines = renderEndpointLines(endpoints, process.stdout);
      if (epLines.length > 0) {
        process.stdout.write('ENDPOINTS\n');
        process.stdout.write(epLines.join('\n') + '\n\n');
      }
      process.stdout.write(renderClaudeLine(inspected, persistedStatus) + '\n');

      if (live) {
        if (live.tasks.length > 0) {
          process.stdout.write('TASKS\n');
          process.stdout.write(renderTaskTable(live.tasks) + '\n\n');
        }
        process.stdout.write('SERVICES\n');
        process.stdout.write(renderStatusTable(live.services) + '\n');
        return;
      }

      if (!persistedStatus) {
        process.stdout.write(
          `box is ${state}; no persisted status ` +
            `(box predates this feature, or the relay never received a snapshot)\n`,
        );
        return;
      }
      process.stdout.write(renderPersisted(persistedStatus, state) + '\n');
    } catch (err) {
      handleLifecycleError(err);
    }
  });

function renderClaudeLine(i: InspectedBox, persisted: BoxStatus | null): string {
  const s = i.claudeSession;
  const sessionLine =
    s === null
      ? `claude session: (n/a — box not running)`
      : s.running
        ? `claude session: running ("${s.sessionName}")${s.startedAt ? ` since ${s.startedAt}` : ''}`
        : `claude session: not running ("${s.sessionName}")`;
  if (!persisted) return sessionLine;
  const c = persisted.claude;
  const updated = c.updatedAt ? ` (updated ${c.updatedAt})` : '';
  return `${sessionLine}\nclaude activity: ${c.state}${updated}`;
}

function renderPersisted(s: BoxStatus, state: string): string {
  const out: string[] = [`(persisted snapshot from ${s.timestamp}; box is ${state})`, ''];
  if (s.tasks.length > 0) {
    out.push('TASKS');
    out.push(...s.tasks.map((t) => `  ${t.name}  ${t.state}`));
    out.push('');
  }
  out.push('SERVICES');
  if (s.services.length === 0) {
    out.push('  (none)');
  } else {
    out.push(
      ...s.services.map(
        (svc) => `  ${svc.name}  ${svc.state}${svc.port !== null ? `  :${String(svc.port)}` : ''}`,
      ),
    );
  }
  out.push('');
  out.push('PORTS');
  if (s.ports.length === 0) {
    out.push('  (none listening)');
  } else {
    out.push(
      ...s.ports.map((p) => `  :${String(p.port)}${p.service ? `  (${p.service})` : ''}`),
    );
  }
  return out.join('\n');
}
