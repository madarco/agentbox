import { log } from '@clack/prompts';
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
import { withWatchOptions, watchRender, type WatchableOptions } from '../watch.js';
import { handleLifecycleError } from './_errors.js';

interface StatusOptions extends WatchableOptions {
  json?: boolean;
}

export const statusCommand = withWatchOptions(
  new Command('status')
    .description("Show service + task status from a box's agentbox-ctl daemon")
    .argument(
      '[box]',
      'box ref: project index, id, id prefix, name, or container (default: the only box in this project)',
    )
    .option('-j, --json', 'machine-readable JSON output'),
).action(async (idOrName: string | undefined, opts: StatusOptions) => {
  try {
    if (opts.json && opts.watch) {
      log.error('cannot combine --json with --watch');
      process.exit(2);
    }
    const box = await resolveBoxOrExit(idOrName);

    if (opts.watch) {
      await watchRender(() => buildStatusText(box.id, box.container), opts.interval);
      return;
    }

    if (opts.json) {
      const inspected = await inspectBox(box.id);
      const live = await fetchLive(inspected.state, box.container);
      process.stdout.write(
        JSON.stringify(
          {
            state: inspected.state,
            source: live ? 'live' : 'persisted',
            ...(live ?? {}),
            claudeSession: inspected.claudeSession,
            persisted: inspected.persistedStatus,
            endpoints: inspected.endpoints,
          },
          null,
          2,
        ) + '\n',
      );
      return;
    }

    process.stdout.write((await buildStatusText(box.id, box.container)) + '\n');
  } catch (err) {
    handleLifecycleError(err);
  }
});

async function fetchLive(state: string, container: string): Promise<StatusReply | null> {
  // Only a running container is reachable via `docker exec` (macOS can see the
  // socket file but can't connect to it). Paused/stopped — or a failed exec —
  // falls back to the snapshot the relay persisted to disk.
  if (state !== 'running') return null;
  const proc = await execInBox(container, ['agentbox-ctl', 'status', '--json'], {
    user: 'vscode',
  });
  if (proc.exitCode !== 0) return null;
  try {
    return JSON.parse(proc.stdout) as StatusReply;
  } catch {
    return null;
  }
}

async function buildStatusText(id: string, container: string): Promise<string> {
  const inspected = await inspectBox(id);
  const { state, endpoints, persistedStatus } = inspected;
  const live = await fetchLive(state, container);

  const out: string[] = [];
  const epLines = renderEndpointLines(endpoints, process.stdout);
  if (epLines.length > 0) {
    out.push('ENDPOINTS', epLines.join('\n'), '');
  }
  out.push(renderClaudeLine(inspected, persistedStatus));

  if (live) {
    if (live.tasks.length > 0) {
      out.push('', 'TASKS', renderTaskTable(live.tasks));
    }
    out.push('', 'SERVICES', renderStatusTable(live.services));
    return out.join('\n');
  }

  if (!persistedStatus) {
    out.push(
      '',
      `box is ${state}; no persisted status ` +
        `(box predates this feature, or the relay never received a snapshot)`,
    );
    return out.join('\n');
  }
  out.push('', renderPersisted(persistedStatus, state));
  return out.join('\n');
}

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
    out.push(...s.ports.map((p) => `  :${String(p.port)}${p.service ? `  (${p.service})` : ''}`));
  }
  return out.join('\n');
}
