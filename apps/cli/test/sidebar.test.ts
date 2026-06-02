import { describe, expect, it } from 'vitest';
import {
  activityCell,
  sidebarLines,
  statusLine,
  menuLines,
  lifecycleMenuLines,
  createMenuLines,
  SIDEBAR_HEADER_LINES,
  NEW_BOX_ID,
  NEW_BOX_LABEL,
  ADVANCED_HINT_GROUPS,
  COLLAPSED_HINT_GROUPS,
} from '../src/dashboard/sidebar.js';

describe('activityCell', () => {
  it('maps claude activity for running boxes', () => {
    expect(activityCell({ id: '1', name: 'a', state: 'running', activity: 'working' })).toBe(
      '● working',
    );
    expect(activityCell({ id: '1', name: 'a', state: 'running', activity: 'waiting' })).toBe(
      '◐ waiting',
    );
    expect(activityCell({ id: '1', name: 'a', state: 'running' })).toBe('? unknown');
  });
  it('shows container state when not running', () => {
    expect(activityCell({ id: '1', name: 'a', state: 'paused' })).toBe('[paused]');
  });
  it('renders ▲ prompt when pendingPrompt is set (overrides activity)', () => {
    expect(
      activityCell({
        id: '1',
        name: 'a',
        state: 'running',
        activity: 'working',
        pendingPrompt: true,
      }),
    ).toBe('▲ prompt');
  });
  it('▲ prompt also wins over [stopped] / [paused] container states', () => {
    expect(
      activityCell({ id: '1', name: 'a', state: 'paused', pendingPrompt: true }),
    ).toBe('▲ prompt');
  });
});

describe('sidebarLines', () => {
  const boxes = [
    { id: 'aaa', name: 'api', state: 'running', activity: 'idle', project: '/p/proj' },
    { id: 'bbb', name: 'web', state: 'stopped', project: '/p/proj' },
  ];

  it('exactly h lines, each exactly w wide; selection tracked via rowOwner', () => {
    const { lines, rowOwner, headerRows } = sidebarLines(boxes, 'bbb', 24, 10);
    expect(lines).toHaveLength(10);
    expect(rowOwner).toHaveLength(10);
    expect(headerRows).toHaveLength(10);
    for (const l of lines) expect(l).toHaveLength(24);
    const selRow = lines[rowOwner.indexOf('bbb')]!;
    expect(selRow).toContain('web');
    expect(selRow.startsWith('▸')).toBe(true);
    const otherRow = lines[rowOwner.indexOf('aaa')]!;
    expect(otherRow).toContain('api');
    expect(otherRow.startsWith(' ')).toBe(true);
    expect(otherRow.startsWith('▸')).toBe(false);
  });

  it('groups boxes under a centered project header', () => {
    const multi = [
      { id: 'a', name: 'api', state: 'running', activity: 'idle', project: '/work/alpha' },
      { id: 'b', name: 'web', state: 'running', activity: 'idle', project: '/work/beta' },
    ];
    const { lines, rowOwner, headerRows } = sidebarLines(multi, 'a', 30, 10);
    const hA = lines.findIndex((l) => l.includes('alpha'));
    const hB = lines.findIndex((l) => l.includes('beta'));
    expect(hA).toBeGreaterThan(1); // after banner+blank
    expect(headerRows[hA]).toBe(true);
    expect(rowOwner[hA]).toBeNull();
    expect(headerRows[hB]).toBe(true);
    // each box sits after its own project header, in order
    expect(rowOwner.indexOf('a')).toBeGreaterThan(hA);
    expect(rowOwner.indexOf('b')).toBeGreaterThan(hB);
    expect(hB).toBeGreaterThan(rowOwner.indexOf('a'));
  });

  it('handles empty box list', () => {
    const { lines } = sidebarLines([], '', 20, 5);
    expect(lines).toHaveLength(5);
    expect(lines.some((l) => l.includes('(no boxes)'))).toBe(true);
  });

  it('renders the synthetic "+ New box" entry with no group header, selectable', () => {
    const withNew = [{ id: NEW_BOX_ID, name: NEW_BOX_LABEL, state: 'new' }, ...boxes];
    const sel = sidebarLines(withNew, NEW_BOX_ID, 24, 10);
    const ni = sel.rowOwner.indexOf(NEW_BOX_ID);
    expect(ni).toBe(2); // straight after banner+blank, before any group header
    expect(sel.lines[ni]!).toContain(NEW_BOX_LABEL);
    expect(sel.lines[ni]!.startsWith('▸')).toBe(true);
    expect(sel.headerRows[ni]).toBe(false);
    const unsel = sidebarLines(withNew, 'aaa', 24, 10);
    const ui = unsel.rowOwner.indexOf(NEW_BOX_ID);
    expect(unsel.lines[ui]!.startsWith(' ')).toBe(true);
    expect(unsel.lines[ui]!.startsWith('▸')).toBe(false);
    expect(unsel.lines[ui]!).toContain(NEW_BOX_LABEL);
  });

  it('renders a top border (top+right only) as the header, reserves 2 lines', () => {
    expect(SIDEBAR_HEADER_LINES).toBe(2);
    const { lines, headerRows, rowOwner } = sidebarLines(boxes, 'aaa', 24, 8);
    const h = lines[0]!;
    expect(h).toHaveLength(24);
    expect(h.startsWith('──── AgentBox ')).toBe(true); // straight line, left-anchored
    expect(h.endsWith('─')).toBe(true); // border runs to the right edge (no padding)
    expect(h).not.toContain('═'); // old style gone
    expect(headerRows[0]).toBe(true);
    expect(rowOwner[0]).toBeNull();
    expect(lines[1]!.trim()).toBe(''); // spacer row, no bottom border
  });
});

