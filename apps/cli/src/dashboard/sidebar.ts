export interface SidebarBox {
  id: string;
  name: string;
  /** Container state: 'running' | 'paused' | 'stopped' | 'missing' | … */
  state: string;
  /** 'working' | 'idle' | 'waiting' | 'unknown' | undefined */
  claudeActivity?: string;
  /** The in-box terminal title Claude set, or undefined when none. */
  sessionTitle?: string;
  /** 1-based per-project box number, shown as `[N]`; undefined for
   *  pre-feature boxes and the synthetic "+ New box" entry. */
  index?: number;
  /** Absolute project root; used to group boxes under a project header.
   *  Undefined for pre-feature boxes and the synthetic "+ New box" entry. */
  project?: string;
  /** This box has an unanswered relay `prompt-ask` event (e.g. agentbox-ctl
   *  git push / cp / download waiting for user confirmation). The compositor
   *  injects this flag from its in-memory map of active prompts. Overrides
   *  the activity cell — `▲ prompt` reads more urgent than `● working`. */
  pendingPrompt?: boolean;
  /** This box has an active relay notice (currently: a checkpoint is being
   *  captured, freezing the box). Injected by the compositor; shown as
   *  `◆ checkpoint` in the activity cell. Outranked by `pendingPrompt`. */
  checkpointing?: boolean;
}

/** Per-row ownership + styling map returned alongside the rendered lines so
 *  the compositor can highlight the selected box and style headers without
 *  re-deriving the (now non-uniform) layout. */
export interface SidebarRender {
  lines: string[];
  /** boxId rendered on row `i`, else null (banner / group header / blank). */
  rowOwner: (string | null)[];
  /** true for the banner and project-header rows (styled like the banner). */
  headerRows: boolean[];
}

/** Truncate to `max` printable chars, appending `…` when it had to cut
 *  (keeps the head). */
function ellipsize(s: string, max: number): string {
  if (max <= 0) return '';
  if (s.length <= max) return s;
  if (max === 1) return '…';
  return s.slice(0, max - 1) + '…';
}

/** Truncate keeping the *tail* (the distinguishing part of a box name like
 *  `…-78b94c78`), prepending `…` when it had to cut. */
function ellipsizeHead(s: string, max: number): string {
  if (max <= 0) return '';
  if (s.length <= max) return s;
  if (max === 1) return '…';
  return '…' + s.slice(s.length - (max - 1));
}

export function activityCell(b: SidebarBox): string {
  // Pending relay prompt outranks every other state — the user needs to
  // act before whatever the box is doing can continue.
  if (b.pendingPrompt) return '▲ prompt';
  // A checkpoint freezes the box; surface it over the activity state.
  if (b.checkpointing) return '◆ checkpoint';
  if (b.state !== 'running') return `[${b.state}]`;
  switch (b.claudeActivity) {
    case 'working':
      return '● working';
    case 'idle':
      return '○ idle';
    case 'waiting':
      return '◐ waiting';
    default:
      return '? unknown';
  }
}

/** Synthetic sidebar entry pinned at the top: selecting it opens the create
 *  menu. Carried in the compositor's box list like a real box (sentinel id),
 *  so selection/switch/highlight need no special-casing. */
export const NEW_BOX_ID = '__agentbox_new__';
export const NEW_BOX_LABEL = '+ New box';

/** Sidebar banner label (rendered into the rounded top border). */
export const SIDEBAR_HEADER = 'AgentBox';

/** Top border that simulates a rounded frame on the top + right only (no
 *  left/bottom, to save space): `╭─── AgentBox ─────…` filling exactly `w`.
 *  The matching rounded top-right corner (`╮`) is drawn by the compositor at
 *  the sidebar separator column. */
function topBorder(label: string, w: number): string {
  const lead = `╭─── ${label} `;
  if (lead.length >= w) return lead.slice(0, w);
  return lead + '─'.repeat(w - lead.length);
}
/** Lines `sidebarLines` reserves before the box rows (banner + blank). The
 *  compositor uses this to locate the selected box row for highlighting. */
export const SIDEBAR_HEADER_LINES = 2;

