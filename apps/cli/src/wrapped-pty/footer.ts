import { BAR_BG, statusLine, type SidebarBox } from '../dashboard/sidebar.js';
import type { PromptAskEvent } from '@agentbox/relay';
import type { ClaudeQuestionPayload } from '@agentbox/ctl';

/**
 * Footer rendering state. `idle` reuses the dashboard's `statusLine` shape
 * (brand chip + box name + optional session title + right-aligned hint);
 * `prompt` is shown while a `prompt-ask` event is being captured; `notice`
 * is an animated informational warning (e.g. checkpoint in progress);
 * `flash` is a transient confirmation after a Ctrl+a action fires.
 */
export type FooterState =
  | {
      kind: 'idle';
      boxName: string;
      /** Claude's tmux pane title (from BoxStatus.claude.sessionTitle).
       *  Undefined until the first status poll completes (or in shell mode). */
      sessionTitle?: string;
      /** Claude activity hint shown in `(<state>)` after the name. Same field
       *  the dashboard sidebar uses (`working` / `idle` / `waiting` / etc.). */
      claudeActivity?: string;
      /** Mode drives the state label: claude shows claude activity, the
       *  others show `(shell)` / `(codex)` / `(opencode)`. */
      mode: 'claude' | 'shell' | 'codex' | 'opencode';
      /** Whether the session can be detached (tmux-backed). Drives the
       *  expanded leader menu + the pinned `Control+a d: detach` hint. */
      detachable?: boolean;
      /** True while the Ctrl+a leader menu is open — swaps the collapsed
       *  `Control+a: Actions` hint for the expanded chord list. */
      leaderActive?: boolean;
    }
  | { kind: 'prompt'; prompt: PromptAskEvent }
  | {
      kind: 'notice';
      /** Warning text, e.g. "Checkpoint in progress — …". */
      message: string;
      /** Monotonic counter; the spinner glyph is `SPINNER_FRAMES[frame % len]`. */
      frame: number;
    }
  | {
      kind: 'flash';
      /** Transient confirmation text, e.g. "Opening noVNC viewer…". */
      message: string;
    };

/**
 * Spinner cycle for the `notice` footer. Solid half-filled circles, not
 * braille: braille glyphs read as a faint dot cluster on the yellow banner
 * (set vs unset dots are hard to tell apart), so the motion gets lost. The
 * rotating black half of these is unambiguous.
 */
export const SPINNER_FRAMES = ['◐', '◓', '◑', '◒'] as const;

const URGENT = '\x1b[38;5;220m\x1b[1m'; // bright yellow + bold (active prompt)
const TITLE = '\x1b[1m\x1b[38;5;253m'; // bold near-white (prompt band title)
const TXT = '\x1b[38;5;250m'; // dim gray body text
const SUBTLE = '\x1b[38;5;245m'; // very dim (detail / Y/N hint)
const RESET = '\x1b[0m';
const UNDERLINE = '\x1b[4m'; // emphasizes the default answer inside the chip
const NO_UNDERLINE = '\x1b[24m'; // ends underline without dropping the chip bg
// Agent-question accent: cyan + bold, matching the dashboard sidebar's
// "awaiting" hue — distinct from URGENT (relay prompt) so the two readings
// don't collide when both could in principle stack.
const QUESTION_ACCENT = '\x1b[38;5;51m\x1b[1m';
// Notice footer = a full-width warning banner: bright yellow background with
// near-black bold text. High contrast so the "box is frozen" state is
// unmissable — deliberately louder than the dim-on-dark idle/prompt bars.
const NOTICE_BG = '\x1b[48;5;220m'; // bright yellow background
const NOTICE_FG = '\x1b[38;5;16m\x1b[1m'; // near-black + bold text
// Flash footer = a calm one-line confirmation on the normal dark bar.
const FLASH_FG = '\x1b[38;5;150m\x1b[1m'; // soft green + bold

/** Collapsed idle hint (plain `--no-tmux` shell) — the leader is hidden
 *  behind one chord. */
const COLLAPSED_HINTS_PLAIN: ReadonlyArray<readonly [string, string]> = [
  ['Control+a', 'Actions'],
];
/** Collapsed idle hint (detachable session) — the detach chord stays pinned
 *  on the right even while the actions menu is closed. */
