import { describe, expect, it } from 'vitest';
import {
  clipLine,
  fitColumns,
  initialCursor,
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
    // Default-presentation emoji outside the CJK/pictograph blocks.
    expect(textWidth('\u2705\u274c\u2b50')).toBe(6);
    // Text-default pictographs stay narrow without VS16.
    expect(textWidth('\u2764')).toBe(1);
    expect(textWidth('\u2764\ufe0f')).toBe(2);
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

const seven: TableSelectSpec<string> = {
  title: 'Subscriptions',
  subtitle: '12 account(s)',
  actions: [
    { value: '+add', label: 'Add an account…' },
    { value: '+use', label: 'What do new boxes here use?' },
  ],
  headers: ['NAME', 'KIND', 'IDENTITY', 'STATUS', 'LIMITS', 'DEFAULT', 'BOXES'],
  rows: Array.from({ length: 12 }, (_, i) => ({
    value: `claude/acct_${String(i)}`,
    cells: [
      `claude/acct_${String(i)}`,
      'setup token',
      'someone@example.com, max',
      'ok',
      '5-hour 40%, Weekly 80%',
      'global',
      'box-one, box-two',
    ],
  })),
};

describe('narrow terminals', () => {
  it.each([40, 50, 56, 80])(
    'at %i columns every line fits and the frame fits the height',
    (cols) => {
      for (const cursor of [0, 2, 13]) {
        const out = renderTableSelect(
          seven,
          { cursor, scroll: 0 },
          {
            columns: cols,
            rows: 20,
            color: true,
            state: 'active',
          },
        );
        const lines = out.split('\n');
        for (const line of lines) expect(textWidth(line)).toBeLessThan(cols);
        // One screen row per line, and one row of slack for clack's redraw.
        expect(lines.length).toBeLessThan(20);
      }
    },
  );

  it('drops the rightmost columns first, keeping the first', () => {
    const out = render(seven, 2, 40, 20);
    expect(out).toContain('NAME');
    expect(out).not.toContain('BOXES');
  });

  it('drops by priority when one is given', () => {
    const out = render({ ...seven, priority: [0, 3, 1, 5] }, 2, 40, 20);
    // Headers may be cut with an ellipsis; match their start.
    expect(out).toContain('STA');
    expect(out).not.toContain('IDE');
    // Display order stays left to right.
    expect(out.indexOf('NAME')).toBeLessThan(out.indexOf('STA'));
  });

  it('clips a styled line without counting escapes', () => {
    expect(clipLine('\x1b[2mabcdef\x1b[22m', 3)).toBe('\x1b[2mabc\x1b[0m');
    expect(clipLine('abc', 3)).toBe('abc');
  });

  it('survives empty headers', () => {
    expect(() => render({ ...spec(2), headers: [] })).not.toThrow();
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

  it('a restored cursor deep in the list keeps its view on the first move', () => {
    const long = spec(40);
    const start = initialCursor({ ...long, cursorAt: 's25' }, 24);
    const visible = visibleRows(long, 24);
    expect(start.cursor).toBe(2 + 25);
    // The restored row is on screen, at the bottom of the view.
    expect(start.scroll).toBe(25 - visible + 1);
    const next = moveCursor(start, 'up', { actions: 2, rows: 40, visible });
    expect(next).toEqual({ cursor: start.cursor - 1, scroll: start.scroll });
  });

  it('maps a bare newline to submit like return', () => {
    expect(keyOf({ name: 'enter' })).toBe('submit');
  });

  it('starts on a value', () => {
    expect(indexOf(spec(), '+down')).toBe(1);
    expect(indexOf(spec(), 's2')).toBe(4);
    expect(indexOf(spec(), 'gone')).toBe(0);
  });
});
