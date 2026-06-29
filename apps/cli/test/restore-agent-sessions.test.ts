import type { BoxRecord, ExecResult, Provider } from '@agentbox/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Mock the light deps so `restoreAgentSessions` runs without docker/config IO.
// loadEffectiveConfig only supplies session names + skip-permissions here.
vi.mock('@agentbox/config', () => ({
  loadEffectiveConfig: vi.fn(async () => ({
    effective: {
      claude: { sessionName: 'claude' },
      codex: { sessionName: 'codex' },
      opencode: { sessionName: 'opencode' },
    },
  })),
}));
interface StartDetachedArgs {
  binary: string;
  sessionName: string;
}
const cloudAgentStartDetached = vi.fn<(args: StartDetachedArgs) => Promise<void>>(() =>
  Promise.resolve(),
);
vi.mock('../src/commands/_cloud-attach.js', () => ({
  cloudAgentStartDetached: (args: StartDetachedArgs) => cloudAgentStartDetached(args),
}));

const { restoreAgentSessions } = await import('../src/agent-sessions.js');

/** Cloud box (provider !== docker) so the launcher is cloudAgentStartDetached. */
const box = {
  id: 'b1',
  name: 'smoke',
  container: 'cloud:sb1',
  provider: 'daytona',
  workspacePath: '/tmp/ws',
} as BoxRecord;

/**
 * Fake provider: every `tmux has-session` probe misses (exit 1) and every
 * pointer read is empty — so nothing is resumable and the fresh-launch pass is
 * the only thing that can start an agent.
 */
function deadBoxProvider(): Provider {
  const exec = vi.fn(async (_box, argv: string[]): Promise<ExecResult> => {
    const script = argv.join(' ');
    if (script.includes('has-session')) return { exitCode: 1, stdout: '', stderr: '' };
    return { exitCode: 0, stdout: '', stderr: '' };
  });
  return { name: 'daytona', exec } as unknown as Provider;
}

describe('restoreAgentSessions launchFresh', () => {
  afterEach(() => cloudAgentStartDetached.mockClear());

  it('starts the lastAgent fresh when nothing is resumable', async () => {
    await restoreAgentSessions(box, deadBoxProvider(), { launchFresh: 'opencode' });
    expect(cloudAgentStartDetached).toHaveBeenCalledTimes(1);
    const arg = cloudAgentStartDetached.mock.calls[0]![0];
    expect(arg.binary).toBe('opencode');
    expect(arg.sessionName).toBe('opencode');
  });

  it('does nothing without launchFresh when nothing is resumable', async () => {
    await restoreAgentSessions(box, deadBoxProvider(), {});
    expect(cloudAgentStartDetached).not.toHaveBeenCalled();
  });
});
