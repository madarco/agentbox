/**
 * `tableSelect`: one interactive screen holding a short list of actions above a
 * bordered table whose rows are selectable too. Up/Down (or k/j) move a single
 * highlight across both, Enter picks, Esc or q quits, Ctrl-C cancels.
 *
 * Built on `@clack/core`'s `Prompt` so it shares clack's raw-mode, redraw and
 * resize handling (and its look: the same gutter and symbols as `select`).
 * Everything that decides what is drawn or where the cursor goes is a pure
 * function below the class, which is what the unit tests exercise.
 */
import { Prompt } from '@clack/core';
import pc0, { createColors } from 'picocolors';
import type { Readable, Writable } from 'node:stream';

export type TableTone = 'red' | 'yellow' | 'green' | 'cyan' | 'dim';

export interface TableAction<V extends string> {
  value: V;
  label: string;
  hint?: string;
}

export interface TableRow<V extends string> {
  value: V;
  cells: readonly string[];
  /** Per cell, aligned with `cells`; unset cells use the default color. */
  tones?: readonly (TableTone | undefined)[];
}

export interface TableSelectSpec<V extends string> {
  title: string;
  /** Shown dim after the title, e.g. a count. */
  subtitle?: string;
  actions: readonly TableAction<V>[];
  headers: readonly string[];
  rows: readonly TableRow<V>[];
  /** Shown in place of the rows when there are none. */
  emptyText?: string;
  /** The action or row value to start on (the last pick, after a refresh). */
  cursorAt?: V;
}

export type TableSelectResult<V extends string> =
  | { kind: 'action'; value: V }
  | { kind: 'row'; value: V }
  /** Esc or q: the user is done. */
  | { kind: 'quit' }
  /** Ctrl-C. */
  | { kind: 'cancel' };

// ---- width ------------------------------------------------------------------

const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
const CONTROL = /[\x00-\x1f\x7f-\x9f]/g;
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

function isWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  );
}

function graphemeWidth(g: string): number {
  if (/^\p{M}+$/u.test(g)) return 0;
  const cp = g.codePointAt(0) ?? 0;
  if (isWide(cp)) return 2;
  // A text-default pictograph turned into an emoji by VS16 (e.g. U+2764 U+FE0F).
  if (g.includes('️') && /\p{Extended_Pictographic}/u.test(g)) return 2;
  return 1;
}

/** Terminal columns `s` takes: ANSI-free, CJK and emoji count two. */
export function textWidth(s: string): number {
  let w = 0;
  for (const { segment } of segmenter.segment(s.replace(ANSI, ''))) w += graphemeWidth(segment);
  return w;
}

/** A cell's text on one line: no escapes, no control characters. */
export function cleanCell(s: string): string {
  return s.replace(ANSI, '').replace(CONTROL, ' ');
}

/** `s` cut to `width` columns, with an ellipsis when anything was cut. */
export function truncate(s: string, width: number): string {
  if (width <= 0) return '';
  if (textWidth(s) <= width) return s;
  let out = '';
  let w = 0;
  for (const { segment } of segmenter.segment(s)) {
    const gw = graphemeWidth(segment);
    if (w + gw > width - 1) break;
    out += segment;
    w += gw;
  }
  return out + '…';
}

/** `s` truncated or space-padded to exactly `width` columns. */
export function fit(s: string, width: number): string {
  const t = truncate(s, width);
  return t + ' '.repeat(Math.max(0, width - textWidth(t)));
}

/**
 * Column widths that fit `budget`: the natural (widest cell) width each, then
 * the widest column shrunk one column at a time until the table fits, never
 * below `min` (or its natural width when that is smaller).
 */
