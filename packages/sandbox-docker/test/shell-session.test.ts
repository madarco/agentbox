import { describe, expect, it } from 'vitest';
import {
  buildShellSessionAttachArgv,
  DEFAULT_SHELL_SESSION,
} from '../src/shell-session.js';

describe('buildShellSessionAttachArgv', () => {
  it('attaches an interactive terminal to the default shell session as vscode', () => {
    const argv = buildShellSessionAttachArgv('agentbox-smoke');
    expect(argv.slice(0, 2)).toEqual(['exec', '-it']);
    expect(argv).toContain('--user');
    expect(argv[argv.indexOf('--user') + 1]).toBe('vscode');
    expect(argv).toContain('agentbox-smoke');
    expect(argv.slice(-4)).toEqual(['tmux', 'attach', '-t', DEFAULT_SHELL_SESSION]);
    // TERM is forwarded so tmux declares true-color / hyperlink support.
    expect(argv).toContain('-e');
  });

  it('honors a custom session name and user', () => {
    const argv = buildShellSessionAttachArgv('agentbox-smoke', 'work', 'root');
    expect(argv[argv.indexOf('--user') + 1]).toBe('root');
    expect(argv.slice(-2)).toEqual(['-t', 'work']);
  });
});
