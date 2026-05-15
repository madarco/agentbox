import { inspectBox, type InspectedBox } from '@agentbox/sandbox-docker';
import { Command } from 'commander';
import { handleLifecycleError } from './_errors.js';

interface InspectOptions {
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
    `lower         ${i.record.lowerPath}`,
    `upper volume  ${i.upperVolume.name}${i.upperVolume.mountpoint ? `  (${i.upperVolume.mountpoint})` : ''}`,
    `node_modules  ${i.record.nodeModulesVolume}`,
    `claude config ${i.record.claudeConfigVolume ?? '(none)'}`,
    `claude session ${renderClaudeSession(i)}`,
    `playwright    ${i.record.withPlaywright ? 'yes' : 'no'}`,
    ...renderVnc(i),
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

function renderVnc(i: InspectedBox): string[] {
  if (!i.record.vncEnabled) return [`vnc           off`];
  const lines: string[] = [];
  if (i.vnc.orbUrl) lines.push(`vnc           ${i.vnc.orbUrl}`);
  if (i.vnc.loopbackUrl) {
    lines.push(`${i.vnc.orbUrl ? 'vnc (loopback) ' : 'vnc           '}${i.vnc.loopbackUrl}`);
  }
  if (lines.length === 0) lines.push(`vnc           enabled (URL unavailable — daemon may not be up)`);
  return lines;
}

export const inspectCommand = new Command('inspect')
  .description('Show detailed information about a single box')
  .argument('<box>', 'box id, id prefix, name, or container name')
  .option('-j, --json', 'machine-readable JSON output')
  .action(async (idOrName: string, opts: InspectOptions) => {
    try {
      const result = await inspectBox(idOrName);
      if (opts.json) {
        process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      } else {
        process.stdout.write(renderText(result) + '\n');
      }
    } catch (err) {
      handleLifecycleError(err);
    }
  });