const COLLAPSED_HINTS_DETACHABLE: ReadonlyArray<readonly [string, string]> = [
  ['Control+a', 'Actions'],
  ['Control+a d', 'detach'],
];
/** Narrow-bar fallback for a detachable session: drop the `Actions` hint
 *  first, but never the detach chord. */
const DETACH_PIN_HINTS: ReadonlyArray<readonly [string, string]> = [
  ['Control+a d', 'detach'],
];
/** Expanded which-key menu shown while the Ctrl+a leader is open. A
 *  detachable (tmux-backed) session also gets `d: detach`; a plain shell
 *  has nothing to detach from. */
const DETACHABLE_LEADER_HINTS: ReadonlyArray<readonly [string, string]> = [
  ['c', 'code'],
  ['s', 'screen'],
  ['u', 'url'],
  ['t', 'shell'],
  ['d', 'detach'],
];
const PLAIN_LEADER_HINTS: ReadonlyArray<readonly [string, string]> = [
  ['c', 'code'],
  ['s', 'screen'],
  ['u', 'url'],
  ['t', 'shell'],
];

/**
 * Truncate `s` to exactly `width` visible columns, padding with spaces when
 * shorter. ANSI SGR sequences must NOT be present in the input.
 */
function padTo(visible: string, width: number): string {
  if (visible.length === width) return visible;
  if (visible.length > width) {
    if (width <= 1) return visible.slice(0, width);
    return visible.slice(0, width - 1) + '…';
  }
  return visible + ' '.repeat(width - visible.length);
}

/**
 * High-contrast answer chip for a confirm prompt: the keys spelled out on a
 * bright-yellow background (the same NOTICE treatment used for the "box
 * frozen" banner) so the y/N choice is unmissable. The default answer is
 * underlined. Returns the styled string plus its visible column width — the
 * ANSI codes don't count toward layout, so callers need the plain width.
 */
function answerChip(defaultAnswer: 'y' | 'n' | undefined): { ansi: string; width: number } {
  const yesKey = 'y Yes';
  const noKey = 'n No';
  const sep = ' · ';
  const yesIsDefault = defaultAnswer === 'y';
  const yes = yesIsDefault ? `${UNDERLINE}${yesKey}${NO_UNDERLINE}` : yesKey;
  const no = yesIsDefault ? noKey : `${UNDERLINE}${noKey}${NO_UNDERLINE}`;
  const ansi = `${NOTICE_BG}${NOTICE_FG} ${yes}${sep}${no} ${RESET}`;
  // Width derived from the plain (underline-free) shape so it stays correct
  // if the wording changes.
  const width = ` ${yesKey}${sep}${noKey} `.length;
  return { ansi, width };
}

/**
 * Render the footer row as a single ANSI string. Caller positions the
 * cursor at the last row, col 0 before writing, and restores it afterwards.
 * Always ends with SGR reset so the inner pty's next byte starts clean.
 */
