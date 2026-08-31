import type { Rect } from './layout.js';

/**
 * A terminal cell, abstracted from @xterm/headless so the renderer stays pure
 * and unit-testable with a hand-rolled grid (no xterm, no docker).
 */
export interface CellLike {
  /** 1 normal, 2 wide (CJK), 0 = trailing half of a wide char (skip). */
  width: number;
  /** Glyph(s); '' for a never-written cell (render as space). */
  chars: string;
  fg: ColorSpec;
  bg: ColorSpec;
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
  inverse: boolean;
  invisible: boolean;
  strike: boolean;
}

export type ColorSpec =
  | { kind: 'default' }
  | { kind: 'palette'; n: number }
  | { kind: 'rgb'; rgb: number };

export interface ScreenSnapshot {
  cols: number;
  rows: number;
  cursor: { x: number; y: number; visible: boolean };
  cell(x: number, y: number): CellLike;
}

const RESET = '\x1b[0m';

function fgParams(c: ColorSpec): string {
  if (c.kind === 'default') return '39';
  if (c.kind === 'palette') {
    const n = c.n;
    if (n < 8) return String(30 + n);
    if (n < 16) return String(90 + (n - 8));
    return `38;5;${String(n)}`;
  }
  return `38;2;${String((c.rgb >> 16) & 0xff)};${String((c.rgb >> 8) & 0xff)};${String(c.rgb & 0xff)}`;
}

function bgParams(c: ColorSpec): string {
  if (c.kind === 'default') return '49';
  if (c.kind === 'palette') {
    const n = c.n;
    if (n < 8) return String(40 + n);
    if (n < 16) return String(100 + (n - 8));
    return `48;5;${String(n)}`;
  }
  return `48;2;${String((c.rgb >> 16) & 0xff)};${String((c.rgb >> 8) & 0xff)};${String(c.rgb & 0xff)}`;
}

/** Full SGR (always reset-prefixed) for a cell. Run-length collapsed by caller. */
export function sgrFor(cell: CellLike): string {
  const parts = ['0', fgParams(cell.fg), bgParams(cell.bg)];
  if (cell.bold) parts.push('1');
  if (cell.dim) parts.push('2');
  if (cell.italic) parts.push('3');
  if (cell.underline) parts.push('4');
  if (cell.inverse) parts.push('7');
  if (cell.invisible) parts.push('8');
  if (cell.strike) parts.push('9');
  return `\x1b[${parts.join(';')}m`;
}

/**
 * Compose one screen row into a payload string: SGR runs + glyphs, exactly
 * `cols` columns wide (NullCells render as spaces, so the row self-pads).
 * Emits a new SGR only when it changes from the previous cell (run-length).
 */
export function composeRow(snap: ScreenSnapshot, y: number): string {
  let out = '';
  let lastSgr = '';
  for (let x = 0; x < snap.cols; x++) {
    const cell = snap.cell(x, y);
    if (cell.width === 0) continue; // trailing half of a wide glyph
    const sgr = sgrFor(cell);
    if (sgr !== lastSgr) {
      out += sgr;
      lastSgr = sgr;
    }
    out += cell.chars === '' ? ' ' : cell.chars;
  }
  return out + RESET;
}

function cursorTo(row0: number, col0: number): string {
  // ANSI is 1-based.
  return `\x1b[${String(row0 + 1)};${String(col0 + 1)}H`;
}

export interface FrameResult {
  /** Bytes to write to the host terminal (may be empty if nothing changed). */
  out: string;
  /** New per-pane-row payload cache for the next diff. */
  rows: string[];
}

/**
 * Diff `snap` against the previous frame's row cache and produce the minimal
 * write to update the right-pane `rect`. Pass `prev = null` to force a full
 * repaint (initial draw / post-resize).
 */
export function diffFrame(prev: string[] | null, snap: ScreenSnapshot, rect: Rect): FrameResult {
  const h = Math.min(rect.h, snap.rows);
  const rows: string[] = new Array<string>(h);
  let out = '\x1b[?25l'; // hide cursor while painting to avoid streaking
  for (let i = 0; i < h; i++) {
    const payload = composeRow(snap, i);
    rows[i] = payload;
    if (prev && prev[i] === payload) continue;
    out += cursorTo(rect.y + i, rect.x) + RESET + payload + RESET;
  }
  if (snap.cursor.visible) {
    const cy = Math.min(Math.max(snap.cursor.y, 0), h - 1);
    const cx = Math.min(Math.max(snap.cursor.x, 0), rect.w - 1);
    out += cursorTo(rect.y + cy, rect.x + cx) + '\x1b[?25h';
  }
  return { out, rows };
}
