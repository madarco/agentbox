import { describe, expect, it } from 'vitest';
import { buildCreateosAttachArgv } from '../src/build-attach.js';

describe('buildCreateosAttachArgv', () => {
  it('uses CreateOS managed PTY for interactive agent attaches', () => {
    expect(
      buildCreateosAttachArgv({
        bin: 'createos',
        sandboxId: 'sb_123',
        kind: 'agent',
        inner: 'exec tmux attach -t claude',
      }),
    ).toEqual([
      'createos',
      'sandbox',
      'process',
      'run',
      '--cwd',
      '/workspace',
      '--pty',
      'sb_123',
      '--',
      'sudo',
      '-u',
      'vscode',
      '-H',
      'bash',
      '-lc',
      'exec tmux attach -t claude',
    ]);
  });

  it('does not allocate a PTY for detached pre-start commands', () => {
    expect(
      buildCreateosAttachArgv({
        bin: 'createos',
        sandboxId: 'sb_123',
        kind: 'agent',
        inner: 'tmux new-session -d',
        detached: true,
      }),
    ).not.toContain('--pty');
  });
});

