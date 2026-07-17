import { describe, expect, it } from 'vitest';
import type { ListedBox } from '@agentbox/sandbox-docker';
import {
  cmuxEmptyMessage,
  cmuxStatusCell,
  primaryAgent,
  renderCmuxRows,
} from '../src/commands/list.js';

/** Minimal ListedBox fixture — the compact renderer only reads a few fields. */
function box(p: Partial<ListedBox>): ListedBox {
  return { name: 'b', state: 'running', ...p } as unknown as ListedBox;
}

const ESC = '\x1b[';

describe('cmuxStatusCell', () => {
  it('maps each running activity to glyph + agent + label (monochrome)', () => {
    expect(cmuxStatusCell(box({ claudeActivity: 'working' }), false)).toBe('● claude working');
    expect(cmuxStatusCell(box({ claudeActivity: 'idle' }), false)).toBe('○ claude idle');
    expect(cmuxStatusCell(box({ claudeActivity: 'waiting' }), false)).toBe('◐ claude needs input');
    expect(cmuxStatusCell(box({ claudeActivity: 'question' }), false)).toBe(
      '◐ claude needs input',
    );
    expect(cmuxStatusCell(box({ claudeActivity: 'end-plan' }), false)).toBe('◐ claude plan ready');
    expect(cmuxStatusCell(box({ claudeActivity: 'error' }), false)).toBe('✖ claude error');
  });

  it('shows just the glyph + agent when activity is unknown (no label)', () => {
    expect(cmuxStatusCell(box({ claudeActivity: 'unknown' }), false)).toBe('○ claude');
  });

  it('renders the container state for a non-running box', () => {
    expect(cmuxStatusCell(box({ state: 'paused' }), false)).toBe('[paused]');
  });

  it('shows an un-adopted control-box box as [on hub], not a live agent', () => {
    // Regression: synthesized hub rows carry `state: 'running'` as a placeholder
    // (we deliberately don't probe), so the dock rendered a live-agent glyph for
    // a box this machine has never adopted — while the table said `on hub`.
    expect(cmuxStatusCell({ ...box({}), needsAdopt: true }, false)).toBe('[on hub]');
    expect(cmuxStatusCell(box({ state: 'stopped' }), false)).toBe('[stopped]');
  });

  it('emits no ANSI when color is false, and wraps in SGR when true', () => {
    expect(cmuxStatusCell(box({ claudeActivity: 'working' }), false)).not.toContain(ESC);
    const colored = cmuxStatusCell(box({ claudeActivity: 'working' }), true);
    expect(colored).toContain('38;5;39'); // blue
    expect(colored).toContain('● claude working');
  });
});

describe('primaryAgent', () => {
  it('prefers claude when it has real activity', () => {
    expect(primaryAgent(box({ claudeActivity: 'working' })).agent).toBe('claude');
  });

  it('falls through to a running codex when claude is unknown', () => {
    const b = box({
      claudeActivity: 'unknown',
      codexSession: { running: true } as ListedBox['codexSession'],
    });
    expect(primaryAgent(b).agent).toBe('codex');
  });

  it('falls through to a running opencode when neither claude nor codex is active', () => {
    const b = box({
      claudeActivity: 'unknown',
      opencodeSession: { running: true } as ListedBox['opencodeSession'],
    });
    expect(primaryAgent(b).agent).toBe('opencode');
  });
});

describe('renderCmuxRows', () => {
  it('emits a project header then two lines per box (name with index, status)', () => {
    const rows = renderCmuxRows(
      [box({ name: 'api', projectIndex: 1, projectRoot: '/Users/me/api', claudeActivity: 'working' })],
      false,
      40,
    );
    expect(rows.split('\n')).toEqual(['── api ──', '1 api', '  ● claude working']);
  });

  it('groups boxes by project with a blank line between groups', () => {
    const rows = renderCmuxRows(
      [
        box({ name: 'a1', projectIndex: 1, projectRoot: '/Users/me/alpha', claudeActivity: 'idle' }),
        box({ name: 'a2', projectIndex: 2, projectRoot: '/Users/me/alpha', claudeActivity: 'idle' }),
        box({ name: 'b1', projectIndex: 1, projectRoot: '/Users/me/beta', state: 'paused' }),
      ],
      false,
      40,
    );
    expect(rows.split('\n')).toEqual([
      '── alpha ──',
      '1 a1',
      '  ○ claude idle',
      '2 a2',
      '  ○ claude idle',
      '',
      '── beta ──',
      '1 b1',
      '  [paused]',
    ]);
  });

  it('tail-truncates a long name to the panel width, keeping the suffix', () => {
    const rows = renderCmuxRows(
      [
        box({
          name: 'agentbox-test-repo-gh-bc322f148',
          projectIndex: 2,
          projectRoot: '/Users/me/repo',
          state: 'paused',
        }),
      ],
      false,
      12,
    );
    const [, nameLine, statusLine] = rows.split('\n'); // [0] is the header
    expect(nameLine).toBe('2 …bc322f148'); // "2 " prefix + 10-col tail-kept name
    expect(nameLine!.length).toBe(12);
    expect(statusLine).toBe('  [paused]');
  });

  it('labels boxes with no project root as "other"', () => {
    const rows = renderCmuxRows([box({ name: 'solo', claudeActivity: 'idle' })], false, 40);
    expect(rows.split('\n')[0]).toBe('── other ──');
    expect(rows.split('\n')[1]).toBe('solo'); // no index prefix
  });

  it('wraps box names in an agentbox://web OSC 8 hyperlink keyed on the box id (Herdr)', () => {
    const rows = renderCmuxRows(
      [
        box({
          name: 'api',
          id: 'b084ed411',
          projectIndex: 1,
          projectRoot: '/Users/me/api',
          claudeActivity: 'idle',
        }),
      ],
      false,
      40,
      true,
    );
    const nameLine = rows.split('\n')[1]!;
    // OSC 8: ESC ]8;;<url> ST <label> ESC ]8;; ST — URL uses the unique id, label the name
    expect(nameLine).toContain('\x1b]8;;agentbox://web/b084ed411\x1b\\');
    expect(nameLine).toContain('api');
    expect(nameLine.startsWith('1 ')).toBe(true);
  });

  it('does not hyperlink names by default (cmux)', () => {
    const rows = renderCmuxRows([box({ name: 'api', claudeActivity: 'idle' })], false, 40);
    expect(rows).not.toContain('agentbox://');
  });
});

describe('cmuxEmptyMessage', () => {
  it('nudges toward create (the panel is always global)', () => {
    expect(cmuxEmptyMessage()).toBe('no boxes · agentbox create');
  });
});