export function fitColumns(natural: readonly number[], budget: number, min = 4): number[] {
  const widths = [...natural];
  const floor = natural.map((n) => Math.min(n, min));
  let total = widths.reduce((a, b) => a + b, 0);
  while (total > budget) {
    let widest = -1;
    for (let i = 0; i < widths.length; i++) {
      if (widths[i]! > floor[i]! && (widest < 0 || widths[i]! > widths[widest]!)) widest = i;
    }
    if (widest < 0) break;
    widths[widest]!--;
    total--;
  }
  return widths;
}

// ---- cursor ------------------------------------------------------------------

export type TableKey =
  | 'up'
  | 'down'
  | 'pageUp'
  | 'pageDown'
  | 'home'
  | 'end'
  | 'submit'
  | 'quit'
  | 'cancel';

/** A readline keypress, mapped to what the table does with it. */
export function keyOf(
  key: { name?: string; ctrl?: boolean; sequence?: string } | undefined,
): TableKey | undefined {
  if (!key) return undefined;
  if (key.ctrl && key.name === 'c') return 'cancel';
  if (key.sequence === '\x03') return 'cancel';
  if (key.ctrl) return undefined;
  switch (key.name) {
    case 'up':
    case 'k':
      return 'up';
    case 'down':
    case 'j':
      return 'down';
    case 'pageup':
      return 'pageUp';
    case 'pagedown':
      return 'pageDown';
    case 'home':
      return 'home';
    case 'end':
      return 'end';
    case 'return':
    case 'enter':
      return 'submit';
    case 'escape':
    case 'q':
      return 'quit';
    default:
      return undefined;
  }
}

export interface CursorState {
  /** Index over actions then rows. */
  cursor: number;
  /** The first visible row. */
  scroll: number;
}

/** The state after `key` (submit/quit/cancel leave it as is). */
export function moveCursor(
  state: CursorState,
  key: TableKey,
  sizes: { actions: number; rows: number; visible: number },
): CursorState {
  const total = sizes.actions + sizes.rows;
  if (total === 0) return state;
  const page = Math.max(1, sizes.visible - 1);
  let c = state.cursor;
  switch (key) {
    case 'up':
      c = c === 0 ? total - 1 : c - 1;
      break;
    case 'down':
      c = c === total - 1 ? 0 : c + 1;
      break;
    case 'pageUp':
      c = Math.max(0, c - page);
      break;
    case 'pageDown':
      c = Math.min(total - 1, c + page);
      break;
    case 'home':
      c = 0;
      break;
    case 'end':
      c = total - 1;
      break;
    default:
      return state;
  }
  return {
    cursor: c,
    scroll: scrollFor(state.scroll, c - sizes.actions, sizes.visible, sizes.rows),
  };
}

/** The first visible row so the cursor row (`row`, <0 = on an action) shows. */
export function scrollFor(scroll: number, row: number, visible: number, rows: number): number {
  const maxScroll = Math.max(0, rows - visible);
  let s = Math.min(Math.max(0, scroll), maxScroll);
  if (row < 0) return s;
  if (row < s) s = row;
  else if (row >= s + visible) s = row - visible + 1;
  return s;
}

// ---- render ------------------------------------------------------------------

export interface RenderOptions {
  columns: number;
  rows: number;
  color: boolean;
  state: 'active' | 'submit' | 'quit' | 'cancel';
}

const GUTTER = 3;

/** Lines the frame spends besides the visible rows (see `renderTableSelect`). */
function fixedLines(spec: Pick<TableSelectSpec<string>, 'actions'>, overflow: boolean): number {
  // bar, title, top border, actions, sep, header, sep, bottom, [more], help, end
  return 9 + spec.actions.length + (overflow ? 1 : 0) - (spec.actions.length === 0 ? 1 : 0);
}

/** How many table rows fit a terminal `termRows` tall. */
export function visibleRows(
  spec: Pick<TableSelectSpec<string>, 'actions' | 'rows'>,
  termRows: number,
): number {
  // One line of slack: a frame as tall as the screen scrolls it, and clack's
  // redraw can't move the cursor above the top.
  const all = termRows - 1 - fixedLines(spec, false);
  if (spec.rows.length <= all) return Math.max(1, spec.rows.length);
  return Math.max(1, termRows - 1 - fixedLines(spec, true));
}

