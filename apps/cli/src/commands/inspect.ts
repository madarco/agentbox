import { log } from '@clack/prompts';
import { inspectBox, type InspectedBox } from '@agentbox/sandbox-docker';
import { Command } from 'commander';
import { resolveBoxOrExit } from '../box-ref.js';
import { renderEndpointLines } from '../endpoints-render.js';
import { withWatchOptions, watchRender, type WatchableOptions } from '../watch.js';
import { handleLifecycleError } from './_errors.js';

interface InspectOptions extends WatchableOptions {
  json?: boolean;
}

function fmtBytes(n: number | null): string {
  if (n === null) return 'n/a';
  if (n < 1024) return `${String(n)} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
}

function renderText(i: InspectedBox): string {
  const upperHost = i.hostPaths.upperLiveOnHost
    ? `${i.hostPaths.upperLiveOnHost}  (live)`
    : `${i.hostPaths.upperExport}  (run \`agentbox open --upper\` to refresh)`;
  const lines: string[] = [
    `id            ${i.record.id}`,
    `name          ${i.record.name}`,
    `container     ${i.record.container}`,
    `image         ${i.record.image}`,
    `state         ${i.state}`,
    `overlay       ${i.overlayMounted ? 'mounted at /workspace' : 'not mounted'}`,
    `workspace     ${i.record.workspacePath}`,
    `project       ${i.record.projectRoot ?? '(unset — pre-feature box)'}`,
    `n             ${typeof i.record.projectIndex === 'number' ? String(i.record.projectIndex) : '(none)'}`,
    `lower         ${i.record.lowerPath}`,
    `upper volume  ${i.upperVolume.name}${i.upperVolume.mountpoint ? `  (${i.upperVolume.mountpoint})` : ''}`,
    `node_modules  ${i.record.nodeModulesVolume}`,
    `claude config ${i.record.claudeConfigVolume ?? '(none)'}`,
    `claude session ${renderClaudeSession(i)}`,
    `claude activity ${renderClaudeActivity(i)}`,
    `persisted     ${renderPersisted(i)}`,
    `playwright    ${i.record.withPlaywright ? 'yes' : 'no'}`,
    'endpoints',
    ...renderEndpoints(i),
    `snapshot dir  ${i.record.snapshotDir ?? '(none — live workspace mount)'}`,
    `snapshot size ${fmtBytes(i.snapshotSizeBytes)}`,
    `host export   ${i.hostPaths.mergedExport}  (run \`agentbox open\` to refresh)`,
    `upper host    ${upperHost}`,
    `created       ${i.record.createdAt}`,
  ];
  return lines.join('\n');
}

function renderClaudeSession(i: InspectedBox): string {
  if (i.claudeSession === null) return '(n/a — box not running)';
  if (!i.claudeSession.running) return `not running ("${i.claudeSession.sessionName}")`;
  const since = i.claudeSession.startedAt ? ` since ${i.claudeSession.startedAt}` : '';
  return `running ("${i.claudeSession.sessionName}")${since}`;
}

function renderClaudeActivity(i: InspectedBox): string {
  const c = i.persistedStatus?.claude;
  if (!c) return '(none)';
  return `${c.state}${c.updatedAt ? ` (updated ${c.updatedAt})` : ''}`;
}

function renderPersisted(i: InspectedBox): string {
  const s = i.persistedStatus;
  if (!s) return '(none)';
  return (
    `${s.timestamp} ` +
    `(${String(s.services.length)} svc, ${String(s.tasks.length)} tasks, ${String(s.ports.length)} ports)`
  );
}

function renderEndpoints(i: InspectedBox): string[] {
  const lines = renderEndpointLines(i.endpoints, process.stdout);
  return lines.length > 0 ? lines : ['  (none)'];
}

export const inspectCommand = withWatchOptions(
  new Command('inspect')
    .description('Show detailed information about a single box')
    .argument(
      '[box]',
      'box ref: project index, id, id prefix, name, or container (default: the only box in this project)',
    )
    .option('-j, --json', 'machine-readable JSON output'),
).action(async (idOrName: string | undefined, opts: InspectOptions) => {
  try {
    if (opts.json && opts.watch) {
      log.error('cannot combine --json with --watch');
      process.exit(2);
    }
    const box = await resolveBoxOrExit(idOrName);
    if (opts.watch) {
      await watchRender(async () => renderText(await inspectBox(box.id)), opts.interval);
      return;
    }
    const result = await inspectBox(box.id);
    if (opts.json) {
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    } else {
      process.stdout.write(renderText(result) + '\n');
    }
  } catch (err) {
    handleLifecycleError(err);
  }
});