function fit(s: string, w: number): string {
  if (s.length === w) return s;
  if (s.length > w) return s.slice(0, w);
  return s + ' '.repeat(w - s.length);
}

/** `s` centered in a field of `w` columns (truncated if it doesn't fit). */
function center(s: string, w: number): string {
  if (s.length >= w) return s.slice(0, w);
  const pad = w - s.length;
  const leftPad = Math.floor(pad / 2);
  return ' '.repeat(leftPad) + s + ' '.repeat(pad - leftPad);
}

/** `basename` of an absolute project root, for the group header label. */
function projectLabel(project: string | undefined): string {
  if (!project) return '(no project)';
  const parts = project.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? project;
}

/** Strip the leading decoration Claude prepends to its terminal title (the
 *  spinner glyph, e.g. `✳ `) plus any leading symbols/asterisks/space, so the
 *  sidebar shows just the words. Falls back to the trimmed original if the
 *  title is all decoration. */
function stripTitleGlyph(s: string): string {
  const t = s.replace(/^[\s\p{S}*·]+/u, '');
  return t.length > 0 ? t : s.trim();
}

/**
 * Render one box row: `marker<num> <title|name> <status>`. The number and
 * the status are width-protected; the middle (title, else the box name with
 * its meaningful tail kept) flexes and ellipsizes so the status is never
 * eaten. Compact: no brackets, no glyph, single-char marker.
 */
function boxRow(b: SidebarBox, marker: string, w: number): string {
  const numStr = b.index != null ? `${b.index} ` : '';
  const status = activityCell(b);
  const left = `${marker}${numStr}`;
  const room = w - left.length - status.length - 1; // 1 = gap before status
  if (room <= 0) return fit(`${left}${status}`, w);
  const middle =
    b.state === 'running' && b.sessionTitle
      ? ellipsize(stripTitleGlyph(b.sessionTitle), room)
      : ellipsizeHead(b.name, room);
  // Left segment padded so the status sits flush right within `w`.
  return fit(`${left}${middle}`, w - status.length) + status;
}

/**
 * The sidebar region as exactly `h` lines, each exactly `w` columns, plus a
 * per-row ownership/style map. Pure — no ANSI positioning (the compositor
 * places it). Boxes are grouped under a ` ── <project> ── ` header (callers
 * pass them pre-sorted by project).
 */
export function sidebarLines(
  boxes: SidebarBox[],
  selectedId: string,
  w: number,
  h: number,
): SidebarRender {
  const lines: string[] = [topBorder(SIDEBAR_HEADER, w), fit('', w)];
  const rowOwner: (string | null)[] = [null, null];
  const headerRows: boolean[] = [true, false];
  const push = (line: string, owner: string | null, header: boolean): void => {
    lines.push(fit(line, w));
    rowOwner.push(owner);
    headerRows.push(header);
  };

  let prevProject: string | undefined;
  let seenGroup = false;
  for (const b of boxes) {
    const marker = b.id === selectedId ? '▸' : ' ';
    if (b.id === NEW_BOX_ID) {
      push(`${marker}${NEW_BOX_LABEL}`, b.id, false);
      continue;
    }
    if (!seenGroup || b.project !== prevProject) {
      push(center(` ── ${projectLabel(b.project)} ── `, w), null, true);
      prevProject = b.project;
      seenGroup = true;
    }
    push(boxRow(b, marker, w), b.id, false);
  }
  if (boxes.length === 0) push(' (no boxes)', null, false);
  while (lines.length < h) push('', null, false);
  return {
    lines: lines.slice(0, h),
    rowOwner: rowOwner.slice(0, h),
    headerRows: headerRows.slice(0, h),
  };
}

/**
 * Centered action menu for a running box with no Claude session.
 * Exactly `h` lines, each exactly `w` columns. Pure.
 */
