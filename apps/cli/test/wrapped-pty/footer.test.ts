import { describe, expect, it } from 'vitest';
import { renderFooter, type FooterState } from '../../src/wrapped-pty/footer.js';

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
    expect(out).toContain('Control+a q: detach');
  });

  it('keeps the detach chord pinned, dropping `Actions` first, on a narrow bar', () => {
    const out = visible(renderFooter(idle, 60));
    expect(out).toContain('agentbox ▸');
    expect(out).toContain('Control+a q: detach');
    // the lower-priority `Actions` hint is dropped to make room
    expect(out).not.toContain('Actions');
  });

  it('drops the title when the bar is too narrow but keeps brand + detach', () => {
    const out = visible(renderFooter(idle, 50));
    expect(out).toContain('agentbox ▸');
    expect(out).toContain('smoke');
    expect(out).toContain('Control+a q');
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
    expect(out).toContain('v: vnc');
    expect(out).toContain('w: browser');
    expect(out).toContain('q: detach');
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
    expect(out).toContain('v: vnc');
    expect(out).toContain('w: browser');
    // shell has nothing to detach from
    expect(out).not.toContain('detach');
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

  it('shows the message + Y/N hint', () => {
    const out = visible(renderFooter(prompt, 80));
    expect(out).toContain('Allow git push to origin?');
    expect(out).toContain('[y/N]');
    expect(out.startsWith(' [!] ')).toBe(true);
  });

  it('prompt with defaultAnswer "y" shows [Y/n]', () => {
    const p: FooterState = {
      kind: 'prompt',
      prompt: { ...prompt.prompt, defaultAnswer: 'y' } as never,
    };
    const out = visible(renderFooter(p, 80));
    expect(out).toContain('[Y/n]');
    expect(out).not.toContain('[y/N]');
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
    expect(out).toContain('[y/N]');
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
