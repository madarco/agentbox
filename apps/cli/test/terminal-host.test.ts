import { describe, expect, it } from 'vitest';
import type { AttachOpenIn, ConfigSource, LoadedConfig } from '@agentbox/config';
import { detectHostTerminal, hostAwareOpenIn } from '../src/terminal/host.js';
import { parseAttachInOption, resolveAttachInOption } from '../src/commands/_attach-in.js';

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

  it('returns "cmux" when CMUX_SOCKET_PATH is set and TMUX is unset', () => {
    expect(
      detectHostTerminal({
        CMUX_SOCKET_PATH: '/Users/x/Library/Application Support/cmux/cmux.sock',
        TERM_PROGRAM: 'ghostty',
      }),
    ).toBe('cmux');
  });

  it('returns "tmux" when both TMUX and CMUX_SOCKET_PATH are set (tmux wins)', () => {
    expect(
      detectHostTerminal({
        TMUX: '/private/tmp/tmux-501/default,12345,0',
        CMUX_SOCKET_PATH: '/Users/x/Library/Application Support/cmux/cmux.sock',
      }),
    ).toBe('tmux');
  });

  it('returns "unknown" for standalone ghostty (no CMUX_* vars)', () => {
    expect(detectHostTerminal({ TERM_PROGRAM: 'ghostty' })).toBe('unknown');
  });

  it('returns "herdr" when HERDR_SOCKET_PATH is set, even under iTerm2', () => {
    // Herdr runs inside a host terminal, so TERM_PROGRAM reflects the outer
    // emulator; Herdr must win over iTerm2 or attach spawns iTerm2 windows.
    expect(
      detectHostTerminal({ HERDR_SOCKET_PATH: '/tmp/herdr.sock', TERM_PROGRAM: 'iTerm.app' }),
    ).toBe('herdr');
  });

  it('returns "cmux" when both cmux and Herdr sockets are set (cmux wins)', () => {
    expect(
      detectHostTerminal({
        CMUX_SOCKET_PATH: '/tmp/cmux.sock',
        HERDR_SOCKET_PATH: '/tmp/herdr.sock',
      }),
    ).toBe('cmux');
  });

  it('returns "tmux" when TMUX and HERDR_SOCKET_PATH are both set (tmux wins)', () => {
    expect(
      detectHostTerminal({ TMUX: '/tmp/tmux-0/default,1,0', HERDR_SOCKET_PATH: '/tmp/herdr.sock' }),
    ).toBe('tmux');
  });

  it('treats an empty TMUX value as unset', () => {
    expect(detectHostTerminal({ TMUX: '', TERM_PROGRAM: 'iTerm.app' })).toBe('iterm2');
  });

  it('returns "unknown" for Apple Terminal / unrecognized programs', () => {
    expect(detectHostTerminal({ TERM_PROGRAM: 'Apple_Terminal' })).toBe('unknown');
    expect(detectHostTerminal({})).toBe('unknown');
  });
});

describe('hostAwareOpenIn', () => {
  const cfg = (openIn: AttachOpenIn, source: ConfigSource): LoadedConfig =>
    ({
      effective: { attach: { openIn } },
      sources: { 'attach.openIn': source },
    }) as unknown as LoadedConfig;
  const HERDR = { HERDR_SOCKET_PATH: '/tmp/herdr.sock' };

  it('defaults to a tab under Herdr when openIn is the built-in default split', () => {
    expect(hostAwareOpenIn(cfg('split', 'default'), HERDR)).toBe('tab');
  });

  it('honors an explicitly configured/flagged split under Herdr', () => {
    expect(hostAwareOpenIn(cfg('split', 'cli'), HERDR)).toBe('split');
    expect(hostAwareOpenIn(cfg('split', 'global'), HERDR)).toBe('split');
  });

  it('only remaps split — other default modes pass through under Herdr', () => {
    expect(hostAwareOpenIn(cfg('window', 'default'), HERDR)).toBe('window');
    expect(hostAwareOpenIn(cfg('same', 'default'), HERDR)).toBe('same');
  });

  it('leaves the default split untouched outside Herdr', () => {
    expect(hostAwareOpenIn(cfg('split', 'default'), { CMUX_SOCKET_PATH: '/tmp/c.sock' })).toBe(
      'split',
    );
    expect(hostAwareOpenIn(cfg('split', 'default'), {})).toBe('split');
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

describe('resolveAttachInOption', () => {
  it('returns undefined when neither flag is set (config layer wins downstream)', () => {
    expect(resolveAttachInOption({})).toBeUndefined();
  });

  it('--inline alone maps to "same"', () => {
    expect(resolveAttachInOption({ inline: true })).toBe('same');
  });

  it('--attach-in overrides --inline when both are passed', () => {
    expect(resolveAttachInOption({ inline: true, attachIn: 'window' })).toBe('window');
  });

  it('passes through a typed --attach-in value when --inline is absent', () => {
    expect(resolveAttachInOption({ attachIn: 'tab' })).toBe('tab');
  });

  it('still validates --attach-in when --inline is also set', () => {
    expect(() => resolveAttachInOption({ inline: true, attachIn: 'bogus' })).toThrowError(
      /--attach-in/,
    );
  });
});