/** The whole frame for `state`, as clack's `render` returns it. */
export function renderTableSelect<V extends string>(
  spec: TableSelectSpec<V>,
  cur: CursorState,
  opts: RenderOptions,
): string {
  const pc = createColors(opts.color);
  const bar = pc.gray('│');
  const tone = (t: TableTone | undefined, s: string): string =>
    t === 'red'
      ? pc.red(s)
      : t === 'yellow'
        ? pc.yellow(s)
        : t === 'green'
          ? pc.green(s)
          : t === 'cyan'
            ? pc.cyan(s)
            : t === 'dim'
              ? pc.dim(s)
              : s;
  const title = `${spec.title}${spec.subtitle ? `  ${pc.dim(spec.subtitle)}` : ''}`;

  if (opts.state !== 'active') {
    const picked = pickedLabel(spec, cur.cursor);
    if (opts.state === 'submit') {
      return `${bar}\n${pc.green('◇')}  ${title}\n${bar}  ${pc.dim(picked)}`;
    }
    if (opts.state === 'quit') return `${bar}\n${pc.green('◇')}  ${title}`;
    return `${bar}\n${pc.red('■')}  ${title}\n${bar}  ${pc.strikethrough(pc.dim('cancelled'))}`;
  }

  const n = spec.headers.length;
  const natural = spec.headers.map((h, i) =>
    Math.max(textWidth(h), ...spec.rows.map((r) => textWidth(cleanCell(r.cells[i] ?? '')))),
  );
  // The line is GUTTER + sum(widths) + 3n + 3 wide (see the segment widths
  // below); keep one column spare so a line never sits on the last column.
  const budget = Math.max(n, opts.columns - GUTTER - 1 - (3 * n + 3));
  const widths = fitColumns(natural, budget);
  // Widen the last column so action labels and hints fit, as far as the budget allows.
  const actionNeed = Math.max(
    0,
    ...spec.actions.map(
      (a) => textWidth(cleanCell(a.label)) + (a.hint ? textWidth(cleanCell(a.hint)) + 2 : 0),
    ),
  );
  const tableInner = (): number => widths.reduce((a, b) => a + b, 0) + 3 * n + 1;
  const grow = Math.min(actionNeed + 4 - tableInner(), budget - widths.reduce((a, b) => a + b, 0));
  if (grow > 0) widths[n - 1]! += grow;
  // seg0 = " › " + w0 + " ", the rest " " + w + " ".
  const segs = widths.map((w, i) => (i === 0 ? w + 4 : w + 2));
  const inner = segs.reduce((a, b) => a + b, 0) + n - 1;

  const border = (l: string, mid: string, r: string, junctions: boolean): string =>
    pc.dim(l + (junctions ? segs.map((s) => '─'.repeat(s)).join(mid) : '─'.repeat(inner)) + r);
  const vbar = pc.dim('│');
  const pointer = (on: boolean): string => (on ? pc.cyan('›') : ' ');

  const lines: string[] = [bar, `${pc.cyan('◆')}  ${title}`];
  const body: string[] = [];
  const hasActions = spec.actions.length > 0;
  body.push(border('┌', '┬', '┐', !hasActions));
  spec.actions.forEach((a, i) => {
    const on = cur.cursor === i;
    const label = truncate(cleanCell(a.label), inner - 4);
    const room = inner - 4 - textWidth(label);
    const hint = a.hint && room > 4 ? truncate(cleanCell(a.hint), room - 2) : '';
    const text = on ? pc.cyan(label) : label;
    const pad = ' '.repeat(Math.max(0, room - (hint ? textWidth(hint) + 2 : 0)));
    body.push(`${vbar} ${pointer(on)} ${text}${hint ? `  ${pc.dim(hint)}` : ''}${pad} ${vbar}`);
  });

  if (spec.rows.length === 0) {
    if (hasActions) body.push(border('├', '─', '┤', false));
    const empty = fit(cleanCell(spec.emptyText ?? 'Nothing here.'), inner - 2);
    body.push(`${vbar} ${pc.dim(empty)} ${vbar}`);
    body.push(border('└', '─', '┘', false));
  } else {
    const visible = visibleRows(spec, opts.rows);
    const scroll = scrollFor(
      cur.scroll,
      cur.cursor - spec.actions.length,
      visible,
      spec.rows.length,
    );
    if (hasActions) body.push(border('├', '┬', '┤', true));
    const cellLine = (cells: string[], on: boolean): string =>
      `${vbar} ${pointer(on)} ${cells.join(` ${vbar} `)} ${vbar}`;
    body.push(
      cellLine(
        spec.headers.map((h, i) => pc.bold(fit(cleanCell(h), widths[i]!))),
        false,
      ),
    );
    body.push(border('├', '┼', '┤', true));
    const end = Math.min(spec.rows.length, scroll + visible);
    for (let r = scroll; r < end; r++) {
      const row = spec.rows[r]!;
      const on = cur.cursor === spec.actions.length + r;
      const cells = widths.map((w, i) => {
        const s = fit(cleanCell(row.cells[i] ?? ''), w);
        const t = row.tones?.[i];
        return on ? pc.bold(t ? tone(t, s) : pc.cyan(s)) : tone(t, s);
      });
      body.push(cellLine(cells, on));
    }
    body.push(border('└', '┴', '┘', true));
    if (spec.rows.length > visible) {
      const above = scroll;
      const below = spec.rows.length - end;
      const more = [
        above > 0 ? `↑ ${String(above)} more` : '',
        below > 0 ? `↓ ${String(below)} more` : '',
      ]
        .filter(Boolean)
        .join('  ');
      body.push(pc.dim(` ${more || `${String(spec.rows.length)} rows`}`));
    }
  }
  for (const l of body) lines.push(`${bar}  ${l}`);
  lines.push(`${bar}  ${pc.dim('↑/↓ move · enter select · esc/q quit')}`);
  lines.push(pc.gray('└'));
  return lines.join('\n');
}

