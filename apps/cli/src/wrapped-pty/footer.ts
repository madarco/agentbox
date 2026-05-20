import { BAR_BG, statusLine, type SidebarBox } from '../dashboard/sidebar.js';
import type { PromptAskEvent } from '@agentbox/relay';

/**
 * Footer rendering state. `idle` reuses the dashboard's `statusLine` shape
 * (brand chip + box name + optional session title + right-aligned hint);
 * `prompt` is shown while a `prompt-ask` event is being captured.
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
      /** Mode drives the right-aligned hint: claude → `Control+a q: detach`;
       *  shell → no hints (no leader chord in plain bash). */
      mode: 'claude' | 'shell';
    }
  | { kind: 'prompt'; prompt: PromptAskEvent };

const URGENT = '\x1b[38;5;220m\x1b[1m'; // bright yellow + bold (active prompt)
const TXT = '\x1b[38;5;250m'; // dim gray body text
const SUBTLE = '\x1b[38;5;245m'; // very dim (Y/N hint)
const RESET = '\x1b[0m';

/** Hint groups passed to `statusLine`. Claude mode shows just the detach
 *  chord — no `code`/`vnc`/`web` shortcuts here (the wrapper isn't the
 *  dashboard; those wouldn't do anything). */
const CLAUDE_IDLE_HINTS: ReadonlyArray<readonly [string, string]> = [
  ['Control+a q', 'detach'],
];
const SHELL_IDLE_HINTS: ReadonlyArray<readonly [string, string]> = [];

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
    const hints = state.mode === 'claude' ? CLAUDE_IDLE_HINTS : SHELL_IDLE_HINTS;
    // Shell mode has no claude activity to surface — passing `stateLabel`
    // overrides statusLine's default (which would otherwise show `(unknown)`
    // because `claudeActivity` is undefined and the container is running).
    const stateLabel = state.mode === 'shell' ? 'shell' : undefined;
    return statusLine(sidebarBox, cols, stateLabel, hints);
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
