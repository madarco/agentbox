import { BAR_BG, statusLine, type SidebarBox } from '../dashboard/sidebar.js';
import type { PromptAskEvent } from '@agentbox/relay';

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
      /** Mode drives the state label: claude shows claude activity, shell
       *  shows `(shell)`. */
      mode: 'claude' | 'shell';
      /** Whether the session can be detached (tmux-backed). Drives the
       *  expanded leader menu + the pinned `Control+a q: detach` hint. */
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
const TXT = '\x1b[38;5;250m'; // dim gray body text
const SUBTLE = '\x1b[38;5;245m'; // very dim (Y/N hint)
const RESET = '\x1b[0m';
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
  ['Control+a q', 'detach'],
];
/** Narrow-bar fallback for a detachable session: drop the `Actions` hint
 *  first, but never the detach chord. */
const DETACH_PIN_HINTS: ReadonlyArray<readonly [string, string]> = [
  ['Control+a q', 'detach'],
];
/** Expanded which-key menu shown while the Ctrl+a leader is open. A
 *  detachable (tmux-backed) session also gets `q: detach`; a plain shell
 *  has nothing to detach from. */
const DETACHABLE_LEADER_HINTS: ReadonlyArray<readonly [string, string]> = [
  ['c', 'code'],
  ['v', 'vnc'],
  ['w', 'browser'],
  ['q', 'detach'],
];
const PLAIN_LEADER_HINTS: ReadonlyArray<readonly [string, string]> = [
  ['c', 'code'],
  ['v', 'vnc'],
  ['w', 'browser'],
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
      claudeActivity: state.claudeActivity,
      sessionTitle: state.sessionTitle,
    };
    const isClaude = state.mode === 'claude';
    const detachable = state.detachable ?? isClaude;
    // Shell mode has no claude activity to surface — passing `stateLabel`
    // overrides statusLine's default (which would otherwise show `(unknown)`
    // because `claudeActivity` is undefined and the container is running).
    const stateLabel = isClaude ? undefined : 'shell';
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
  // Prompt state: "[!] <message> [detail]  [y/N]"
  // The y/N hint is suffixed; we squeeze the message+detail into the space
  // left over (truncating message first, then detail).
  const def = state.prompt.defaultAnswer ?? 'n';
  const yn = def === 'y' ? '[Y/n]' : '[y/N]';
  const tag = ' [!] ';
  const sep = '  ';
  const hintW = ` ${yn} `.length;
  const inner = Math.max(0, cols - tag.length - hintW);
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
  return `${BAR_BG}${URGENT}${tag}${TXT}${padded}${SUBTLE} ${yn} ${RESET}`;
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