describe('statusLine', () => {
  const ANSI = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g');
  const stripAnsi = (s: string): string => s.replace(ANSI, '');

  it('matches the tmux footer palette with white keys + gray labels', () => {
    const s = statusLine({ id: '1', name: 'api', state: 'running', activity: 'working' }, 200);
    // dark bar (truecolor #303030), blue brand (39), gray labels (245), white keys (255)
    expect(s).toContain('48;2;48;48;48');
    expect(s).toContain('48;5;39');
    expect(s).toContain('38;5;245');
    expect(s).toContain('38;5;255');
    expect(s.endsWith('\x1b[0m')).toBe(true);
    // "agentbox" stays normal weight; bold starts at the box name.
    expect(s).toContain('▸ \x1b[1mapi');
    expect(s).not.toContain('\x1b[1m agentbox');
    const printable = stripAnsi(s);
    expect(printable).toHaveLength(200);
    expect(printable).toContain('api');
  });

  const collapsedParts = COLLAPSED_HINT_GROUPS.map(([k, l]) => `${k}: ${l}`);
  const expectCollapsed = (p: string): void => {
    for (const part of collapsedParts) expect(p).toContain(part);
  };

  it('collapsed tier keeps the switch hint + the leader when full hints do not fit', () => {
    const s = statusLine({ id: '1', name: 'api', state: 'running', activity: 'idle' }, 100);
    const p = stripAnsi(s);
    expect(s).toContain('48;5;39');
    expect(p).toHaveLength(100);
    expectCollapsed(p); // both "Control+Option+↑/↓: switch" and "Control+a: more"
    expect(p).toContain('Control+Option+↑/↓: switch'); // important: box switching
    expect(p).toContain('api (idle)'); // brand core intact
    expect(p).not.toContain('Control+a c: code'); // full hints dropped
  });

  it('brand-core-only when even the collapsed hint cannot fit', () => {
    const s = statusLine({ id: '1', name: 'api', state: 'running', activity: 'idle' }, 16);
    const p = stripAnsi(s);
    expect(p).toHaveLength(16);
    expect(p).not.toContain('more');
  });

  it('shortcuts beat the title: title ellipsizes, then drops, hints stay', () => {
    const box = {
      id: '1',
      name: 'api',
      state: 'running',
      activity: 'working',
      sessionTitle: 'A reasonably long Claude session title here',
    };
    // Full hints (~151 cols) + leftover for a shrunk title.
    const wide = stripAnsi(statusLine(box, 220));
    expect(wide).toHaveLength(220);
    expect(wide).toContain('Control+a c: code'); // full hints intact
    expect(wide).toContain('—'); // title present...
    expect(wide).toContain('…'); // ...but ellipsized (cap 40)
    expect(wide).not.toContain('session title here'); // tail trimmed
    // Just enough for full hints but no room for the title at all.
    const tight = stripAnsi(statusLine(box, 152));
    expect(tight).toHaveLength(152);
    expect(tight).toContain('Control+a c: code'); // hints kept
    expect(tight).not.toContain('—'); // title dropped entirely
  });

  it('collapses hints (not the title-bearing brand) when full hints do not fit', () => {
    const box = {
      id: '1',
      name: 'api',
      state: 'running',
      activity: 'working',
      sessionTitle: 'Some session title',
    };
    const p = stripAnsi(statusLine(box, 120));
    expect(p).toHaveLength(120);
    expectCollapsed(p); // collapsed shortcuts visible (switch + more)
    expect(p).not.toContain('Control+a c: code'); // full hints dropped
  });

  it('spells keys by name (no ⌥/^ glyphs) as "KEYS: label"', () => {
    const s = statusLine({ id: '1', name: 'api', state: 'running', activity: 'idle' }, 200);
    const printable = stripAnsi(s);
    expect(printable).toHaveLength(200);
    expect(printable).toContain('Control+a c: code');
    expect(printable).toContain('Control+Option+↑/↓: switch');
    expect(printable).toContain('│');
    expect(printable).not.toContain('⌥');
    expect(printable).not.toContain('^a');
  });

  it('default hints stay code/screen/url; advanced groups add stop/pause/destroy', () => {
    const box = { id: '1', name: 'api', state: 'running', activity: 'idle' };
    const normal = stripAnsi(statusLine(box, 200));
    expect(normal).toContain('code');
    expect(normal).not.toContain('stop');
    expect(normal).not.toContain('destroy');
    const advanced = stripAnsi(statusLine(box, 200, undefined, ADVANCED_HINT_GROUPS));
    expect(advanced).toContain('t: stop');
    expect(advanced).toContain('p: pause');
    expect(advanced).toContain('k: destroy');
    expect(advanced).toContain('c: code');
    expect(advanced).toHaveLength(200);
  });

  it('uses the stateLabel override (shell/menu) instead of activity', () => {
    const box = { id: '1', name: 'api', state: 'running', activity: 'unknown' };
    expect(statusLine(box, 60, 'shell')).toContain('api (shell)');
    expect(statusLine(box, 60, 'menu')).toContain('api (menu)');
    expect(statusLine(box, 60)).toContain('api (unknown)');
  });
});

