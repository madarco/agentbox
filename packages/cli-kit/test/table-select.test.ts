import { describe, expect, it } from 'vitest';
import {
  fitColumns,
  indexOf,
  keyOf,
  moveCursor,
  renderTableSelect,
  scrollFor,
  textWidth,
  truncate,
  visibleRows,
  type TableSelectSpec,
} from '../src/table-select.js';

const spec = (rows = 3): TableSelectSpec<string> => ({
  title: 'Skills',
  subtitle: '2 local',
  actions: [
    { value: '+up', label: 'Upload to hub…', hint: 'local skills the hub lacks' },
    { value: '+down', label: 'Download…' },
  ],
  headers: ['SKILL', 'STATUS'],
  rows: Array.from({ length: rows }, (_, i) => ({
    value: `s${String(i)}`,
    cells: [`skill-${String(i)}`, i === 0 ? 'same' : 'local only'],
    tones: [undefined, i === 0 ? 'green' : 'yellow'],
  })),
  emptyText: 'No skills.',
});

const render = (s: TableSelectSpec<string>, cursor = 0, columns = 60, rows = 30, scroll = 0) =>
  renderTableSelect(s, { cursor, scroll }, { columns, rows, color: false, state: 'active' });

describe('width helpers', () => {
  it('counts CJK and emoji as two columns', () => {
    expect(textWidth('abc')).toBe(3);
    expect(textWidth('日本')).toBe(4);
    expect(textWidth('😀')).toBe(2);
    expect(textWidth('\x1b[31mred\x1b[39m')).toBe(3);
  });

  it('truncates with an ellipsis on a grapheme boundary', () => {
    expect(truncate('hello world', 6)).toBe('hello…');
    expect(truncate('日本語です', 5)).toBe('日本…');
    expect(truncate('short', 10)).toBe('short');
  });

  it('shrinks the widest column first, never below the floor', () => {
    expect(fitColumns([10, 30, 5], 35)).toEqual([10, 20, 5]);
    expect(fitColumns([10, 10], 4)).toEqual([4, 4]);
    expect(fitColumns([2, 10], 6)).toEqual([2, 4]);
  });
});

describe('render', () => {
  it('draws actions above a bordered table, cursor on the first action', () => {
    expect(render(spec())).toMatchInlineSnapshot(`
      "│
      ◆  Skills  2 local
      │  ┌──────────────────────────────────────────────┐
      │  │ › Upload to hub…  local skills the hub lacks │
      │  │   Download…                                  │
      │  ├───────────┬──────────────────────────────────┤
      │  │   SKILL   │ STATUS                           │
      │  ├───────────┼──────────────────────────────────┤
      │  │   skill-0 │ same                             │
      │  │   skill-1 │ local only                       │
      │  │   skill-2 │ local only                       │
      │  └───────────┴──────────────────────────────────┘
      │  ↑/↓ move · enter select · esc/q quit
      └"
    `);
  });

  it('keeps every line within the terminal width', () => {
    const wide: TableSelectSpec<string> = {
      ...spec(),
      rows: [{ value: 'x', cells: ['a'.repeat(80), '日本語'.repeat(20)] }],
    };
    for (const cols of [40, 60, 100]) {
      for (const line of render(wide, 2, cols).split('\n')) {
        expect(textWidth(line)).toBeLessThan(cols);
      }
    }
  });

  it('scrolls a long list inside the terminal height with a more indicator', () => {
    const out = render(spec(50), 2, 60, 20);
    const lines = out.split('\n');
    expect(lines.length).toBeLessThan(20);
    expect(out).toContain('↓');
    expect(out).toMatch(/\d+ more/);
    expect(out).toContain('skill-0');
    expect(out).not.toContain('skill-49');
  });

  it('shows the empty text when there are no rows', () => {
    expect(render(spec(0))).toContain('No skills.');
  });

  it('collapses to the pick on submit', () => {
    const out = renderTableSelect(
      spec(),
      { cursor: 3, scroll: 0 },
      {
        columns: 60,
        rows: 30,
        color: false,
        state: 'submit',
      },
    );
    expect(out).toBe('│\n◇  Skills  2 local\n│  skill-1');
  });
});

describe('keys and cursor', () => {
  it('maps arrows, vi keys, enter, esc, q and ctrl-c', () => {
    expect(keyOf({ name: 'up' })).toBe('up');
    expect(keyOf({ name: 'k' })).toBe('up');
    expect(keyOf({ name: 'j' })).toBe('down');
    expect(keyOf({ name: 'return' })).toBe('submit');
    expect(keyOf({ name: 'escape' })).toBe('quit');
    expect(keyOf({ name: 'q' })).toBe('quit');
    expect(keyOf({ name: 'c', ctrl: true })).toBe('cancel');
    expect(keyOf({ name: 'x' })).toBeUndefined();
  });

  it('moves one highlight across actions and rows, wrapping', () => {
    const sizes = { actions: 2, rows: 3, visible: 10 };
    let s = { cursor: 0, scroll: 0 };
    s = moveCursor(s, 'up', sizes);
    expect(s.cursor).toBe(4);
    s = moveCursor(s, 'down', sizes);
    expect(s.cursor).toBe(0);
    for (const k of ['down', 'down', 'down'] as const) s = moveCursor(s, k, sizes);
    expect(s.cursor).toBe(3);
  });

  it('scrolls to keep the cursor row visible', () => {
    const sizes = { actions: 1, rows: 20, visible: 5 };
    let s = { cursor: 0, scroll: 0 };
    s = moveCursor(s, 'end', sizes);
    expect(s).toEqual({ cursor: 20, scroll: 15 });
    s = moveCursor(s, 'home', sizes);
    expect(s.cursor).toBe(0);
    expect(scrollFor(15, 3, 5, 20)).toBe(3);
    expect(scrollFor(0, -1, 5, 20)).toBe(0);
  });

  it('sizes the viewport to the terminal', () => {
    expect(visibleRows(spec(3), 40)).toBe(3);
    expect(visibleRows(spec(100), 24)).toBe(24 - 1 - 12);
  });

  it('starts on a value', () => {
    expect(indexOf(spec(), '+down')).toBe(1);
    expect(indexOf(spec(), 's2')).toBe(4);
    expect(indexOf(spec(), 'gone')).toBe(0);
  });
});
