import { log } from '@clack/prompts';
import { LEGACY_AGENT_STATUS_KEYS, type AgentStatusEntry } from '@agentbox/core';
import { execa } from 'execa';
import { findProjectRoot, loadEffectiveConfig } from '@agentbox/config';
import { deriveRepoLabel, isHubWorkerClone } from '@agentbox/sandbox-core';
import { Command } from 'commander';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { boxLabel } from '../box-label.js';
import { hyperlink } from '../hyperlink.js';
import { hubBoxAgentStatus } from '../control-plane/hub-api-client.js';
import type { HubApiBox } from '../control-plane/hub-api-client.js';
import { cacheAge, fetchBoxListing, type BoxListing } from '../control-plane/hub-list.js';
import {
  dockerProvidersHidden,
  dockerHiddenReason,
  isDockerProvider,
} from '../control-plane/remote-hub.js';
import { normalizeOriginUrl } from '../control-plane/hub-adopt.js';
import { withWatchOptions, watchRender, type WatchableOptions } from '../watch.js';
import type { AgentId } from '@agentbox/core';

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

/** The display label for a box: its cosmetic `displayName`, else `name`, else
 *  the hub-computed `task`, else the id. `name` is absent on the hosted path. */
function boxLabelOf(b: HubApiBox): string {
  return boxLabel({ name: b.name ?? b.task ?? b.id, displayName: b.displayName ?? undefined });
}

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
 * Compact, clickable URL for the box: the box's web endpoint when present, else
 * its VNC desktop, followed by a `(VNC)` link when both exist. Display is the
 * bare `host[:port]` (no scheme, no query) so the VNC password in the query
 * string stays out of the table; the OSC-8 target keeps the full URL so a click
 * still works. Both endpoints come off the hub's Box payload (Step 3), not a
 * client-side provider probe.
 */
function urlCell(b: HubApiBox, stream: NodeJS.WriteStream, hub: HubLinkTarget | undefined): Cell {
  const web = b.webUrl ?? undefined;
  const vnc = vncLinkTarget(b, hub) ?? undefined;
  // The DISPLAYED host is always a direct box URL — never the hub's own host,
  // which a minted `(VNC)` link points at.
  const primary = web ?? b.vncUrl ?? undefined;

  const parts: Cell[] = [];
  if (primary) {
    let display: string;
    try {
      display = new URL(primary).host;
    } catch {
      display = primary;
    }
    parts.push({ text: hyperlink(display, primary, stream), width: display.length });
  }
  if (vnc && vnc !== primary) {
    const label = '(VNC)';
    parts.push({ text: hyperlink(label, vnc, stream), width: label.length });
  }
  if (parts.length === 0) return plain('');
  const sep = ' ';
  return {
    text: parts.map((p) => p.text).join(sep),
    width: parts.reduce((a, p) => a + p.width, 0) + sep.length * (parts.length - 1),
  };
}

export type HubLinkTarget = NonNullable<BoxListing['target']>;

/**
 * The `(VNC)` link target for a box: its static `vncUrl` when the payload has
 * one (docker / hetzner, which register a Portless alias), else a link into the
 * OWNING hub's `/boxes/:id/vnc` redirect, which mints a fresh signed URL
 * server-side at click time.
 *
 * That indirection is the whole point: a cloud provider's signed preview URL
 * expires within the hour, so a URL printed into a table row would be dead by
 * the time it's clicked. Null when VNC is off, the box isn't running, or we have
 * no live hub to link into (a stale/cached listing).
 */
