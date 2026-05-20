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

  it('renders the dashboard-style brand chip + name + session title + detach hint', () => {
    const out = visible(renderFooter(idle, 100));
    expect(out).toContain('agentbox ▸');
    expect(out).toContain('smoke');
    expect(out).toContain('(working)');
    expect(out).toContain('Edit src/foo.ts');
    expect(out).toContain('Control+a q');
    expect(out).toContain('detach');
  });

  it('drops the title when the bar is too narrow but keeps brand + hint', () => {
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
    expect(out).toContain('Control+a q');
    // dashboard's statusLine falls back to `(unknown)` when activity is absent.
    expect(out).toContain('(unknown)');
  });
});

describe('renderFooter — idle (shell mode)', () => {
  const idle: FooterState = {
    kind: 'idle',
    boxName: 'smoke',
    mode: 'shell',
  };

  it('renders the brand chip + name without a detach chord', () => {
    const out = visible(renderFooter(idle, 80));
    expect(out).toContain('agentbox ▸');
    expect(out).toContain('smoke');
    expect(out).toContain('(shell)');
    expect(out).not.toContain('Control+a');
    expect(out).not.toContain('detach');
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
  });
});