export function renderFooter(state: FooterState, cols: number): string {
  if (cols <= 0) return '';
  if (state.kind === 'idle') {
    const sidebarBox: SidebarBox = {
      id: '', // unused by statusLine
      name: state.boxName,
      state: 'running', // we're attached, so the container is up
      activity: state.claudeActivity,
      sessionTitle: state.sessionTitle,
    };
    const isClaude = state.mode === 'claude';
    const detachable = state.detachable ?? isClaude;
    // Shell/codex modes have no claude activity to surface — passing
    // `stateLabel` overrides statusLine's default (which would otherwise show
    // `(unknown)` because `claudeActivity` is undefined and the container is
    // running).
    const stateLabel = isClaude ? undefined : state.mode === 'shell' ? 'shell' : state.mode;
    if (state.leaderActive) {
      const leaderHints = detachable ? DETACHABLE_LEADER_HINTS : PLAIN_LEADER_HINTS;
      return statusLine(sidebarBox, cols, stateLabel, leaderHints);
    }
    // Collapsed: a detachable session keeps the detach chord pinned on the
    // right (its narrow-bar fallback drops `Actions` first, never `detach`).
    const collapsed = detachable ? COLLAPSED_HINTS_DETACHABLE : COLLAPSED_HINTS_PLAIN;
    const fallback = detachable ? DETACH_PIN_HINTS : undefined;
    return statusLine(sidebarBox, cols, stateLabel, collapsed, fallback);
  }
  if (state.kind === 'flash') {
    // Flash state: a brief "<arrow> <message>" confirmation on the dark bar.
    const prefix = ' ▸ '; // ▸
    const inner = Math.max(0, cols - prefix.length);
    const message = padTo(state.message, inner);
    return `${BAR_BG}${FLASH_FG}${prefix}${TXT}${message}${RESET}`;
  }
  if (state.kind === 'notice') {
    // Notice state: "<spinner> <message>" rendered as a full-width
    // high-contrast yellow warning banner. The spinner reassures the user
    // the box is busy, not stuck.
    const spinner = SPINNER_FRAMES[state.frame % SPINNER_FRAMES.length]!;
    const prefix = ` ${spinner} `;
    const inner = Math.max(0, cols - prefix.length);
    const message = padTo(state.message, inner);
    return `${NOTICE_BG}${NOTICE_FG}${prefix}${message}${RESET}`;
  }
  // Prompt state (narrow-terminal fallback): "[!] <message> [detail] <chip>".
  // The answer chip is suffixed; we squeeze the message+detail into the space
  // left over (truncating message first, then detail).
  const chip = answerChip(state.prompt.defaultAnswer);
  const tag = ' [!] ';
  const sep = '  ';
  const inner = Math.max(0, cols - tag.length - chip.width);
  const detailRaw = state.prompt.detail ?? '';
  let message = state.prompt.message;
  let detail = detailRaw;
  const messageBudget = Math.max(8, inner - (detail.length > 0 ? sep.length + 8 : 0));
  if (message.length > messageBudget) {
    message = message.slice(0, Math.max(0, messageBudget - 1)) + '…';
  }
  const usedByMessage = message.length;
  const detailBudget = Math.max(0, inner - usedByMessage - sep.length);
  if (detail.length > detailBudget) {
    detail = detailBudget <= 1 ? '' : detail.slice(0, detailBudget - 1) + '…';
  }
  const middlePlain = detail.length > 0 ? `${message}${sep}${detail}` : message;
  const padded = padTo(middlePlain, inner);
  return `${BAR_BG}${URGENT}${tag}${TXT}${padded}${RESET}${chip.ansi}`;
}

/**
 * ANSI sequence to move the cursor to (row, col) — 1-based, terminal convention.
 */
export function cursorMoveTo(row: number, col: number): string {
  return `\x1b[${String(row)};${String(col)}H`;
}

export const CURSOR_SAVE = '\x1b7';
export const CURSOR_RESTORE = '\x1b8';

/**
 * Synchronized output toggles (DECSET/DECRST 2026). Wrap a multi-write
 * footer paint so terminals that support it commit one atomic frame.
 */
export const SYNC_BEGIN = '\x1b[?2026h';
export const SYNC_END = '\x1b[?2026l';

/**
 * Alert-band state: the surface shown directly above the (idle) footer when
 * a box needs the user's attention. The band is fixed at 3 rows; the inner
 * PTY is resized down by 3 rows so the band never overlaps agent output.
 *
 * - `prompt`: a relay confirm prompt (hard-blocks an in-box RPC).
 * - `notice`: an informational warning (checkpoint/snapshot in progress);
 *   `frame` advances the spinner glyph.
 * - `question`: the agent's `AskUserQuestion` payload (claude.state ===
 *   'question'); shown as header + question text + option labels.
 */
export type AlertBandState =
  | { kind: 'prompt'; prompt: PromptAskEvent }
  | { kind: 'notice'; message: string; frame: number }
  | { kind: 'question'; question: ClaudeQuestionPayload };

/** Default band height; both TUIs reserve this many rows above the footer. */
export const ALERT_BAND_ROWS = 3;

function blankBar(cols: number, bg: string): string {
  return `${bg}${' '.repeat(Math.max(0, cols))}${RESET}`;
}

