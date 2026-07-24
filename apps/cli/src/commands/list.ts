import { log } from '@clack/prompts';
import { execa } from 'execa';
import { findProjectRoot } from '@agentbox/config';
import type { AgentActivityState } from '@agentbox/ctl';
import { listBoxes, type ListedBox } from '@agentbox/sandbox-docker';
import { Command } from 'commander';
import { pathToFileURL } from 'node:url';
import { boxLabel } from '../box-label.js';
import { hyperlink } from '../hyperlink.js';
import { applyLiveCloudStates } from '../lib/cloud-state.js';
import { cacheAge, fetchHubListing, type HubListing } from '../control-plane/hub-list.js';
import { mergeHubBoxes, type MergedBox } from '../control-plane/hub-merge.js';
import { normalizeOriginUrl } from '../control-plane/hub-adopt.js';
import { withWatchOptions, watchRender, type WatchableOptions } from '../watch.js';

interface ListOptions extends WatchableOptions {
  json?: boolean;
  global?: boolean;
  live?: boolean;
  cmux?: boolean;
  herdr?: boolean;
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

/**
 * The merged AGENT column: every active agent session, claude annotated with
 * its activity state (working/idle/…), codex/opencode with just their name
 * (running/not is all they expose). Comma-joined when more than one is up;
 * `-` when none.
 *
 * `claudeActivity === 'unknown'` is treated as "no claude" — the supervisor
 * seeds that default for *every* box (even codex/opencode boxes), so showing
 * it would put a spurious `claude:unknown` on nearly every row.
 */
function agentSummary(b: ListedBox): string {
  // A non-running box can't have a live agent; its persisted status.json (the
  // source of these fields) is just the last snapshot before it stopped, so
  // showing `claude:idle` next to `paused`/`stopped` would be contradictory.
  if (b.state !== 'running') return '-';
  const agents: string[] = [];
  if (b.claudeActivity && b.claudeActivity !== 'unknown') {
    agents.push(`claude:${b.claudeActivity}`);
  }
  // Codex: show its activity when a hook has reported one; otherwise fall back
  // to a plain `codex` so a running codex box stays visible before the first
  // hook fires (or on boxes whose image predates the codex hooks).
  if (b.codexActivity && b.codexActivity !== 'unknown') {
    agents.push(`codex:${b.codexActivity}`);
  } else if (b.codexSession?.running) {
    agents.push('codex');
  }
  if (b.opencodeSession?.running) agents.push('opencode');
  return agents.length > 0 ? agents.join(', ') : '-';
}

// ---- compact rendering for the cmux dock sidebar (`--cmux`) ----------------
// A narrow (~22-col) Ghostty section can't fit the wide table, so we render two
// short lines per box (name, then a coloured glyph + agent + activity) modeled
// on the dashboard sidebar's `activityCell`. The colour map mirrors
// `mapActivityToWorkspace` in terminal/cmux-status.ts (blue=working,
// amber=needs-input, red=error, dim=idle).

type CmuxAgent = 'claude' | 'codex' | 'opencode';

/** 256-colour SGR codes, keyed by the activity colour bucket. */
const CMUX_COLOR: Record<'blue' | 'amber' | 'red' | 'dim', string> = {
  blue: '38;5;39',
  amber: '38;5;214',
  red: '38;5;196',
  dim: '38;5;245',
};

function colorize(s: string, bucket: keyof typeof CMUX_COLOR): string {
  return `\x1b[${CMUX_COLOR[bucket]}m${s}\x1b[0m`;
}

/** Truncate keeping the *tail* (the distinguishing `…-78b94c78` suffix of a box
 *  name), prepending `…` when it had to cut. Mirrors the dashboard's
 *  `ellipsizeHead`. */
function tailKeep(s: string, max: number): string {
  if (max <= 0) return '';
  if (s.length <= max) return s;
  if (max === 1) return '…';
  return '…' + s.slice(s.length - (max - 1));
}

/** Resolve a box's primary agent + activity for the compact view. Priority
 *  claude > codex > opencode, matching the dashboard's `resolveAgent`; `unknown`
 *  is not positive evidence, so it never pins claude over a running codex. */
export function primaryAgent(b: ListedBox): {
  agent?: CmuxAgent;
  activity?: AgentActivityState;
} {
  const real = (s?: string): boolean => !!s && s !== 'unknown';
  if (real(b.claudeActivity) || b.claudeSessionTitle) {
    return { agent: 'claude', activity: b.claudeActivity };
  }
  if (b.codexSession?.running || real(b.codexActivity)) {
    return { agent: 'codex', activity: b.codexActivity };
  }
  if (b.opencodeSession?.running) return { agent: 'opencode' };
  // No positive evidence — fall back to claude's fields (a plain box shows its
  // glyph with no label).
  return { agent: 'claude', activity: b.claudeActivity };
}

/** Glyph + short label + colour bucket for an activity state. */
function activityView(a: AgentActivityState | undefined): {
  glyph: string;
  label: string;
  bucket: keyof typeof CMUX_COLOR;
} {
  switch (a) {
    case 'working':
      return { glyph: '●', label: 'working', bucket: 'blue' };
    case 'compacting':
      return { glyph: '●', label: 'compacting', bucket: 'blue' };
    case 'idle':
      return { glyph: '○', label: 'idle', bucket: 'dim' };
    case 'waiting':
    case 'question':
      return { glyph: '◐', label: 'needs input', bucket: 'amber' };
    case 'end-plan':
      return { glyph: '◐', label: 'plan ready', bucket: 'amber' };
    case 'error':
      return { glyph: '✖', label: 'error', bucket: 'red' };
    default: // unknown / undefined — running but no hook has fired yet
      return { glyph: '○', label: '', bucket: 'dim' };
  }
}

/** The status line (line 2) for a box in the compact view. */
export function cmuxStatusCell(
  b: ListedBox & { needsAdopt?: boolean },
  color: boolean,
  live = false,
): string {
  // A box that only exists on the control box has no local agent state to show —
  // its `running` is a placeholder, not a probe. Rendering the usual glyph here
  // claimed a live agent for a box this machine has never even adopted. Under
  // `--live` the state HAS been probed, so show it — same rule as the table's
  // `stateCell`, or the dock and the table disagree on identical data.
  if (b.needsAdopt === true && !live) {
    const s = '[on hub]';
    return color ? colorize(s, 'dim') : s;
  }
  if (b.state !== 'running') {
    const s = `[${b.state}]`;
    return color ? colorize(s, 'dim') : s;
  }
  const { agent, activity } = primaryAgent(b);
  const v = activityView(activity);
  const text = `${v.glyph} ${agent ?? 'agent'}${v.label ? ' ' + v.label : ''}`;
  return color ? colorize(text, v.bucket) : text;
}

/** basename of a project root, for a group header (`other` for pre-feature
 *  boxes with no recorded project). */
function projectLabel(root: string): string {
  if (!root) return 'other';
  return root.split('/').filter(Boolean).pop() ?? root;
}

/** Dim, dashed group header: `── name ──`, head-truncated to the panel width. */
function projectHeader(label: string, color: boolean, width: number): string {
  const max = Math.max(1, width - 6); // room for the `── ` + ` ──` frame
  const name = label.length > max ? label.slice(0, Math.max(1, max - 1)) + '…' : label;
  const h = `── ${name} ──`;
  return color ? colorize(h, 'dim') : h;
}

/** The panel is global, so group boxes by project under a dashed header, then
 *  two lines per box: `<index> <name>` and an indented status cell. Groups keep
 *  first-seen order and are separated by a blank line. When `linkNames` is set
 *  (the Herdr overlay), each box name is an OSC 8 hyperlink to
 *  `agentbox://web/<name>` so a Ctrl+click opens the box's web app. */
export function renderCmuxRows(
  boxes: ListedBox[],
  color: boolean,
  width: number,
  linkNames = false,
  live = false,
): string {
  const groups = new Map<string, ListedBox[]>();
  for (const b of boxes) {
    const key = b.projectRoot ?? '';
    const arr = groups.get(key);
    if (arr) arr.push(b);
    else groups.set(key, [b]);
  }
  const lines: string[] = [];
  let first = true;
  for (const [root, group] of groups) {
    if (!first) lines.push('');
    first = false;
    lines.push(projectHeader(projectLabel(root), color, width));
    for (const b of group) {
      const idx = b.projectIndex ? `${String(b.projectIndex)} ` : '';
      const disp = tailKeep(boxLabel(b), Math.max(1, width - idx.length));
      // force OSC 8: the Herdr overlay always supports it and the link is what
      // drives Ctrl+click routing, so don't gate on terminal detection. The URL
      // uses the box's unique id (not its name — the overlay is global and names
      // can repeat across projects) so the click resolves to the right box.
      const name = linkNames ? hyperlink(disp, `agentbox://web/${b.id}`, undefined, true) : disp;
      lines.push(`${idx}${name}`);
      lines.push('  ' + cmuxStatusCell(b, color, live));
    }
  }
  return lines.join('\n');
}

/** Short empty-state message tuned for the narrow panel (fits ~22 cols). */
export function cmuxEmptyMessage(): string {
  return 'no boxes · agentbox create';
}

async function buildCmuxText(live: boolean, color: boolean, linkNames = false): Promise<string> {
  // The dock/overlay is global: it runs from the config base (home), not the
  // focused project, so per-project scoping can't follow the active workspace.
  // Always show every box across all projects.
  const { boxes } = await scopedBoxes(true, live);
  if (boxes.length === 0) return cmuxEmptyMessage();
  // Re-read width each tick so a resized panel re-truncates.
  const width = process.stdout.columns ?? 30;
  return renderCmuxRows(boxes, color, width, linkNames, live);
}

/**
 * STATE, qualified by where the row came from. An un-adopted hub box has no
 * locally-known state — a registration doesn't carry one and `list` must stay
 * instant — so say `on hub` rather than assert `running`. `--live` does probe
 * it (the registration carries backend + sandboxId), so then show the truth.
 * An orphan is a local record for a box the control box no longer has.
 */
function stateCell(b: MergedBox, live: boolean): string {
  if (b.source === 'orphan') return `${b.state} (orphan)`;
  if (b.needsAdopt && !live) return 'on hub';
  return b.state;
}

function renderTable(boxes: MergedBox[], stream: NodeJS.WriteStream, live: boolean): string {
  const header = ['N', 'NAME', 'STATE', 'AGENT', 'SHELLS', 'PROVIDER', 'URL', 'WORKSPACE'];
  const wsCol = header.length - 1;
  const lead: Cell[][] = boxes.map((b) => [
    plain(typeof b.projectIndex === 'number' ? String(b.projectIndex) : ''),
    plain(boxLabel(b)),
    plain(stateCell(b, live)),
    // One column for every agent (claude / codex / opencode) — see agentSummary.
    plain(agentSummary(b)),
    // Live shell-session count; `-` for none (or a non-running box). Detail
    // lives in `agentbox shell ls <box>`.
    plain(b.shellSessions.length > 0 ? String(b.shellSessions.length) : '-'),
    plain(b.provider ?? 'docker'),
    urlCell(b, stream),
  ]);
  const leadHeader = header.slice(0, wsCol).map(plain);

  // Widths for the fixed columns (everything but WORKSPACE).
  const fixedCols = leadHeader.map((_, i) => i);
  const fixedWidths = fixedCols.map((col) =>
    Math.max(leadHeader[col]?.width ?? 0, ...lead.map((r) => r[col]?.width ?? 0)),
  );

  // WORKSPACE budget: whatever's left of the terminal after the fixed columns
  // + the 2-space separators. Never below a usable floor.
  const term = stream.columns && stream.columns > 0 ? stream.columns : 120;
  const fixedTotal = fixedWidths.reduce((a, b) => a + b, 0) + header.length * 2;
  const naturalWs = Math.max(
    header[wsCol]?.length ?? 0,
    ...boxes.map((b) => b.workspacePath.length),
  );
  const wsWidth = Math.min(naturalWs, Math.max(16, term - fixedTotal));

  const widths = [...fixedWidths, wsWidth];
  const rows: Cell[][] = boxes.map((b, idx) => [
    ...(lead[idx] as Cell[]),
    workspaceCell(b.workspacePath, wsWidth, stream),
  ]);
  const all: Cell[][] = [[...leadHeader, plain(header[wsCol] as string)], ...rows];

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
 * `--global`. Pre-feature boxes have no `projectRoot`, so they surface only
 * under `--global` — same as auto-pick, which never matches them implicitly.
 *
 * With a control box configured, cloud boxes come from IT (the source of truth),
 * merged with the local docker boxes — so a box created from the web UI shows
 * here without ever having been adopted. See `hub-merge.ts` for the rules.
 */
async function scopedBoxes(
  all: boolean,
  live: boolean,
): Promise<{ boxes: MergedBox[]; projectRoot: string; scoped: boolean; hub: HubListing | null }> {
  const local = await listBoxes();
  const hub = await fetchHubListing().catch(() => null);
  const boxes = mergeHubBoxes(local, hub ? hub.registrations : null, { stale: hub?.stale });
  if (all) {
    // Default: cloud state is the fast persisted `cloud.lastState` from
    // listBoxes. `--live` overrides it with an authoritative SDK probe.
    if (live) await applyLiveCloudStates(boxes);
    return { boxes, projectRoot: '', scoped: false, hub };
  }
  const { root } = await findProjectRoot(process.cwd());
  // An un-adopted hub box has no projectRoot yet — nothing has matched it to a
  // local clone. Scope it by its registered origin URL instead, so the boxes of
  // the repo you're standing in show up whether or not they were created here.
  const origin = await readCwdOriginUrl(root);
  const scoped = boxes.filter(
    (b) =>
      b.projectRoot === root ||
      (b.needsAdopt === true &&
        origin !== undefined &&
        b.originUrl !== undefined &&
        normalizeOriginUrl(b.originUrl) === normalizeOriginUrl(origin)),
  );
  // Probe only the scoped boxes — don't round-trip every cloud box on the host.
  if (live) await applyLiveCloudStates(scoped);
  return { boxes: scoped, projectRoot: root, scoped: true, hub };
}

/** The cwd project's `origin` remote, for scoping un-adopted hub boxes. */
async function readCwdOriginUrl(root: string): Promise<string | undefined> {
  const r = await execa('git', ['-C', root, 'remote', 'get-url', 'origin'], { reject: false });
  const url = (r.stdout ?? '').trim();
  return r.exitCode === 0 && url.length > 0 ? url : undefined;
}

async function buildListText(all: boolean, live: boolean): Promise<string> {
  const { boxes, projectRoot, scoped, hub } = await scopedBoxes(all, live);
  // A stale listing is only worth flagging when a control box is configured at
  // all — otherwise there's nothing the user could act on.
  const note =
    hub?.stale === true
      ? hub.reason === 'no-token'
        ? '\ncontrol box configured but no admin token — hub boxes not shown. Run `agentbox hub setup`, or set AGENTBOX_RELAY_ADMIN_TOKEN.'
        : hub.fetchedAt !== undefined
          ? `\ncontrol box unreachable — hub boxes as of ${cacheAge(hub.fetchedAt)}`
          : '\ncontrol box unreachable — hub boxes not shown'
      : '';
  if (boxes.length === 0) {
    if (scoped) {
      return `no boxes in this project (${projectRoot}) — run \`agentbox create\`, or \`agentbox list --global\` to see all${note}`;
    }
    return `no boxes — run \`agentbox create\` to make one${note}`;
  }
  const table = renderTable(boxes, process.stdout, live);
  if (!scoped) return table + note;
  // basename of projectRoot — matches dashboard sidebar's projectLabel().
  const name = projectRoot.split('/').filter(Boolean).pop() ?? projectRoot;
  return `Project: ${name}\n${table}${note}`;
}

export const listCommand = withWatchOptions(
  new Command('list')
    .alias('ls')
    .description('List agent boxes in the current project (-g for all)')
    .option('-j, --json', 'machine-readable JSON output')
    .option('-g, --global', 'include boxes from all projects')
    .option(
      '--live',
      'probe live cloud state via the provider SDK (slower; default: last host-known state)',
    )
    .option('--cmux', 'compact output for the cmux dock sidebar (narrow, 2 lines per box)')
    .option(
      '--herdr',
      'compact output for the Herdr boxes overlay (like --cmux; box names link to the box web app)',
    ),
).action(async (opts: ListOptions) => {
  if (opts.json && opts.watch) {
    log.error('cannot combine --json with --watch');
    process.exit(2);
  }
  const all = opts.global ?? false;
  const live = opts.live ?? false;
  if (opts.cmux || opts.herdr) {
    // Compact sidebar/overlay view: no watch chrome, a colored 2-lines-per-box
    // body, always global (see buildCmuxText). Colour is dropped on
    // non-TTY/NO_COLOR. The Herdr overlay additionally links box names to
    // `agentbox://web/<name>` so a Ctrl+click opens the box web app.
    const color = !!process.stdout.isTTY && !process.env.NO_COLOR;
    const linkNames = !!opts.herdr;
    if (opts.watch) {
      await watchRender(() => buildCmuxText(live, color, linkNames), opts.interval, {
        hideStatusLine: true,
      });
      return;
    }
    process.stdout.write((await buildCmuxText(live, color, linkNames)) + '\n');
    return;
  }
  if (opts.watch) {
    // The cmux dock has no checkbox widget, so the project-vs-global scope is a
    // live toggle inside the watch view: `g` flips it, a checkbox header shows
    // the current state. `scoped` is mutable so the toggle takes effect.
    let scoped = all;
    const checkbox = (): string =>
      `[${scoped ? 'x' : ' '}] all projects   ·   press g to toggle\n`;
    await watchRender(
      async () => checkbox() + (await buildListText(scoped, live)),
      opts.interval,
      {
        onKey: (k) => {
          if (k === 'g') {
            scoped = !scoped;
            return 'redraw';
          }
          return 'ignore';
        },
      },
    );
    return;
  }
  if (opts.json) {
    const { boxes } = await scopedBoxes(all, live);
    process.stdout.write(JSON.stringify(boxes, null, 2) + '\n');
    return;
  }
  process.stdout.write((await buildListText(all, live)) + '\n');
});
