import { describe, expect, it } from 'vitest';
import {
  ALERT_BAND_ROWS,
  renderAlertBand,
  renderFooter,
  type AlertBandState,
  type FooterState,
} from '../../src/wrapped-pty/footer.js';

/**
 * Strip ANSI SGR/CSI sequences for human-readable assertions on the
 * visible text. The footer's color/style is tested implicitly by the
 * dashboard's own statusLine tests (the idle path delegates there).
 */
function visible(s: string): string {
  return s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
}

describe('renderFooter — idle (claude mode)', () => {
  const idle: FooterState = {
    kind: 'idle',
    boxName: 'smoke',
    sessionTitle: 'Edit src/foo.ts',
    claudeActivity: 'working',
    mode: 'claude',
  };

  it('renders the brand chip + name + session title + collapsed hint with pinned detach', () => {
    const out = visible(renderFooter(idle, 100));
    expect(out).toContain('agentbox ▸');
    expect(out).toContain('smoke');
    expect(out).toContain('(working)');
    expect(out).toContain('Edit src/foo.ts');
    expect(out).toContain('Control+a: Actions');
    // detach stays pinned on the right even while the menu is collapsed
    expect(out).toContain('Control+a d: detach');
  });

  it('keeps the detach chord pinned, dropping `Actions` first, on a narrow bar', () => {
    const out = visible(renderFooter(idle, 60));
    expect(out).toContain('agentbox ▸');
    expect(out).toContain('Control+a d: detach');
    // the lower-priority `Actions` hint is dropped to make room
    expect(out).not.toContain('Actions');
  });

  it('drops the title when the bar is too narrow but keeps brand + detach', () => {
    const out = visible(renderFooter(idle, 50));
    expect(out).toContain('agentbox ▸');
    expect(out).toContain('smoke');
    expect(out).toContain('Control+a d');
    // session title is dropped (≈ ` — <title>` doesn't fit)
    expect(out).not.toContain('Edit src/foo.ts');
  });

  it('omits parens on claudeActivity when none is known', () => {
    const out = visible(
      renderFooter({ kind: 'idle', boxName: 'b', mode: 'claude' }, 100),
    );
    expect(out).toContain('agentbox ▸');
    expect(out).toContain('Control+a');
    // dashboard's statusLine falls back to `(unknown)` when activity is absent.
    expect(out).toContain('(unknown)');
  });

  it('expands to the chord menu while the leader is active', () => {
    const out = visible(renderFooter({ ...idle, leaderActive: true }, 120));
    expect(out).toContain('c: code');
    expect(out).toContain('s: screen');
    expect(out).toContain('u: url');
    expect(out).toContain('d: detach');
    // the collapsed `Actions` label is replaced by the chords
    expect(out).not.toContain('Actions');
  });
});

describe('renderFooter — idle (shell mode)', () => {
  const idle: FooterState = {
    kind: 'idle',
    boxName: 'smoke',
    mode: 'shell',
  };

  it('renders the brand chip + name with the collapsed actions hint', () => {
    const out = visible(renderFooter(idle, 80));
    expect(out).toContain('agentbox ▸');
    expect(out).toContain('smoke');
    expect(out).toContain('(shell)');
    expect(out).toContain('Control+a');
    expect(out).toContain('Actions');
  });

  it('expands to a chord menu without a detach entry while the leader is active', () => {
    const out = visible(renderFooter({ ...idle, leaderActive: true }, 120));
    expect(out).toContain('c: code');
    expect(out).toContain('s: screen');
    expect(out).toContain('u: url');
    // a plain (--no-tmux) shell has nothing to detach from
    expect(out).not.toContain('detach');
  });
});

describe('renderFooter — idle (tmux-backed shell)', () => {
  const idle: FooterState = {
    kind: 'idle',
    boxName: 'smoke',
    mode: 'shell',
    detachable: true,
  };

  it('keeps the `(shell)` label but pins the detach chord', () => {
    const out = visible(renderFooter(idle, 80));
    expect(out).toContain('(shell)');
    expect(out).toContain('Control+a d: detach');
  });

  it('includes the detach entry in the expanded chord menu', () => {
    const out = visible(renderFooter({ ...idle, leaderActive: true }, 120));
    expect(out).toContain('c: code');
    expect(out).toContain('d: detach');
  });
});

