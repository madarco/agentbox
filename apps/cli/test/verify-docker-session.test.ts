import { beforeEach, describe, expect, it, vi } from 'vitest';

const execInBox = vi.fn();
vi.mock('@agentbox/sandbox-docker', () => ({ execInBox }));

const { verifyDockerAgentSession } = await import('../src/lib/queue/verify-docker-session.js');

const args = { container: 'agentbox-b1', boxName: 'b1', sessionName: 'claude', binary: 'claude' };

describe('verifyDockerAgentSession', () => {
  beforeEach(() => execInBox.mockReset());

  // The agent's own output can carry an auth-failure marker; docker checked the
  // login before the create, so the pane is not scanned.
  it('does not fail a live session whose pane prints an auth-looking line', async () => {
    execInBox.mockResolvedValue({ exitCode: 0, stdout: 'throw new Unauthorized()', stderr: '' });
    await expect(verifyDockerAgentSession({ ...args, windowMs: 0 })).resolves.toBeUndefined();
    expect(execInBox).toHaveBeenCalledWith(
      'agentbox-b1',
      ['bash', '-lc', expect.stringContaining('tmux has-session')],
      { user: 'vscode' },
    );
  });

  it('fails when the session is gone', async () => {
    execInBox.mockResolvedValue({ exitCode: 7, stdout: '', stderr: '' });
    await expect(verifyDockerAgentSession({ ...args, windowMs: 0 })).rejects.toThrow(
      /exited immediately after launch in box b1/,
    );
  });
});