describe('menuLines', () => {
  it('is exactly h lines × w cols and offers the claude/codex/opencode/shell actions', () => {
    const lines = menuLines('web-2', 44, 20);
    expect(lines).toHaveLength(20);
    for (const l of lines) expect(l).toHaveLength(44);
    const joined = lines.join('\n');
    expect(joined).toContain('No agent session in web-2.');
    expect(joined).toContain('[c]  Start Claude');
    expect(joined).toContain('[x]  Start Codex');
    expect(joined).toContain('[o]  Start OpenCode');
    expect(joined).toContain('[s]  Open a shell');
  });

  it('clamps content when the pane is short', () => {
    const lines = menuLines('b', 30, 3);
    expect(lines).toHaveLength(3);
    for (const l of lines) expect(l).toHaveLength(30);
  });
});

describe('lifecycleMenuLines', () => {
  it('paused: offers Unpause + Destroy, exactly h × w', () => {
    const lines = lifecycleMenuLines('api-1', 'paused', false, 44, 18);
    expect(lines).toHaveLength(18);
    for (const l of lines) expect(l).toHaveLength(44);
    const joined = lines.join('\n');
    expect(joined).toContain('Box api-1 is paused.');
    expect(joined).toContain('[u]  Unpause');
    expect(joined).toContain('[d]  Destroy');
    expect(joined).not.toContain('[s]  Start');
  });

  it('stopped: offers Start instead of Unpause', () => {
    const joined = lifecycleMenuLines('web', 'stopped', false, 44, 18).join('\n');
    expect(joined).toContain('Box web is stopped.');
    expect(joined).toContain('[s]  Start');
    expect(joined).not.toContain('[u]  Unpause');
  });

  it('confirmDestroy swaps to the y/cancel confirm body', () => {
    const lines = lifecycleMenuLines('api-1', 'paused', true, 44, 18);
    expect(lines).toHaveLength(18);
    for (const l of lines) expect(l).toHaveLength(44);
    const joined = lines.join('\n');
    expect(joined).toContain('Destroy api-1?');
    expect(joined).toContain('[y]  Yes, destroy');
    expect(joined).toContain('Cancel');
    expect(joined).not.toContain('[u]  Unpause');
  });

  it('clamps content when the pane is short', () => {
    const lines = lifecycleMenuLines('b', 'stopped', false, 30, 3);
    expect(lines).toHaveLength(3);
    for (const l of lines) expect(l).toHaveLength(30);
  });
});

describe('createMenuLines', () => {
  it('is exactly h lines × w cols and offers a claude/codex/opencode/create-only picker', () => {
    const lines = createMenuLines('/home/me/proj', 50, 20);
    expect(lines).toHaveLength(20);
    for (const l of lines) expect(l).toHaveLength(50);
    const joined = lines.join('\n');
    expect(joined).toContain('Create a new box');
    expect(joined).toContain('[c]  Create + launch Claude');
    expect(joined).toContain('[x]  Create + launch Codex');
    expect(joined).toContain('[o]  Create + launch OpenCode');
    expect(joined).toContain('[n]  Create only');
    expect(joined).toContain('/home/me/proj');
  });

  it('clamps content when the pane is short', () => {
    const lines = createMenuLines('/x', 30, 3);
    expect(lines).toHaveLength(3);
    for (const l of lines) expect(l).toHaveLength(30);
  });
});

