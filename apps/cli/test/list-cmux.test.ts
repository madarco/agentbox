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
  it('emits two lines per box: name (with index) then indented status', () => {
    const rows = renderCmuxRows(
      [box({ name: 'api', projectIndex: 1, claudeActivity: 'working' })],
      false,
      40,
    );
    expect(rows.split('\n')).toEqual(['1 api', '  ● claude working']);
  });

  it('tail-truncates a long name to the panel width, keeping the suffix', () => {
    const rows = renderCmuxRows(
      [box({ name: 'agentbox-test-repo-gh-bc322f148', projectIndex: 2, state: 'paused' })],
      false,
      12,
    );
    const [nameLine, statusLine] = rows.split('\n');
    expect(nameLine).toBe('2 …bc322f148'); // "2 " prefix + 10-col tail-kept name
    expect(nameLine!.length).toBe(12);
    expect(statusLine).toBe('  [paused]');
  });

  it('omits the index prefix for a box without a projectIndex', () => {
    const rows = renderCmuxRows([box({ name: 'solo', claudeActivity: 'idle' })], false, 40);
    expect(rows.split('\n')[0]).toBe('solo');
  });
});

describe('cmuxEmptyMessage', () => {
  it('nudges toward -g when scoped to a project', () => {
    expect(cmuxEmptyMessage(true)).toBe('no boxes · g for all');
  });
  it('nudges toward create when already global', () => {
    expect(cmuxEmptyMessage(false)).toBe('no boxes · create one');
  });
});
