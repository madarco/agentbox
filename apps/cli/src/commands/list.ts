import { log } from '@clack/prompts';
import { findProjectRoot } from '@agentbox/config';
import { listBoxes, type ListedBox } from '@agentbox/sandbox-docker';
import { Command } from 'commander';
import { pathToFileURL } from 'node:url';
import { hyperlink } from '../hyperlink.js';
import { withWatchOptions, watchRender, type WatchableOptions } from '../watch.js';

interface ListOptions extends WatchableOptions {
  json?: boolean;
  all?: boolean;
}

/** A table cell: the (possibly OSC-8-wrapped) text to print + its visible width. */
interface Cell {
  text: string;
  width: number;
}

const plain = (s: string): Cell => ({ text: s, width: s.length });

/**
 * Shorten `s` to `n` visible chars, keeping the head and the final path
 * segment with `…` in the middle (`/Users/marco/Pr…/test-workspace`). Falls
 * back to a plain head+ellipsis when the tail alone won't fit.
 */
function middleTruncate(s: string, n: number): string {
  if (s.length <= n) return s;
  if (n <= 1) return s.length > 0 ? '…' : '';
  const slash = s.lastIndexOf('/');
  const tail = slash >= 0 ? s.slice(slash) : '';
  // Need room for at least one head char + ellipsis + the whole tail.
  if (tail.length > 0 && tail.length + 2 <= n) {
    const head = s.slice(0, n - 1 - tail.length);
    return `${head}…${tail}`;
  }
  return s.slice(0, n - 1) + '…';
}

/**
 * Compact, clickable URL for the box: the `expose:`-flagged web endpoint when
 * present (the box's main app, explicitly declared), else the first reachable
 * service, followed by a `(VNC)` link to the noVNC URL when VNC is enabled.
 * Display is the bare `host[:port]` (no scheme, no query) so the VNC password in
 * the query string stays out of the table; the OSC-8 target keeps the full URL
 * so a click still works. Falls back to VNC alone when there's no service.
 */
function urlCell(box: ListedBox, stream: NodeJS.WriteStream): Cell {
  const eps = box.endpoints.endpoints;
  const vnc = eps.find((e) => e.kind === 'vnc' && e.url);
  const primary =
    eps.find((e) => e.kind === 'web' && e.url) ??
    eps.find((e) => e.kind === 'service' && e.url) ??
    vnc;
  if (!primary?.url) return plain('');

  let display: string;
  try {
    display = new URL(primary.url).host;
  } catch {
    display = primary.url;
  }

  const parts: Cell[] = [
    { text: hyperlink(display, primary.url, stream), width: display.length },
  ];
  if (vnc?.url && vnc !== primary) {
    const label = '(VNC)';
    parts.push({ text: hyperlink(label, vnc.url, stream), width: label.length });
  }
  const sep = ' ';
  return {
    text: parts.map((p) => p.text).join(sep),
    width: parts.reduce((a, p) => a + p.width, 0) + sep.length * (parts.length - 1),
  };
}

/** Workspace path truncated to `target` and linked to its `file://` URL. */
function workspaceCell(path: string, target: number, stream: NodeJS.WriteStream): Cell {
  const display = middleTruncate(path, target);
  let url: string;
  try {
    url = pathToFileURL(path).href;
  } catch {
    return { text: display, width: display.length };
  }
  return { text: hyperlink(display, url, stream), width: display.length };
}