function renderPromptBand(prompt: PromptAskEvent, cols: number, rows: number): string[] {
  const tag = ' [!] ';
  const indent = ' '.repeat(tag.length);
  const contW = Math.max(0, cols - indent.length);

  // Row 1: "[!] TITLE ............ <chip>". The bold title (the relay action,
  // e.g. GIT PUSH) flags what needs approval; the high-contrast answer chip
  // sits right next to it so the keys are spotted immediately — not stranded
  // dim in the bottom-right corner.
  const chip = answerChip(prompt.defaultAnswer);
  const title = (prompt.context?.command ?? 'confirm').toUpperCase();
  const titleW = Math.max(0, cols - tag.length - chip.width);
  const titlePadded = padTo(title, titleW);
  const line1 = `${BAR_BG}${URGENT}${tag}${TITLE}${titlePadded}${RESET}${chip.ansi}`;

  // Row 2: the question itself, full width.
  const line2 = `${BAR_BG}${TXT}${indent}${padTo(prompt.message, contW)}${RESET}`;

  // Row 3: optional detail/sub-message, dimmer.
  const line3 = `${BAR_BG}${SUBTLE}${indent}${padTo(prompt.detail ?? '', contW)}${RESET}`;

  return [line1, line2, line3].slice(0, rows);
}

function renderNoticeBand(
  message: string,
  frame: number,
  cols: number,
  rows: number,
): string[] {
  const spinner = SPINNER_FRAMES[frame % SPINNER_FRAMES.length]!;
  const prefix = ` ${spinner} `;
  const indent = ' '.repeat(prefix.length);
  const firstW = Math.max(0, cols - prefix.length);
  const contW = Math.max(0, cols - indent.length);

  const out: string[] = [];
  let i = 0;
  for (let r = 0; r < rows; r++) {
    const isLast = r === rows - 1;
    const w = r === 0 ? firstW : contW;
    let cell: string;
    if (i >= message.length) {
      cell = ' '.repeat(w);
    } else if (isLast) {
      cell = padTo(message.slice(i), w);
      i = message.length;
    } else {
      cell = message.slice(i, i + w).padEnd(w);
      i += w;
    }
    const lead = r === 0 ? prefix : indent;
    out.push(`${NOTICE_BG}${NOTICE_FG}${lead}${cell}${RESET}`);
  }
  return out;
}

function renderQuestionBand(
  payload: ClaudeQuestionPayload,
  cols: number,
  rows: number,
): string[] {
  const q = payload.questions[0];
  if (!q) return Array.from({ length: rows }, () => blankBar(cols, BAR_BG));

  const tag = ' [?] ';
  const indent = ' '.repeat(tag.length);
  const innerW = Math.max(0, cols - tag.length);
  const contW = Math.max(0, cols - indent.length);

  const header = q.header && q.header.trim().length > 0 ? q.header : 'Question';
  const headerPadded = padTo(header, innerW);
  const line1 = `${BAR_BG}${QUESTION_ACCENT}${tag}${TXT}${headerPadded}${RESET}`;

  const questionText = padTo(q.question, contW);
  const line2 = `${BAR_BG}${TXT}${indent}${questionText}${RESET}`;

  const optLabels = q.options.map((o) => o.label).join(' · ');
  const optsLine = optLabels.length > 0 ? `options: ${optLabels}` : '';
  const optsPadded = padTo(optsLine, contW);
  const line3 = `${BAR_BG}${SUBTLE}${indent}${optsPadded}${RESET}`;

  return [line1, line2, line3].slice(0, rows);
}

/**
 * Render the 3-row alert band as an array of `rows` ANSI strings. Each
 * element is a full-width painted row (background tint reset at EOL).
 * Callers position the cursor at each row's column 1 and write the line
 * inside the same synchronized-output wrap as the footer.
 */
export function renderAlertBand(
  state: AlertBandState,
  cols: number,
  rows: number = ALERT_BAND_ROWS,
): string[] {
  if (cols <= 0 || rows <= 0) return Array.from({ length: Math.max(0, rows) }, () => '');
  if (state.kind === 'prompt') return renderPromptBand(state.prompt, cols, rows);
  if (state.kind === 'notice') return renderNoticeBand(state.message, state.frame, cols, rows);
  return renderQuestionBand(state.question, cols, rows);
}
