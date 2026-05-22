import { describe, expect, it } from 'vitest';
import {
  allocateShellSessionName,
  buildShellSessionAttachArgv,
  DEFAULT_SHELL_SESSION,
  isShellSessionName,
  parseShellSessionList,
  shellLabel,
  shellSessionName,
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
    const argv = buildShellSessionAttachArgv('agentbox-smoke', 'shell-work', 'root');
    expect(argv[argv.indexOf('--user') + 1]).toBe('root');
    expect(argv.slice(-2)).toEqual(['-t', 'shell-work']);
  });
});

describe('shellSessionName / shellLabel', () => {
  it('maps the default label to the bare `shell` session and back', () => {
    expect(shellSessionName()).toBe('shell');
    expect(shellSessionName('')).toBe('shell');
    expect(shellSessionName('shell')).toBe('shell');
    expect(shellLabel('shell')).toBe('shell');
  });

  it('prefixes named/numbered labels and round-trips them', () => {
    expect(shellSessionName('build')).toBe('shell-build');
    expect(shellSessionName('2')).toBe('shell-2');
    expect(shellLabel('shell-build')).toBe('build');
    expect(shellLabel('shell-2')).toBe('2');
  });
});

describe('isShellSessionName', () => {
  it('accepts the default and prefixed shell sessions', () => {
    expect(isShellSessionName('shell')).toBe(true);
    expect(isShellSessionName('shell-2')).toBe(true);
    expect(isShellSessionName('shell-build')).toBe(true);
  });

  it('rejects the claude agent session and dashboard grouped siblings', () => {
    expect(isShellSessionName('claude')).toBe(false);
    expect(isShellSessionName('claude-dash')).toBe(false);
    expect(isShellSessionName('shell-build-dash')).toBe(false);
    expect(isShellSessionName('work')).toBe(false);
  });
});

describe('allocateShellSessionName', () => {
  it('returns the bare `shell` when none exist', () => {
    expect(allocateShellSessionName([])).toBe('shell');
  });

  it('returns the lowest-free `shell-N` once earlier ones are taken', () => {
    expect(allocateShellSessionName(['shell'])).toBe('shell-2');
    expect(allocateShellSessionName(['shell', 'shell-2'])).toBe('shell-3');
    // gaps are filled (lowest-free), not max+1
    expect(allocateShellSessionName(['shell', 'shell-3'])).toBe('shell-2');
  });
});

describe('parseShellSessionList', () => {
  it('keeps only shell sessions, parses fields, and sorts default-first', () => {
    // tmux list-sessions -F '#{session_name}\t#{session_created}\t#{session_attached}'
    const stdout = [
      'claude\t1716000000\t1',
      'claude-dash\t1716000001\t1',
      'shell-build\t1716000300\t0',
      'shell\t1716000100\t1',
      '',
    ].join('\n');
    const sessions = parseShellSessionList(stdout);
    expect(sessions.map((s) => s.label)).toEqual(['shell', 'build']);
    const def = sessions[0]!;
    expect(def.sessionName).toBe('shell');
    expect(def.attached).toBe(true);
    expect(def.createdAt).toBe(new Date(1716000100 * 1000).toISOString());
    expect(sessions[1]!.attached).toBe(false);
  });

  it('returns [] for empty / no-server output', () => {
    expect(parseShellSessionList('')).toEqual([]);
    expect(parseShellSessionList('\n')).toEqual([]);
  });
});