function pickedLabel<V extends string>(spec: TableSelectSpec<V>, cursor: number): string {
  const a = spec.actions[cursor];
  if (a) return cleanCell(a.label);
  const r = spec.rows[cursor - spec.actions.length];
  return r ? cleanCell(r.cells[0] ?? r.value) : '';
}

/** The cursor index of `value` (an action first, then a row), or 0. */
export function indexOf<V extends string>(spec: TableSelectSpec<V>, value: V | undefined): number {
  if (value === undefined) return 0;
  const a = spec.actions.findIndex((x) => x.value === value);
  if (a >= 0) return a;
  const r = spec.rows.findIndex((x) => x.value === value);
  return r >= 0 ? spec.actions.length + r : 0;
}

// ---- prompt ------------------------------------------------------------------

interface KeypressEmitter {
  on(event: 'keypress', cb: (ch: string | undefined, key: KeyInfo | undefined) => void): unknown;
  off(event: 'keypress', cb: (ch: string | undefined, key: KeyInfo | undefined) => void): unknown;
}
interface KeyInfo {
  name?: string;
  ctrl?: boolean;
  sequence?: string;
}

class TableSelectPrompt<V extends string> extends Prompt {
  cur: CursorState;
  outcome: 'submit' | 'quit' | 'cancel' | undefined;

