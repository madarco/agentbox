import { describe, expect, it } from 'vitest';
import { makeControlPlaneCreateBox, type CreateBoxDeps } from '../src/control-plane/create-box.js';

describe('makeControlPlaneCreateBox', () => {
  it('leases → clones → creates, returns the box id, and cleans up', async () => {
    const calls: string[] = [];
    const deps: CreateBoxDeps = {
      leaseRemoteUrl: (repoUrl) => {
        calls.push(`lease:${repoUrl}`);
        return Promise.resolve(`https://x-access-token:tok@github.com/acme/widgets.git`);
      },
      cloneRepo: (authedUrl, repoUrl, dest) => {
        calls.push(`clone:${authedUrl}->${dest}`);
        // The authed URL (with token) is used for the clone; the bare origin is restored by the caller.
        expect(authedUrl).toContain('x-access-token');
        expect(repoUrl).not.toContain('x-access-token');
        return Promise.resolve();
      },
      createBox: ({ workspacePath, name, provider }) => {
        calls.push(`create:${provider}:${name}:${workspacePath}`);
        return Promise.resolve({ id: 'box-42' });
      },
      tmpDir: (jobId) => `/tmp/cp-${jobId}`,
      cleanup: (dir) => {
        calls.push(`cleanup:${dir}`);
        return Promise.resolve();
      },
    };
    const fn = makeControlPlaneCreateBox(deps);
    const result = await fn(
      { repoUrl: 'https://github.com/acme/widgets.git', provider: 'hetzner', name: 'demo' },
      'job1',
    );
    expect(result).toEqual({ boxId: 'box-42' });
    expect(calls).toEqual([
      'lease:https://github.com/acme/widgets.git',
      'clone:https://x-access-token:tok@github.com/acme/widgets.git->/tmp/cp-job1',
      'create:hetzner:demo:/tmp/cp-job1',
      'cleanup:/tmp/cp-job1',
    ]);
  });

  it('passes the requested branch through to the clone', async () => {
    let clonedBranch: string | undefined = 'UNSET';
    const deps: CreateBoxDeps = {
      leaseRemoteUrl: () => Promise.resolve('https://x-access-token:t@github.com/a/b.git'),
      cloneRepo: (_authedUrl, _repoUrl, _dest, branch) => {
        clonedBranch = branch;
        return Promise.resolve();
      },
      createBox: () => Promise.resolve({ id: 'box-9' }),
      tmpDir: () => '/tmp/cp-b',
      cleanup: () => Promise.resolve(),
    };
    const fn = makeControlPlaneCreateBox(deps);
    await fn({ repoUrl: 'https://github.com/a/b.git', provider: 'hetzner', branch: 'dev' }, 'jb');
    expect(clonedBranch).toBe('dev');
  });

  it('cleans up even when create fails', async () => {
    let cleaned = false;
    const deps: CreateBoxDeps = {
      leaseRemoteUrl: () => Promise.resolve('https://x-access-token:t@github.com/a/b.git'),
      cloneRepo: () => Promise.resolve(),
      createBox: () => Promise.reject(new Error('provider boom')),
      tmpDir: () => '/tmp/cp-x',
      cleanup: () => {
        cleaned = true;
        return Promise.resolve();
      },
    };
    const fn = makeControlPlaneCreateBox(deps);
    await expect(fn({ repoUrl: 'https://github.com/a/b.git', provider: 'e2b' }, 'jx')).rejects.toThrow(
      /provider boom/,
    );
    expect(cleaned).toBe(true); // worker marks the job failed; temp dir still removed
  });
});