export function menuLines(boxName: string, w: number, h: number): string[] {
  const body = [
    '',
    `  No Claude session in ${boxName}.`,
    '',
    '   [c]  Start Claude here',
    '   [s]  Open a shell',
    '',
    '  Ctrl+Option+↑/↓ switch · Ctrl-a then v/c/w/q (vnc/code/web/quit)',
  ];
  const top = Math.max(0, Math.floor((h - body.length) / 2));
  const out: string[] = [];
  for (let i = 0; i < h; i++) out.push(fit(body[i - top] ?? '', w));
  return out;
}

/**
 * Centered action menu for a non-running box (paused/stopped): resume +
 * destroy, with a two-step destroy confirm (the TUI can't show a prompt).
 * Exactly `h` lines, each exactly `w` columns. Pure.
 */
export function lifecycleMenuLines(
  boxName: string,
  state: 'paused' | 'stopped',
  confirmDestroy: boolean,
  w: number,
  h: number,
): string[] {
  const body = confirmDestroy
    ? [
        '',
        `  Destroy ${boxName}?`,
        '  This removes the container and its volumes.',
        '',
        '   [y]  Yes, destroy',
        '   [any other key]  Cancel',
      ]
    : [
        '',
        `  Box ${boxName} is ${state}.`,
        '',
        state === 'paused' ? '   [u]  Unpause' : '   [s]  Start',
        '   [d]  Destroy',
        '',
        '  Ctrl+Option+↑/↓ switch · Ctrl-a then q quit',
      ];
  const top = Math.max(0, Math.floor((h - body.length) / 2));
  const out: string[] = [];
  for (let i = 0; i < h; i++) out.push(fit(body[i - top] ?? '', w));
  return out;
}

/**
 * Centered menu for the synthetic "+ New box" entry. Exactly `h` lines, each
 * exactly `w` columns. Pure.
 */
export function createMenuLines(where: string, w: number, h: number): string[] {
  const body = [
    '',
    '  Create a new box',
    '',
    '   [c]  Create + launch Claude',
    '   [n]  Create only',
    '',
    `  in ${where}`,
    '',
    '  Ctrl+Option+↑/↓ switch · Ctrl-a then q quit',
  ];
  const top = Math.max(0, Math.floor((h - body.length) / 2));
  const out: string[] = [];
  for (let i = 0; i < h; i++) out.push(fit(body[i - top] ?? '', w));
  return out;
}

// Status-bar palette — matches the in-box tmux footer
// (`buildTmuxSessionArgs`): dark bar, blue brand block, dim-grey hints
// with white key chords.
/** The footer/sidebar background gray. Truecolor (not palette index 236) so
 *  it pins an exact RGB — terminals can remap/shade indexed colors per
 *  context, which made the sidebar and status bar look like different grays.
 *  Single source so the two regions can't drift. */
export const BAR_BG = '\x1b[48;2;48;48;48m';
const BAR_BASE = BAR_BG + '\x1b[38;5;250m';
const BAR_BRAND = '\x1b[48;5;39m\x1b[38;5;16m'; // blue block (not bold)
const BRAND_BOLD = '\x1b[1m'; // box name only
const BRAND_NOBOLD = '\x1b[22m';
const HINT_KEY = '\x1b[38;5;255m'; // white: the key chord
const HINT_TXT = '\x1b[38;5;245m'; // gray: labels + separators
const BAR_RESET = '\x1b[0m';

// [key chord, label]. Modifiers spelled out (no ⌥/^ glyphs); arrows use the
// ↑/↓ glyphs. Rendered as `KEYS: label` with the chord white, label gray.
const SWITCH_HINT: readonly [string, string] = ['Control+Option+↑/↓', 'switch'];
const HINT_GROUPS: ReadonlyArray<readonly [string, string]> = [
  SWITCH_HINT,
  ['Control+a c', 'code'],
  ['Control+a v', 'vnc'],
  ['Control+a w', 'web'],
  ['Control+a q', 'quit'],
];

/** Minimal hint tier when the bar is too narrow for the full `HINT_GROUPS`:
 *  box switching (always important) + the leader. Pressing `Ctrl-a` then
 *  expands to `ADVANCED_HINT_GROUPS` (the compositor swaps while the leader is
 *  active). */
export const COLLAPSED_HINT_GROUPS: ReadonlyArray<readonly [string, string]> = [
  SWITCH_HINT,
  ['Control+a', 'more'],
];