  constructor(
    readonly spec: TableSelectSpec<V>,
    io: { input?: Readable; output?: Writable },
  ) {
    super(
      {
        ...io,
        render(this: Omit<TableSelectPrompt<V>, 'prompt'>) {
          const out = (
            this as unknown as { output: Writable & { columns?: number; rows?: number } }
          ).output;
          return renderTableSelect(this.spec, this.cur, {
            columns: out.columns ?? process.stdout.columns ?? 80,
            rows: out.rows ?? process.stdout.rows ?? 24,
            // picocolors' own detection: NO_COLOR, FORCE_COLOR, a dumb terminal.
            color: pc0.isColorSupported,
            // `outcome` first: Enter on an empty table quits, though clack's
            // 'return' handling then marks the prompt submitted.
            state:
              this.outcome === 'quit' && this.state !== 'active' && this.state !== 'initial'
                ? 'quit'
                : this.state === 'submit'
                  ? 'submit'
                  : this.state === 'cancel'
                    ? 'cancel'
                    : 'active',
          });
        },
      },
      false,
    );
    const start = indexOf(spec, spec.cursorAt);
    this.cur = { cursor: start, scroll: 0 };
    this.outcome = undefined;
  }

  /**
   * Handles keys before clack's own listener runs (registered first), which
   * then redraws and, on a final state, closes. Our own listener so pageup,
   * home, q and the Esc/Ctrl-C split are seen by name.
   */
  readonly onKey = (_ch: string | undefined, key: KeyInfo | undefined): void => {
    const k = keyOf(key);
    if (!k) return;
    if (k === 'submit') {
      if (this.spec.actions.length + this.spec.rows.length === 0) {
        this.outcome = 'quit';
        this.state = 'cancel';
        return;
      }
      this.outcome = 'submit';
      return; // clack's 'return' handling sets state 'submit'
    }
    if (k === 'quit' || k === 'cancel') {
      this.outcome = k;
      this.state = 'cancel';
      return;
    }
    const out = this.output as Writable & { rows?: number };
    this.cur = moveCursor(this.cur, k, {
      actions: this.spec.actions.length,
      rows: this.spec.rows.length,
      visible: visibleRows(this.spec, out.rows ?? process.stdout.rows ?? 24),
    });
  };

  get inputStream(): KeypressEmitter {
    return this.input as unknown as KeypressEmitter;
  }
}

/**
 * Show `spec` and wait for a pick. Under a non-TTY the caller prints its plain
 * table instead; this is the interactive screen only.
 */
export async function tableSelect<V extends string>(
  spec: TableSelectSpec<V>,
  io: { input?: Readable; output?: Writable } = {},
): Promise<TableSelectResult<V>> {
  const p = new TableSelectPrompt(spec, io);
  const input = io.input ?? process.stdin;
  const output = io.output ?? process.stdout;
  // A resize reflows the old frame's lines, which clack's line diff can't
  // follow. Move to the top of the old frame as it now wraps, erase from there
  // down (output above the frame stays) and let clack's own resize listener,
  // registered after this one, draw anew from an empty previous frame.
  const onResize = (): void => {
    const self = p as unknown as { _prevFrame: string };
    const cols = (output as Writable & { columns?: number }).columns ?? 80;
    const rows = self._prevFrame
      .split('\n')
      .reduce((n, line) => n + Math.max(1, Math.ceil(textWidth(line) / cols)), 0);
    output.write(`\r${rows > 1 ? `\x1b[${String(rows - 1)}A` : ''}\x1b[J`);
    self._prevFrame = '';
  };
  (input as unknown as KeypressEmitter).on('keypress', p.onKey);
  output.on('resize', onResize);
  try {
    await p.prompt();
  } finally {
    (input as unknown as KeypressEmitter).off('keypress', p.onKey);
    output.off('resize', onResize);
  }
  if (p.outcome === 'quit') return { kind: 'quit' };
  if (p.outcome !== 'submit') return { kind: 'cancel' };
  const a = spec.actions[p.cur.cursor];
  if (a) return { kind: 'action', value: a.value };
  const r = spec.rows[p.cur.cursor - spec.actions.length];
  return r ? { kind: 'row', value: r.value } : { kind: 'quit' };
}
