import { beforeEach, describe, expect, it, vi } from 'vitest';

const { execaMock } = vi.hoisted(() => ({ execaMock: vi.fn() }));
vi.mock('execa', () => ({ execa: execaMock }));

const { rsyncPullMock } = vi.hoisted(() => ({ rsyncPullMock: vi.fn() }));
vi.mock('@agentbox/sandbox-core', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  rsyncPullToHost: rsyncPullMock,
}));

const { pullToHost } = await import('../src/sync/host-export.js');

const BOX = {
  id: 'abc123',
  name: 'ada',
  projectIndex: 1,
  container: 'agentbox-ada',
  workspacePath: '/proj',
};

beforeEach(() => {
  execaMock.mockReset();
  // The in-box file list; anything else (rsync refresh, docker exec) is a no-op.
  execaMock.mockResolvedValue({ exitCode: 0, stdout: 'MODE=git\napp.ts\0', stderr: '' });
  rsyncPullMock.mockReset();
  rsyncPullMock.mockResolvedValue({ changes: [], applied: true, missing: [] });
});

/**
 * `download --backup` writes the workspace half somewhere other than the user's
 * working dir. The cloud pull has always taken the destination as a parameter;
 * this one had it wired to the box record, which is the only reason the two
 * could not share a caller.
 */
describe('pullToHost', () => {
  it("defaults to the box's own workspace path", async () => {
    const r = await pullToHost(BOX, { noRefresh: true });
    expect((rsyncPullMock.mock.calls[0]![0] as { destDir: string }).destDir).toBe('/proj');
    expect(r.hostPath).toBe('/proj');
  });

  it('writes to destDir when asked, and reports that path back', async () => {
    // `hostPath` must follow: it is what the CLI prints, and printing the
    // project dir after writing to a backup dir would be a lie.
    const dest = '/proj/.agentbox/bots/ada/2026-09-07T14-03-11Z/workspace';
    const r = await pullToHost(BOX, { noRefresh: true, destDir: dest });
    expect((rsyncPullMock.mock.calls[0]![0] as { destDir: string }).destDir).toBe(dest);
    expect(r.hostPath).toBe(dest);
  });
});
