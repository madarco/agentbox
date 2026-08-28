import { describe, expect, it } from 'vitest';
import { claudeSessionEnvFlags } from '../src/sync/agents/claude.js';

/**
 * Regression for the hole Bugbot caught on #327.
 *
 * The renderer pin (`box.claudeTui`) was written only into
 * /etc/agentbox/box.env. But the docker path starts the agent with
 * `docker exec … tmux new-session -d -s claude 'claude …'` — `claude` is the
 * tmux command directly, NOT `bash -lc`, so nothing ever sources box.env. The
 * session would have inherited only the container environment baked at
 * `docker run` time, which is immutable: an existing box could never pick the
 * setting up, and changing `box.claudeTui` could not reach a running box's
 * agent. (`agentbox shell` looked fine, because that IS a login shell — so the
 * failure was invisible from the place you would naturally check.)
 *
 * The renderer therefore has to ride the `docker exec -e` flags, like the other
 * forwarded keys.
 */
const pairs = (flags: string[]): string[] =>
  flags.reduce<string[]>((acc, v, i) => (flags[i - 1] === '-e' ? [...acc, v] : acc), []);

describe('claudeSessionEnvFlags', () => {
  it('forwards the classic-renderer pin so tmux does not need a login shell', () => {
    const got = pairs(claudeSessionEnvFlags('default', { TERM: 'xterm-256color' }));
    expect(got).toContain('CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1');
  });

  it('forwards the fullscreen opt-in instead when asked', () => {
    const got = pairs(claudeSessionEnvFlags('fullscreen', {}));
    expect(got).toContain('CLAUDE_CODE_NO_FLICKER=1');
  });

  /**
   * `docker exec` inherits the container environment, so emitting only the
   * wanted variable leaves the other one live if the container already carries
   * it — two contradictory overrides, and `auto` that can never get back to
   * Claude's own choice. Every mode therefore states both, blanking the one it
   * doesn't want (empty is falsy to Claude's check).
   */
  it('blanks the opposite variable rather than leaving it to the container env', () => {
    expect(pairs(claudeSessionEnvFlags('default', {}))).toEqual(
      expect.arrayContaining(['CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1', 'CLAUDE_CODE_NO_FLICKER=']),
    );
    expect(pairs(claudeSessionEnvFlags('fullscreen', {}))).toEqual(
      expect.arrayContaining(['CLAUDE_CODE_NO_FLICKER=1', 'CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=']),
    );
  });

  it('blanks both for `auto`, so a stale container value cannot win', () => {
    const got = pairs(claudeSessionEnvFlags('auto', {}));
    expect(got).toContain('CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=');
    expect(got).toContain('CLAUDE_CODE_NO_FLICKER=');
    expect(got).not.toContain('CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1');
    expect(got).not.toContain('CLAUDE_CODE_NO_FLICKER=1');
  });

  it('still forwards TERM and the model/auth keys', () => {
    const got = pairs(
      claudeSessionEnvFlags('default', {
        TERM: 'xterm-ghostty',
        ANTHROPIC_MODEL: 'claude-opus-5',
        CLAUDE_EFFORT: 'high',
        ANTHROPIC_API_KEY: '',
      }),
    );
    expect(got).toContain('TERM=xterm-ghostty');
    expect(got).toContain('ANTHROPIC_MODEL=claude-opus-5');
    expect(got).toContain('CLAUDE_EFFORT=high');
    // Empty values are dropped rather than forwarded as blanks.
    expect(got.some((p) => p.startsWith('ANTHROPIC_API_KEY='))).toBe(false);
  });

  it('defaults TERM when the host has none', () => {
    expect(pairs(claudeSessionEnvFlags('auto', {}))).toContain('TERM=xterm-256color');
  });

  it('emits well-formed `-e KEY=VALUE` pairs', () => {
    const flags = claudeSessionEnvFlags('default', { TERM: 'xterm' });
    expect(flags.length % 2).toBe(0);
    for (let i = 0; i < flags.length; i += 2) {
      expect(flags[i]).toBe('-e');
      expect(flags[i + 1]).toMatch(/^[A-Z_][A-Z0-9_]*=/);
    }
  });
});