export function vncLinkTarget(b: HubApiBox, hub: HubLinkTarget | undefined): string | null {
  if (b.vncUrl) return b.vncUrl;
  if (!hub || b.vncEnabled !== true) return null;
  if (effectiveState(b) !== 'running') return null;
  // `?token=` is how proxy.ts authorizes a click on a token-gated localhost hub:
  // it swaps the param for the session cookie and redirects to the clean URL.
  // A remote control box runs the password profile, where the API key gates only
  // /api/v1 — so omit it there rather than printing a secret that buys nothing,
  // and let the click land on /signin instead.
  const base = hub.url.replace(/\/+$/, '');
  const q = hub.mode === 'local' && hub.apiKey ? `?token=${encodeURIComponent(hub.apiKey)}` : '';
  return `${base}/boxes/${encodeURIComponent(b.id)}/vnc${q}`;
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
 * The merged AGENT column: every agent reporting in this box, annotated with its
 * activity state (working/idle/…) or named bare when it is up but silent.
 * Comma-joined when more than one; `-` when none.
 *
 * `state === 'unknown'` is treated as "no activity" — the supervisor seeds that
 * default, so showing it would put a spurious `claude:unknown` on nearly every
 * row. An agent that is up but silent is inferred from a session title (the hub
 * Box carries no per-agent running flag), which is a slightly weaker signal than
 * the old local shell probe but the best the payload exposes.
 *
 * Iterates the status map, so an agent this build has never heard of still shows
 * up. It used to name the three built-ins one at a time, which is why OpenCode —
 * whose plugin has always reported a real state — could only ever render as a
 * bare `opencode`.
 */
function agentSummary(b: HubApiBox): string {
  // A non-running box can't have a live agent; its persisted status (the source
  // of these fields) is the last snapshot before it stopped, so showing
  // `claude:idle` next to `paused`/`stopped` would be contradictory.
  if (effectiveState(b) !== 'running') return '-';
  const agents: string[] = [];
  for (const [agent, entry] of sortedAgentStatus(b)) {
    if (entry.state !== 'unknown') agents.push(`${agent}:${entry.state}`);
    else if (entry.sessionTitle) agents.push(agent);
  }
  return agents.length > 0 ? agents.join(', ') : '-';
}

/**
 * A box's agents in a stable display order: the built-ins first, in their
 * historical claude > codex > opencode precedence, then anything else
 * alphabetically. Order matters because it decides which agent `primaryAgent`
 * picks and how the AGENT column reads, and it must not jitter between polls.
 */
function sortedAgentStatus(b: HubApiBox): Array<[string, AgentStatusEntry]> {
  const rank = (id: string): number => {
    const i = LEGACY_AGENT_STATUS_KEYS.indexOf(id);
    return i === -1 ? LEGACY_AGENT_STATUS_KEYS.length : i;
  };
  return Object.entries(hubBoxAgentStatus(b)).sort(
    ([a], [c]) => rank(a) - rank(c) || a.localeCompare(c),
  );
}

// ---- compact rendering for the cmux dock sidebar (`--cmux`) ----------------
// A narrow (~22-col) Ghostty section can't fit the wide table, so we render two
// short lines per box (name, then a coloured glyph + agent + activity) modeled
// on the dashboard sidebar's `activityCell`. The colour map mirrors
// `mapActivityToWorkspace` in terminal/cmux-status.ts (blue=working,
// amber=needs-input, red=error, dim=idle).

type CmuxAgent = AgentId;

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

/** Resolve a box's primary agent + activity for the compact view. Takes the
 *  first agent with positive evidence in {@link sortedAgentStatus} order, which
 *  preserves the historical claude > codex > opencode priority and matches the
 *  dashboard's `resolveAgent`; `unknown` is not positive evidence, so it never
 *  pins claude over a running codex. */
export function primaryAgent(b: HubApiBox): {
  agent?: CmuxAgent;
  activity?: string;
} {
  const entries = sortedAgentStatus(b);
  const found = entries.find(([, e]) => e.state !== 'unknown' || e.sessionTitle);
  if (found) return { agent: found[0] as CmuxAgent, activity: found[1].state };
  // No positive evidence — fall back to claude's fields (a plain box shows its
  // glyph with no label).
  return { agent: 'claude', activity: b.claudeActivity };
}

/** Glyph + short label + colour bucket for an activity state. */
function activityView(a: string | undefined): {
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
export function cmuxStatusCell(b: HubApiBox, color: boolean): string {
  // A non-running box (a paused/stopped container, or a synthetic `job:` box that
  // carries no `state` — only a `creating`/`error` status) shows its bracketed
  // effective state instead of an agent. `state` wins when present (so a paused
  // box reads `[paused]`, not `[running]`); the `status` fallback covers the
  // plane view and job rows.
  const eff = effectiveState(b);
  if (eff !== 'running') {
    const s = `[${eff}]`;
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
 *  `agentbox://web/<id>` so a Ctrl+click opens the box's web app. */
export function renderCmuxRows(
  boxes: HubApiBox[],
  color: boolean,
  width: number,
  linkNames = false,
): string {
  const groups = new Map<string, HubApiBox[]>();
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
      const disp = tailKeep(boxLabelOf(b), Math.max(1, width - idx.length));
      // force OSC 8: the Herdr overlay always supports it and the link is what
      // drives Ctrl+click routing, so don't gate on terminal detection. The URL
      // uses the box's unique id (not its name — the overlay is global and names
      // can repeat across projects) so the click resolves to the right box.
      const name = linkNames ? hyperlink(disp, `agentbox://web/${b.id}`, undefined, true) : disp;
      lines.push(`${idx}${name}`);
      lines.push('  ' + cmuxStatusCell(b, color));
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
  return renderCmuxRows(boxes, color, width, linkNames);
}

/**
 * STATE for a box: its raw provider runtime state (running | paused | stopped),
 * or — for a synthetic `job:` box with no `state` — its lifecycle `status`
 * (creating | error). The hub is the single authority; there is no client-side
 * merge and so no `on hub` / `orphan` qualifier anymore.
 */
function stateCell(b: HubApiBox): string {
  // Trailing `*` marks a persistent (always-on) box; the legend under the table
  // explains it, so the column stays narrow.
  return b.persistent ? `${effectiveState(b)}*` : effectiveState(b);
}

/**
 * A box's effective runtime state, used by every renderer that gates on
 * "is it running". Prefers the host-only raw provider `state`, falling back to
 * the topology-agnostic lifecycle `status` — the read-only Postgres/plane view
 * carries `status` but no `state`, and a synthetic `job:` box only ever has
 * `status`. Keeping STATE, AGENT and the cmux glyph on this one notion stops a
 * plane box reading `running` in STATE yet `-`/`[running]` in the agent slot.
 */
function effectiveState(b: HubApiBox): string {
  return b.state ?? b.status;
}

/**
 * The PROVIDER cell. A `muted` box (a docker box hidden under a control box — see
 * `dockerProvidersHidden`) is kept in the listing but tagged `(inactive)` and
 * dimmed on a colour terminal, so a user can still read its name off `ls` and
 * `agentbox destroy <name>` it without first flipping `hub.mode=local`. Not
 * silently dropped: a hidden-but-running container is a resource leak with no
 * visible handle — the same silent-skip failure class rejected earlier in this
 * series.
 */
function providerCell(b: HubApiBox, muted: boolean, color: boolean): Cell {
  if (!muted) return plain(b.provider);
  const text = `${b.provider} (inactive)`;
  return { text: color ? colorize(text, 'dim') : text, width: text.length };
}

function renderTable(
  boxes: HubApiBox[],
  stream: NodeJS.WriteStream,
  mutedIds: ReadonlySet<string> = new Set(),
  hub?: HubLinkTarget,
): string {
  const color = !!stream.isTTY && !process.env.NO_COLOR;
  const header = ['N', 'NAME', 'STATE', 'AGENT', 'SHELLS', 'PROVIDER', 'URL', 'WORKSPACE'];
  const wsCol = header.length - 1;
  const lead: Cell[][] = boxes.map((b) => [
    plain(typeof b.projectIndex === 'number' ? String(b.projectIndex) : ''),
    plain(boxLabelOf(b)),
    plain(stateCell(b)),
    // One column for every agent (claude / codex / opencode) — see agentSummary.
    plain(agentSummary(b)),
    // Live shell-session count from the hub payload; `-` for none (or a
    // non-docker box, which carries no shell count).
    plain(b.shellCount && b.shellCount > 0 ? String(b.shellCount) : '-'),
    providerCell(b, mutedIds.has(b.id), color),
    urlCell(b, stream, hub),
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
  // A control box builds every box from a per-job clone under
  // `/tmp/agentbox-hub-worker-<jobId>` and deletes it as soon as the create
  // returns, so printing that path names a directory nobody can visit and says
  // nothing about the project. The repo is the durable identity — same
  // substitution `registrationProjectKey` makes when grouping project cards.
  const workspaceOf = (b: HubApiBox): string => {
    const root = b.projectRoot ?? '';
    if (b.originUrl && root && isHubWorkerClone(root)) return deriveRepoLabel(b.originUrl);
    return root;
  };
  const naturalWs = Math.max(
    header[wsCol]?.length ?? 0,
    ...boxes.map((b) => workspaceOf(b).length),
  );
  const wsWidth = Math.min(naturalWs, Math.max(16, term - fixedTotal));

  const widths = [...fixedWidths, wsWidth];
  const rows: Cell[][] = boxes.map((b, idx) => [
    ...(lead[idx] as Cell[]),
    workspaceCell(workspaceOf(b), wsWidth, stream),
  ]);
  const all: Cell[][] = [[...leadHeader, plain(header[wsCol] as string)], ...rows];

  const padCell = (cell: Cell, col: number): string => {
    const target = widths[col] ?? 0;
    return cell.text + ' '.repeat(Math.max(0, target - cell.width));
  };

  const table = all
    .map((row) =>
      row
        .map((cell, i) => padCell(cell ?? plain(''), i))
        .join('  ')
        .trimEnd(),
    )
    .join('\n');
  // Only when it applies: a legend on every listing is noise for the common
  // all-expendable fleet.
  if (!boxes.some((b) => b.persistent)) return table;
  const legend = '* persistent (always-on): never auto-paused or pruned; restarted after a reboot';
  return `${table}\n${color ? colorize(legend, 'dim') : legend}`;
}

/**
 * The boxes `list` should render: scoped to the cwd's project by default
 * (consistent with every other box-arg command), or all boxes under `--global`.
 * Pre-feature boxes have no `projectRoot`, so they surface only under `--global`.
 *
 * Every box comes from the hub's `/api/v1/boxes` — a single listing, no merge.
 * The hub is the source of truth for docker, cloud and in-flight `job:` boxes
 * alike, in both modes (a local hub or a remote control box). A registered box
 * the hub knows but this laptop never adopted has no local `projectRoot`, so it
 * is scoped by its registered origin URL instead.
 */
/**
 * Does a box belong to the cwd's project? Two keys:
 *  - `projectRoot === root`: an exact same-machine folder match (a local hub, an
 *    exposed loopback hub, or a box adopted onto this laptop).
 *  - repo identity (`originUrl`): the cross-machine key, used ONLY when the box's
 *    `projectRoot` can't be interpreted here — it's absent (a registered box), or
 *    it's `projectRootForeign` (a path that does not exist on this filesystem, so
 *    it must be a remote hub's own path). Gating origin matching on that is what
 *    keeps two local clones of one repo apart (their folders both exist locally,
 *    so neither is `foreign`) while still surfacing a genuinely remote hub's
 *    boxes — whose `projectRoot` never resolves locally regardless of how the hub
 *    is reached (a real hostname, or an SSH tunnel to loopback).
 */
export function boxInProject(
  b: HubApiBox,
  ctx: { root: string; origin: string | undefined; projectRootForeign: boolean },
): boolean {
  if (b.projectRoot === ctx.root) return true;
  const originMatches =
    ctx.origin !== undefined &&
    b.originUrl != null &&
    normalizeOriginUrl(b.originUrl) === normalizeOriginUrl(ctx.origin);
  return originMatches && (b.projectRoot == null || ctx.projectRootForeign);
}

async function scopedBoxes(
  all: boolean,
  live: boolean,
): Promise<{ boxes: HubApiBox[]; projectRoot: string; scoped: boolean; listing: BoxListing }> {
  const listing = await fetchBoxListing({ live });
  const boxes = listing.boxes;
  if (all) return { boxes, projectRoot: '', scoped: false, listing };
  const { root } = await findProjectRoot(process.cwd());
  const origin = await readCwdOriginUrl(root);
  const scoped = boxes.filter((b) =>
    boxInProject(b, {
      root,
      origin,
      // A projectRoot that names no directory on THIS machine is the control
      // box's own path — the box came from a hub on another machine, so scope it
      // by repo identity. A local folder (local hub / loopback-exposed hub) does
      // exist, so it scopes by folder. This one filesystem probe disambiguates
      // both loopback cases the URL host alone cannot (exposed-here vs tunneled).
      projectRootForeign:
        b.projectRoot != null && b.projectRoot !== root && !existsSync(b.projectRoot),
    }),
  );
  return { boxes: scoped, projectRoot: root, scoped: true, listing };
}

/** The cwd project's `origin` remote, for scoping registered hub boxes. */
async function readCwdOriginUrl(root: string): Promise<string | undefined> {
  const r = await execa('git', ['-C', root, 'remote', 'get-url', 'origin'], { reject: false });
  const url = (r.stdout ?? '').trim();
  return r.exitCode === 0 && url.length > 0 ? url : undefined;
}

/** The staleness footer for a listing served from the offline cache. */
function staleNote(listing: BoxListing): string {
  if (listing.stale !== true) return '';
  if (listing.reason === 'no-token') {
    return '\ncontrol box configured but no API key — hub boxes not shown. Run `agentbox hub setup`, or set AGENTBOX_HUB_API_KEY.';
  }
  return listing.fetchedAt !== undefined
    ? `\nhub unreachable — showing boxes as of ${cacheAge(listing.fetchedAt)}`
    : '\nhub unreachable — no cached boxes to show';
}

async function buildListText(all: boolean, live: boolean): Promise<string> {
  const { boxes, projectRoot, scoped, listing } = await scopedBoxes(all, live);
  // Docker off under a remote hub (Step 12): mark (don't drop) docker boxes as
  // inactive when docker is gated here, plus a footer note naming the key + reason.
  const muted = await mutedDockerBoxes(boxes);
  const note = staleNote(listing) + dockerHiddenNote(muted.ids.size, muted.reason);
  if (boxes.length === 0) {
    if (scoped) {
      return `no boxes in this project (${projectRoot}) — run \`agentbox create\`, or \`agentbox list --global\` to see all${note}`;
    }
    return `no boxes — run \`agentbox create\` to make one${note}`;
  }
  const table = renderTable(boxes, process.stdout, muted.ids, listing.target);
  if (!scoped) return table + note;
  // basename of projectRoot — matches dashboard sidebar's projectLabel().
  const name = projectRoot.split('/').filter(Boolean).pop() ?? projectRoot;
  return `Project: ${name}\n${table}${note}`;
}

/**
 * Ids of docker boxes to show as inactive (+ the reason docker is gated, for the
 * footer): docker-provider boxes in the listing when `dockerProvidersHidden`
 * (a control box, or `hub.mode=thin`). Empty + null reason when docker is on here,
 * so `ls` is byte-identical to before.
 */
async function mutedDockerBoxes(
  boxes: HubApiBox[],
): Promise<{ ids: Set<string>; reason: string | null }> {
  const cfg = await loadEffectiveConfig(process.cwd()).catch(() => null);
  if (!cfg || !dockerProvidersHidden(cfg.effective)) return { ids: new Set(), reason: null };
  const ids = new Set(boxes.filter((b) => isDockerProvider(b.provider)).map((b) => b.id));
  return { ids, reason: dockerHiddenReason(cfg.effective) };
}

/** Footer note when docker boxes are shown inactive, naming the reason + re-enable key. */
function dockerHiddenNote(count: number, reason: string | null): string {
  if (count === 0 || reason === null) return '';
  const n = count === 1 ? '1 docker box is' : `${count} docker boxes are`;
  return `\n${n} shown as inactive because ${reason}; set \`hub.mode=local\` (\`agentbox config set hub.mode local\`) to manage docker here.`;
}

export const listCommand = withWatchOptions(
  new Command('list')
    .alias('ls')
    .description('List agent boxes in the current project (-g for all)')
    .option('-j, --json', 'machine-readable JSON output')
    .option('-g, --global', 'include boxes from all projects')
    .option(
      '--live',
      'ask the hub to probe live cloud state via the provider SDK (slower; default: last host-known state)',
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
    // `agentbox://web/<id>` so a Ctrl+click opens the box web app.
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
    const checkbox = (): string => `[${scoped ? 'x' : ' '}] all projects   ·   press g to toggle\n`;
    await watchRender(async () => checkbox() + (await buildListText(scoped, live)), opts.interval, {
      onKey: (k) => {
        if (k === 'g') {
          scoped = !scoped;
          return 'redraw';
        }
        return 'ignore';
      },
    });
    return;
  }
  if (opts.json) {
    const { boxes } = await scopedBoxes(all, live);
    process.stdout.write(JSON.stringify(boxes, null, 2) + '\n');
    return;
  }
  process.stdout.write((await buildListText(all, live)) + '\n');
});
