import type { CloudBackend } from '@agentbox/core';
import { describe, expect, it } from 'vitest';
import { createCloudProvider } from '../src/index.js';

/**
 * Backends whose transport withholds a TTY from an *exec* session must not be
 * handed the attach command as an argument.
 *
 * Daytona's SSH gateway is one: `ssh -tt <token>@ssh.app.daytona.io 'tty'`
 * answers "not a tty", while the same connection with no command lands on a real
 * /dev/pts. `tmux attach` exits instantly without a terminal, the wrapper reads
 * that as the box dropping, and it reconnects straight back into the same
 * failure — which is exactly how this surfaced ("box rebooting — reconnecting…"
 * on a box that was perfectly healthy).
 */
function makeBackend(over: Partial<CloudBackend> = {}): CloudBackend {
  return {
    name: 'fake',
    provision: async () => ({ sandboxId: 'sb' }),
    exec: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    state: async () => 'running',
    destroy: async () => {},
    previewUrl: async () => ({ url: 'https://x' }),
    attachArgv: async () => ['ssh', '-o', 'X=1', 'tok@gateway'],
    ...over,
  } as unknown as CloudBackend;
}

const record = {
  id: 'b1',
  name: 'b1',
  provider: 'fake',
  container: 'cloud:sb',
  image: 'img',
  workspacePath: '/tmp',
  createdAt: new Date().toISOString(),
  cloud: { backend: 'fake', sandboxId: 'sb', webPort: 8080 },
} as never;

describe('buildAttach on a backend whose exec sessions get no TTY', () => {
  it('stages the command as a script and types one short line to run it', async () => {
    const execs: string[] = [];
    const provider = createCloudProvider(
      makeBackend({
        attachExecLacksTty: true,
        exec: async (_h, cmd: string) => {
          execs.push(cmd);
          return { exitCode: 0, stdout: '', stderr: '' };
        },
      } as Partial<CloudBackend>),
    );
    const spec = await provider.buildAttach!(record, 'agent', { sessionName: 'claude' });

    // No remote command, and no `-t` (a bare login shell already gets a terminal).
    expect(spec.argv).toEqual(['ssh', '-o', 'X=1', 'tok@gateway']);
    expect(spec.argv).not.toContain('-t');

    // The real command is staged over a plain exec (no TTY needed there) rather
    // than typed: it's long and quote-heavy, and an interactive shell's line
    // editor mangles it into a `>` continuation prompt.
    expect(execs).toHaveLength(1);
    expect(execs[0]).toMatch(/base64 -d > \/tmp\/agentbox-attach-claude\.sh/);
    const staged = Buffer.from(
      /printf %s '([^']+)'/.exec(execs[0]!)![1]!,
      'base64',
    ).toString('utf8');
    expect(staged).toMatch(/tmux attach -t 'claude'/);

    // ...and only a short line is typed, newline-terminated so it actually runs.
    expect(spec.initialInput).toBe('exec bash /tmp/agentbox-attach-claude.sh\n');
  });

  it('still passes a remote command for a detached build (no TTY wanted)', async () => {
    const provider = createCloudProvider(makeBackend({ attachExecLacksTty: true }));
    const spec = await provider.buildAttach!(record, 'agent', {
      sessionName: 'claude',
      detached: true,
    });
    // Detached only creates the session — a non-interactive exec is correct, and
    // typing into a PTY nobody is watching would not run it.
    expect(spec.argv.some((a) => a.includes('tmux'))).toBe(true);
    expect(spec.initialInput).toBeUndefined();
  });

  it('leaves a normal backend on the remote-command form', async () => {
    const provider = createCloudProvider(makeBackend());
    const spec = await provider.buildAttach!(record, 'agent', { sessionName: 'claude' });
    expect(spec.argv).toContain('-t');
    expect(spec.argv.some((a) => a.includes('tmux attach'))).toBe(true);
    expect(spec.initialInput).toBeUndefined();
  });
});