describe('session title', () => {
  const ANSI = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g');
  const stripAnsi = (s: string): string => s.replace(ANSI, '');

  const boxRowOf = (boxes: Parameters<typeof sidebarLines>[0], id: string, w: number) => {
    const { lines, rowOwner } = sidebarLines(boxes, id, w, 12);
    return lines[rowOwner.indexOf(id)]!;
  };

  it('shows "<num> <title>  <status>" on one row when a title is set', () => {
    const boxes = [
      {
        id: 'a',
        name: 'express-server-78b94c78',
        state: 'running',
        activity: 'working',
        sessionTitle: '✳ Fix login bug',
        index: 1,
        project: '/p',
      },
    ];
    const row = boxRowOf(boxes, 'a', 60);
    expect(row).toHaveLength(60);
    expect(row).toContain('▸1 Fix login bug'); // no brackets, no glyph, no ">"
    expect(row).not.toContain('✳'); // Claude spinner glyph stripped
    expect(row).not.toContain('['); // no [N] brackets
    expect(row.trimEnd().endsWith('● working')).toBe(true); // status flush-right
    expect(row).not.toContain('express-server'); // name hidden when title exists
  });

  it('leaves a 1-char right margin so the status does not touch the border', () => {
    const boxes = [
      {
        id: 'a',
        name: 'api',
        state: 'running',
        activity: 'working',
        sessionTitle: 'Fix login bug',
        index: 1,
        project: '/p',
      },
    ];
    const row = boxRowOf(boxes, 'a', 60);
    expect(row).toHaveLength(60);
    expect(row.endsWith('working ')).toBe(true); // status + trailing margin
    expect(row[59]).toBe(' '); // last column is the blank margin
  });

  it('ellipsizes the title (tail-cut) but keeps the status fully visible', () => {
    const boxes = [
      {
        id: 'a',
        name: 'api',
        state: 'running',
        activity: 'idle',
        sessionTitle: 'A very long session title that will not fit at all here',
        index: 2,
        project: '/p',
      },
    ];
    const row = boxRowOf(boxes, 'a', 36);
    expect(row).toHaveLength(36);
    expect(row).toContain('…'); // title truncated cleanly
    expect(row.trimEnd().endsWith('○ idle')).toBe(true); // status never eaten
  });

  it('falls back to the box name (final part kept) when there is no title', () => {
    const boxes = [
      {
        id: 'a',
        name: 'express-server-78b94c78',
        state: 'running',
        activity: 'idle',
        index: 3,
        project: '/p',
      },
    ];
    const row = boxRowOf(boxes, 'a', 28);
    expect(row).toHaveLength(28);
    expect(row).toContain('▸3 '); // marker + number, no brackets, no ">"
    expect(row).not.toContain('['); // no brackets
    expect(row).not.toContain('>');
    expect(row).toContain('…'); // head-truncated (leading ellipsis)
    expect(row).toContain('78b94c78'); // meaningful tail kept
    expect(row).not.toContain('express'); // head dropped
    expect(row.trimEnd().endsWith('○ idle')).toBe(true);
  });

  it('shows the box name for a non-running box (no title) with its state', () => {
    const boxes = [
      { id: 'a', name: 'api', state: 'stopped', sessionTitle: 'stale', index: 4, project: '/p' },
    ];
    const row = boxRowOf(boxes, 'a', 40);
    expect(row).toContain('4 api');
    expect(row.trimEnd().endsWith('[stopped]')).toBe(true);
    expect(row).not.toContain('stale'); // title only used while running
  });

  it('omits the [N] prefix for pre-feature boxes with no index', () => {
    const boxes = [{ id: 'a', name: 'api', state: 'running', activity: 'idle' }];
    const row = boxRowOf(boxes, 'a', 40);
    expect(row).toContain('▸api');
    expect(row).not.toContain('>'); // no number → no "N > " segment
  });

  it('status bar appends "— <title>" to the brand block', () => {
    const s = statusLine(
      { id: '1', name: 'api', state: 'running', activity: 'working', sessionTitle: 'Refactor auth' },
      200,
    );
    expect(stripAnsi(s)).toContain('api (working) — Refactor auth');
  });

  it('status bar ellipsizes a long title to 40 chars', () => {
    const long = 'x'.repeat(80);
    const s = statusLine(
      { id: '1', name: 'api', state: 'running', activity: 'idle', sessionTitle: long },
      300,
    );
    const p = stripAnsi(s);
    expect(p).toHaveLength(300);
    expect(p).toContain('— ' + 'x'.repeat(39) + '…');
    expect(p).not.toContain('x'.repeat(41));
  });

  it('status bar unchanged when no title is set', () => {
    const s = statusLine({ id: '1', name: 'api', state: 'running', activity: 'idle' }, 200);
    expect(stripAnsi(s)).toContain('api (idle) ');
    expect(stripAnsi(s)).not.toContain('—');
  });
});