/** The expanded "which-key" chord menu shown while the Ctrl-a leader is
 *  pending — every chord, compact (`KEY: label`), reverts on the next key. */
export const ADVANCED_HINT_GROUPS: ReadonlyArray<readonly [string, string]> = [
  ['c', 'code'],
  ['v', 'vnc'],
  ['w', 'web'],
  ['s', 'stop'],
  ['p', 'pause'],
  ['d', 'destroy'],
  ['q', 'quit'],
];

/**
 * Status line, exactly `w` printable columns, colored to match the in-box tmux
 * footer (dark bar, blue ` agentbox ▸ … ` brand block on the left, dim-grey
 * shortcut hints on the right). `stateLabel` overrides the box's activity text
 * (used for `shell` / `menu` panes where claudeActivity would otherwise show a
 * misleading `unknown`). `fallbackGroups`, when given, is the narrow-bar tier
 * tried before brand-core-only — used to keep one essential chord pinned
 * (instead of the default dashboard `COLLAPSED_HINT_GROUPS`).
 */
export function statusLine(
  box: SidebarBox | undefined,
  w: number,
  stateLabel?: string,
  groups: ReadonlyArray<readonly [string, string]> = HINT_GROUPS,
  fallbackGroups?: ReadonlyArray<readonly [string, string]>,
): string {
  const state =
    stateLabel ?? (box ? (box.state === 'running' ? (box.claudeActivity ?? 'unknown') : box.state) : '');
  // "agentbox ▸ " stays normal weight; only the box name + state are bold.
  const brandPrefix = box ? ' agentbox ▸ ' : ' agentbox ';
  // Brand *core* (no title) — the width-protected segment. The title is the
  // lowest-priority segment: it only fills space left after brand + hints.
  const base = box ? `${box.name} (${state})` : '';
  const coreMain = box ? `${base} ` : '';
  const corePlain = brandPrefix + coreMain;

  const SEP = '   │   ';
  const renderHints = (
    g: ReadonlyArray<readonly [string, string]>,
  ): { plain: string; styled: string } => ({
    plain: g.map(([k, l]) => `${k}: ${l}`).join(SEP) + ' ',
    styled:
      g.map(([k, l]) => `${HINT_KEY}${k}${HINT_TXT}: ${l}`).join(`${HINT_TXT}${SEP}`) + ' ',
  });

  // Hint tier: shortcuts beat the title. Try the requested groups; if the
  // brand core + those hints overflow, fall back to the narrow-bar tier
  // (`fallbackGroups` if supplied, else the dashboard's minimal leader hint);
  // if even that overflows, render brand-core-only (title can never push the
  // box name off-screen).
  let hints: { plain: string; styled: string } | null = null;
  for (const g of [groups, fallbackGroups ?? COLLAPSED_HINT_GROUPS]) {
    const h = renderHints(g);
    if (corePlain.length + h.plain.length + 1 <= w) {
      hints = h;
      break;
    }
  }
  if (!hints) {
    return BAR_BASE + BAR_BRAND + fit(corePlain, w) + BAR_RESET;
  }

  // Title fills only the leftover, ellipsized; dropped entirely when there's
  // no meaningful room (≈ ` — ` + a few chars). Capped at 40 cols as before.
  const room = w - corePlain.length - hints.plain.length - 1;
  let titleSeg = '';
  if (box?.sessionTitle && room >= 7) {
    titleSeg = ` — ${ellipsize(box.sessionTitle, Math.min(40, room - 3))}`;
  }

  const leftPlain = brandPrefix + base + titleSeg + (box ? ' ' : '');
  const leftStyled =
    BAR_BRAND + brandPrefix + BRAND_BOLD + base + titleSeg + (box ? ' ' : '') + BRAND_NOBOLD;
  const gap = w - leftPlain.length - hints.plain.length;
  // brand block (name + title bold) → base bar → gap → white/gray hints.
  return (
    BAR_BASE +
    leftStyled +
    BAR_BASE +
    ' '.repeat(gap) +
    hints.styled +
    BAR_RESET
  );
}