describe('renderFooter — flash', () => {
  const flash: FooterState = { kind: 'flash', message: 'Opening noVNC viewer…' };

  it('shows the message with a leading marker', () => {
    const out = visible(renderFooter(flash, 80));
    expect(out).toContain('▸');
    expect(out).toContain('Opening noVNC viewer…');
  });

  it('truncates a long message with an ellipsis on a narrow bar', () => {
    const out = visible(
      renderFooter({ kind: 'flash', message: 'A'.repeat(120) }, 24),
    );
    expect(out).toContain('…');
  });

  it('ends with SGR reset', () => {
    expect(renderFooter(flash, 60)).toMatch(/\x1b\[0m$/);
  });
});

describe('renderFooter — prompt', () => {
  const prompt: FooterState = {
    kind: 'prompt',
    prompt: {
      id: 'id-1',
      kind: 'confirm',
      message: 'Allow git push to origin?',
      detail: 'agentbox/foo',
    },
  };

  it('shows the message + spelled-out answer chip', () => {
    const out = visible(renderFooter(prompt, 80));
    expect(out).toContain('Allow git push to origin?');
    expect(out).toContain('y Yes');
    expect(out).toContain('n No');
    expect(out.startsWith(' [!] ')).toBe(true);
  });

  it('underlines No (the safe default) when defaultAnswer is absent', () => {
    // The default is conveyed via the underline SGR, not the chip text, so
    // assert on the raw (un-stripped) string.
    const raw = renderFooter(prompt, 80);
    expect(raw).toContain('\x1b[4mn No');
  });

  it('underlines Yes when defaultAnswer is "y"', () => {
    const p: FooterState = {
      kind: 'prompt',
      prompt: { ...prompt.prompt, defaultAnswer: 'y' } as never,
    };
    const raw = renderFooter(p, 80);
    expect(raw).toContain('\x1b[4my Yes');
  });

  it('truncates long messages with an ellipsis when cols is narrow', () => {
    const long: FooterState = {
      kind: 'prompt',
      prompt: {
        id: 'id',
        kind: 'confirm',
        message: 'A really very absurdly long message that will never fit',
      },
    };
    const out = visible(renderFooter(long, 30));
    expect(out).toContain('…');
    expect(out).toContain('n No');
  });
});

describe('renderFooter — notice', () => {
  const notice: FooterState = {
    kind: 'notice',
    message: 'Checkpoint in progress — the box will be unresponsive for a moment',
    frame: 2,
  };

  it('shows the message and a spinner glyph', () => {
    const out = visible(renderFooter(notice, 100));
    expect(out).toContain('Checkpoint in progress');
    // frame 2 → SPINNER_FRAMES[2] === '◑'
    expect(out).toContain('◑');
  });

  it('advances the spinner glyph with the frame counter', () => {
    expect(visible(renderFooter({ ...notice, frame: 0 }, 100))).toContain('◐');
    expect(visible(renderFooter({ ...notice, frame: 1 }, 100))).toContain('◓');
    // frame wraps around the 4-glyph cycle.
    expect(visible(renderFooter({ ...notice, frame: 4 }, 100))).toContain('◐');
  });

  it('truncates a long message with an ellipsis on a narrow bar', () => {
    const out = visible(renderFooter({ ...notice, frame: 0 }, 24));
    expect(out).toContain('…');
  });
});

describe('renderFooter — edge cases', () => {
  it('returns empty string when cols <= 0', () => {
    const idle: FooterState = { kind: 'idle', boxName: 'x', mode: 'claude' };
    expect(renderFooter(idle, 0)).toBe('');
    expect(renderFooter(idle, -3)).toBe('');
  });

  it('always ends with SGR reset so following bytes start clean', () => {
    const idle: FooterState = { kind: 'idle', boxName: 'x', mode: 'claude' };
    expect(renderFooter(idle, 40)).toMatch(/\x1b\[0m$/);
    expect(
      renderFooter(
        { kind: 'prompt', prompt: { id: 'i', kind: 'confirm', message: 'm' } },
        80,
      ),
    ).toMatch(/\x1b\[0m$/);
    expect(renderFooter({ kind: 'notice', message: 'm', frame: 0 }, 80)).toMatch(
      /\x1b\[0m$/,
    );
  });
});

describe('renderAlertBand', () => {
  it('renders a prompt band as 3 rows: title + answer chip, then message, then detail', () => {
    const state: AlertBandState = {
      kind: 'prompt',
      prompt: {
        id: '1',
        kind: 'confirm',
        message: 'git push to origin',
        detail: 'branch: agentbox/foo',
        context: { command: 'git push' },
      },
    };
    const lines = renderAlertBand(state, 80);
    expect(lines).toHaveLength(ALERT_BAND_ROWS);
    const visibleLines = lines.map(visible);
    // Row 1: marker + bold title (the command, uppercased) + spelled-out chip.
    expect(visibleLines[0]).toContain('[!]');
    expect(visibleLines[0]).toContain('GIT PUSH');
    expect(visibleLines[0]).toContain('y Yes');
    expect(visibleLines[0]).toContain('n No');
    // Row 2: the question; Row 3: the sub-message.
    expect(visibleLines[1]).toContain('git push to origin');
    expect(visibleLines[2]).toContain('branch: agentbox/foo');
  });

  it('falls back to a CONFIRM title when the prompt carries no command', () => {
    const state: AlertBandState = {
      kind: 'prompt',
      prompt: { id: '1', kind: 'confirm', message: 'do the thing?' },
    };
    const visibleLines = renderAlertBand(state, 80).map(visible);
    expect(visibleLines[0]).toContain('CONFIRM');
    expect(visibleLines[1]).toContain('do the thing?');
  });

  it('renders a notice band with a spinner glyph + message, all rows on the yellow banner', () => {
    const state: AlertBandState = {
      kind: 'notice',
      message: 'Checkpoint in progress — capturing box state…',
      frame: 0,
    };
    const lines = renderAlertBand(state, 80);
    expect(lines).toHaveLength(ALERT_BAND_ROWS);
    const visibleLines = lines.map(visible);
    // First line carries the spinner; full message visible somewhere in the band.
    expect(visibleLines[0]).toMatch(/[◐◑◒◓]/);
    expect(visibleLines.join(' ')).toContain('Checkpoint in progress');
    // Every row should set the yellow background (NOTICE_BG = SGR 48;5;220).
    for (const line of lines) expect(line).toContain('\x1b[48;5;220m');
  });

  it('renders a question band with header + question text + option labels', () => {
    const state: AlertBandState = {
      kind: 'question',
      question: {
        questions: [
          {
            question: 'Scope',
            header: 'Which TUI?',
            options: [{ label: 'Single-attach' }, { label: 'Dashboard' }, { label: 'Both' }],
          },
        ],
        capturedAt: '2026-05-29T00:00:00Z',
      },
    };
    const lines = renderAlertBand(state, 80);
    expect(lines).toHaveLength(ALERT_BAND_ROWS);
    const visibleLines = lines.map(visible);
    expect(visibleLines[0]).toContain('[?]');
    expect(visibleLines[0]).toContain('Which TUI?');
    expect(visibleLines[1]).toContain('Scope');
    expect(visibleLines[2]).toContain('Single-attach');
    expect(visibleLines[2]).toContain('Dashboard');
    expect(visibleLines[2]).toContain('Both');
  });

  it('honors a custom row count', () => {
    const state: AlertBandState = {
      kind: 'notice',
      message: 'short',
      frame: 0,
    };
    expect(renderAlertBand(state, 80, 1)).toHaveLength(1);
    expect(renderAlertBand(state, 80, 5)).toHaveLength(5);
  });
});
