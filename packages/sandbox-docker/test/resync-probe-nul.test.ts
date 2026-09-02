import { describe, expect, it, vi } from 'vitest';

const calls: { argv: string[]; input?: string }[] = [];
let nextResult = { exitCode: 0, stdout: '', stderr: '' };
vi.mock('execa', () => ({
  execa: (_bin: string, argv: string[], opts?: { input?: string }) => {
    calls.push({ argv, input: opts?.input });
    return Promise.resolve(nextResult);
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

  it('THROWS on a failed probe instead of returning an empty map', async () => {
    // Fail-closed. An empty map reads downstream as "the box has none of these
    // paths", so the untracked overlay copies every host file over the box's —
    // the inverse of the box-wins contract. Same class as the NUL bug above.
    nextResult = { exitCode: 1, stdout: '', stderr: 'docker exec: no such container' };
    try {
      const ports = makeDockerResyncPorts('agentbox-svc');
      await expect(ports.probeUntrackedTokens('/workspace', ['a.txt'])).rejects.toThrow(
        /no such container/,
      );
    } finally {
      nextResult = { exitCode: 0, stdout: '', stderr: '' };
    }
  });
});
