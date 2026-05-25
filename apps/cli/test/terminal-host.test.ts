import { describe, expect, it } from 'vitest';
import { detectHostTerminal } from '../src/terminal/host.js';
import { parseAttachInOption } from '../src/commands/_attach-in.js';

describe('detectHostTerminal', () => {
  it('returns "tmux" when TMUX is set, even if TERM_PROGRAM also says iTerm', () => {
    expect(
      detectHostTerminal({
        TMUX: '/private/tmp/tmux-501/default,12345,0',
        TERM_PROGRAM: 'iTerm.app',
      }),
    ).toBe('tmux');
  });

  it('returns "iterm2" when TERM_PROGRAM=iTerm.app and TMUX is unset', () => {
    expect(detectHostTerminal({ TERM_PROGRAM: 'iTerm.app' })).toBe('iterm2');
  });

  it('treats an empty TMUX value as unset', () => {
    expect(detectHostTerminal({ TMUX: '', TERM_PROGRAM: 'iTerm.app' })).toBe('iterm2');
  });

  it('returns "unknown" for Apple Terminal / unrecognized programs', () => {
    expect(detectHostTerminal({ TERM_PROGRAM: 'Apple_Terminal' })).toBe('unknown');
    expect(detectHostTerminal({})).toBe('unknown');
  });
});

describe('parseAttachInOption', () => {
  it('passes through valid enum values', () => {
    expect(parseAttachInOption('split')).toBe('split');
    expect(parseAttachInOption('window')).toBe('window');
    expect(parseAttachInOption('tab')).toBe('tab');
    expect(parseAttachInOption('same')).toBe('same');
  });

  it('returns undefined when the flag is absent', () => {
    expect(parseAttachInOption(undefined)).toBeUndefined();
  });

  it('throws a helpful error for an unknown value', () => {
    expect(() => parseAttachInOption('elsewhere')).toThrowError(/--attach-in/);
  });
});
