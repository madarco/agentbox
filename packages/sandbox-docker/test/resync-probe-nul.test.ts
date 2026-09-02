import { describe, expect, it, vi } from 'vitest';

const calls: { argv: string[]; input?: string }[] = [];
vi.mock('execa', () => ({
  execa: (_bin: string, argv: string[], opts?: { input?: string }) => {
    calls.push({ argv, input: opts?.input });
    return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
  },
}));

const { makeDockerResyncPorts } = await import('../src/sync/in-box-git.js');

describe('docker probeUntrackedTokens', () => {
  it('NUL-TERMINATES the path list, so the last path is actually probed', async () => {
    // Regression, reproduced live: `relPaths.join('\0')` leaves the final record
    // unterminated and `read -r -d ""` treats an unterminated tail as EOF. The
    // last untracked path came back as "absent in the box", so the overlay
    // OVERWROTE a box file it was supposed to keep. Same defect the cloud
    // resync had.
    calls.length = 0;
    const ports = makeDockerResyncPorts('agentbox-svc');
    await ports.probeUntrackedTokens('/workspace', ['dirty.txt', 'shared.txt']);
    expect(calls.at(-1)?.input).toBe('dirty.txt\0shared.txt\0');
  });

  it('sends no payload at all for an empty path list', async () => {
    calls.length = 0;
    const ports = makeDockerResyncPorts('agentbox-svc');
    await ports.probeUntrackedTokens('/workspace', []);
    expect(calls.at(-1)?.input).toBe('');
  });
});
