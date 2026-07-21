import { log } from '@clack/prompts';
import { Command } from 'commander';
import type { BoxStatus } from '@agentbox/ctl';
import { boxResourceStats, inspectBox, type InspectedBox } from '@agentbox/sandbox-docker';
import { setBoxDisplayName } from '@agentbox/sandbox-core';
import type { BoxResourceStats } from '@agentbox/core';
import { resolveBoxOrExit } from '../box-ref.js';
import { boxLabel } from '../box-label.js';
import { renderEndpointLines } from '../endpoints-render.js';
import { fmtAgo, fmtBytes, fmtPercent } from '../fmt.js';
import { withWatchOptions, watchRender, type WatchableOptions } from '../watch.js';
import { fetchLive, renderLiveSections, renderPersistedSections } from './_status-render.js';
import { runInspect } from './inspect.js';
import { handleLifecycleError } from './_errors.js';

interface StatusOptions extends WatchableOptions {
  json?: boolean;
  inspect?: boolean;
  setName?: string;
  clearName?: boolean;
}

// Cosmetic label cap — long enough for a friendly name, short enough to keep
// list/hub/tray rows tidy.
const MAX_DISPLAY_NAME = 60;

export const statusCommand = withWatchOptions(
  new Command('status')
    .description("Show service + task status from a box's agentbox-ctl daemon")
    .argument(
      '[box]',
      'box ref: project index, id, id prefix, name, or container (default: the only box in this project)',
    )
    .option('-j, --json', 'machine-readable JSON output')
    .option('--inspect', 'show detailed box info (volumes, limits, paths) plus service/task status')
    .option(
      '--set-name <name>',
      'rename the box: set a cosmetic display label (does not change the container, git branch, or URL)',
    )
    .option('--clear-name', 'clear the box display label, falling back to the original name'),
).action(async (idOrName: string | undefined, opts: StatusOptions) => {
  try {
    if (opts.json && opts.watch) {
      log.error('cannot combine --json with --watch');
      process.exit(2);
    }
    if (opts.setName !== undefined && opts.clearName) {
      log.error('cannot combine --set-name with --clear-name');
      process.exit(2);
    }
    const box = await resolveBoxOrExit(idOrName);

    // Rename is a quick state mutation, not a status pull — handle it and return
    // before any Docker/live probing. Works for every provider and box state.
    if (opts.setName !== undefined || opts.clearName) {
      if (opts.json || opts.watch) {
        log.error('cannot combine --set-name/--clear-name with --json or --watch');
        process.exit(2);
      }
      const before = boxLabel(box);
      let next: string | undefined;
      if (opts.clearName) {
        next = undefined;
      } else {
        // Strip control chars; commander guarantees a string for --set-name <name>.
        next = [...opts.setName!]
          .filter((c) => c >= ' ' && c.charCodeAt(0) !== 0x7f)
          .join('')
          .trim();
        if (!next) {
          log.error('--set-name requires a non-empty name (use --clear-name to reset)');
          process.exit(2);
        }
        if (next.length > MAX_DISPLAY_NAME) {
          log.error(`name too long (max ${String(MAX_DISPLAY_NAME)} chars)`);
          process.exit(2);
        }
      }
      await setBoxDisplayName(box.id, next);
      const after = next ?? box.name;
      process.stdout.write(`renamed ${before} -> ${after}\n`);
      return;
    }

    // Cloud boxes don't have a host Docker container to `docker exec` into for
    // a live status pull, and `inspectBox` is Docker-only. The persisted
    // box-status (mirrored by the host poller into ~/.agentbox/boxes/<id>/
    // status.json) carries the same service / task / ports info. Delegate to
    // the inspect renderer's cloud branch — it surfaces all of it.
    if ((box.provider ?? 'docker') !== 'docker') {
      await runInspect(box, { json: opts.json, watch: opts.watch, interval: opts.interval });
      return;
    }

    if (opts.inspect) {
      await runInspect(box, { json: opts.json, watch: opts.watch, interval: opts.interval });
      return;
    }

    if (opts.watch) {
      await watchRender(() => buildStatusText(box.id, box.container), opts.interval);
      return;
    }

    if (opts.json) {
      const inspected = await inspectBox(box.id);
      const live = await fetchLive(inspected.state, box.container);
      const resources = await boxResourceStats(inspected.record);
      process.stdout.write(
        JSON.stringify(
          {
            state: inspected.state,
            source: live ? 'live' : 'persisted',
            ...(live ?? {}),
            resources,
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

async function buildStatusText(id: string, container: string): Promise<string> {
  const inspected = await inspectBox(id);
  const { state, endpoints, persistedStatus } = inspected;
  const live = await fetchLive(state, container);

  const out: string[] = [];
  const epLines = renderEndpointLines(endpoints, process.stdout);
  if (epLines.length > 0) {
    out.push('ENDPOINTS', epLines.join('\n'), '');
  }
  out.push('RESOURCES', renderResources(await boxResourceStats(inspected.record)), '');
  out.push('CLAUDE', renderClaude(inspected, persistedStatus));
  out.push('', 'SHELLS', renderShells(inspected));

  if (live) {
    out.push('', ...renderLiveSections(live));
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

function renderResources(s: BoxResourceStats): string {
  const lim = (v: string | number | null | undefined): string =>
    v ? ` (limit ${typeof v === 'number' ? String(v) : v})` : '';
  const seg: string[] = [];
  if (s.live) {
    seg.push(`cpu ${fmtPercent(s.cpuPercent)}${lim(s.limits.cpus)}`);
    seg.push(
      `mem ${fmtBytes(s.memUsedBytes)} / ${fmtBytes(s.memLimitBytes)} ` +
        `(${fmtPercent(s.memPercent)})${lim(s.limits.memoryBytes ? fmtBytes(s.limits.memoryBytes) : null)}`,
    );
    seg.push(`pids ${s.pids === null ? '—' : String(s.pids)}${lim(s.limits.pidsLimit)}`);
  } else {
    seg.push('not running');
    if (s.limits.memoryBytes) seg.push(`mem limit ${fmtBytes(s.limits.memoryBytes)}`);
    if (s.limits.cpus) seg.push(`cpu limit ${String(s.limits.cpus)}`);
    if (s.limits.pidsLimit) seg.push(`pids limit ${String(s.limits.pidsLimit)}`);
  }
  seg.push(
    `disk ${fmtBytes(s.diskUsedBytes)}${s.limits.disk ? ` (limit ${s.limits.disk}, no-op on overlay2/macOS)` : ''}`,
  );
  if (s.snapshotDiskBytes !== null) seg.push(`snapshot ${fmtBytes(s.snapshotDiskBytes)}`);
  if (s.checkpointVolumeBytes !== null) seg.push(`ckpt ${fmtBytes(s.checkpointVolumeBytes)}`);
  let line = `  ${seg.join('  ')}`;
  for (const w of s.warnings) line += `\n  note: ${w}`;
  return line;
}

function renderClaude(i: InspectedBox, persisted: BoxStatus | null): string {
  const s = i.claudeSession;
  let session: string;
  if (s === null) {
    session = 'no session (box not running)';
  } else if (!s.running) {
    session = `no session ("${s.sessionName}")`;
  } else {
    const ago = fmtAgo(s.startedAt);
    session = `running ("${s.sessionName}")${ago ? `, started ${ago}` : ''}`;
  }
  const lines = [`  session   ${session}`];
  if (persisted) {
    const c = persisted.claude;
    const ago = fmtAgo(c.updatedAt);
    lines.push(`  activity  ${c.state}${ago ? ` (${ago})` : ''}`);
  }
  return lines.join('\n');
}

function renderShells(i: InspectedBox): string {
  if (i.state !== 'running') return '  (box not running)';
  if (i.shellSessions.length === 0) {
    return '  (none — start one with `agentbox shell`)';
  }
  return i.shellSessions
    .map((s) => `  ${s.label}  ${s.attached ? 'attached' : 'detached'}`)
    .join('\n');
}

function renderPersisted(s: BoxStatus, state: string): string {
  return [
    `(persisted snapshot from ${s.timestamp}; box is ${state})`,
    '',
    ...renderPersistedSections(s),
  ].join('\n');
}