function renderTable(boxes: ListedBox[], stream: NodeJS.WriteStream): string {
  const header = ['N', 'NAME', 'STATE', 'CLAUDE', 'SHELLS', 'URL', 'WORKSPACE'];
  const lead: Cell[][] = boxes.map((b) => [
    plain(typeof b.projectIndex === 'number' ? String(b.projectIndex) : ''),
    plain(b.name),
    plain(b.state),
    plain(b.claudeActivity ?? ''),
    // Live shell-session count; `-` for none (or a non-running box). Detail
    // lives in `agentbox shell ls <box>`.
    plain(b.shellSessions.length > 0 ? String(b.shellSessions.length) : '-'),
    urlCell(b, stream),
  ]);
  const leadHeader = header.slice(0, 6).map(plain);

  // Widths for the fixed columns (everything but WORKSPACE).
  const fixedWidths = [0, 1, 2, 3, 4, 5].map((col) =>
    Math.max(leadHeader[col]?.width ?? 0, ...lead.map((r) => r[col]?.width ?? 0)),
  );

  // WORKSPACE budget: whatever's left of the terminal after the fixed columns
  // + the 2-space separators. Never below a usable floor.
  const term = stream.columns && stream.columns > 0 ? stream.columns : 120;
  const fixedTotal = fixedWidths.reduce((a, b) => a + b, 0) + header.length * 2;
  const naturalWs = Math.max(
    header[6]?.length ?? 0,
    ...boxes.map((b) => b.workspacePath.length),
  );
  const wsWidth = Math.min(naturalWs, Math.max(16, term - fixedTotal));

  const widths = [...fixedWidths, wsWidth];
  const rows: Cell[][] = boxes.map((b, idx) => [
    ...(lead[idx] as Cell[]),
    workspaceCell(b.workspacePath, wsWidth, stream),
  ]);
  const all: Cell[][] = [[...leadHeader, plain(header[6] as string)], ...rows];

  const padCell = (cell: Cell, col: number): string => {
    const target = widths[col] ?? 0;
    return cell.text + ' '.repeat(Math.max(0, target - cell.width));
  };

  return all
    .map((row) =>
      row
        .map((cell, i) => padCell(cell ?? plain(''), i))
        .join('  ')
        .trimEnd(),
    )
    .join('\n');
}

/**
 * The boxes `list` should render: scoped to the cwd's project by default
 * (consistent with every other box-arg command, which routes through
 * `box-ref.ts`'s `findProjectRoot` + `resolveBoxRef`), or all boxes under
 * `--all`. Pre-feature boxes have no `projectRoot`, so they surface only under
 * `--all` — same as auto-pick, which never matches them implicitly.
 */
async function scopedBoxes(
  all: boolean,
): Promise<{ boxes: ListedBox[]; projectRoot: string; scoped: boolean }> {
  const boxes = await listBoxes();
  if (all) return { boxes, projectRoot: '', scoped: false };
  const { root } = await findProjectRoot(process.cwd());
  return { boxes: boxes.filter((b) => b.projectRoot === root), projectRoot: root, scoped: true };
}

async function buildListText(all: boolean): Promise<string> {
  const { boxes, projectRoot, scoped } = await scopedBoxes(all);
  if (boxes.length === 0) {
    if (scoped) {
      return `no boxes in this project (${projectRoot}) — run \`agentbox create\`, or \`agentbox list --all\` to see all`;
    }
    return 'no boxes — run `agentbox create` to make one';
  }
  const table = renderTable(boxes, process.stdout);
  if (!scoped) return table;
  // basename of projectRoot — matches dashboard sidebar's projectLabel().
  const name = projectRoot.split('/').filter(Boolean).pop() ?? projectRoot;
  return `Project: ${name}\n${table}`;
}

export const listCommand = withWatchOptions(
  new Command('list')
    .alias('ls')
    .description('List agent boxes in the current project (-a for all)')
    .option('-j, --json', 'machine-readable JSON output')
    .option('-a, --all', 'include boxes from all projects'),
).action(async (opts: ListOptions) => {
  if (opts.json && opts.watch) {
    log.error('cannot combine --json with --watch');
    process.exit(2);
  }
  const all = opts.all ?? false;
  if (opts.watch) {
    await watchRender(() => buildListText(all), opts.interval);
    return;
  }
  if (opts.json) {
    const { boxes } = await scopedBoxes(all);
    process.stdout.write(JSON.stringify(boxes, null, 2) + '\n');
    return;
  }
  process.stdout.write((await buildListText(all)) + '\n');
});
