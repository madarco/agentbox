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

  it('applies seed material after the clone and before the box is provisioned', async () => {
    const calls: string[] = [];
    const deps: CreateBoxDeps = {
      leaseRemoteUrl: () => Promise.resolve('https://x-access-token:t@github.com/a/b.git'),
      cloneRepo: () => {
        calls.push('clone');
        return Promise.resolve();
      },
      fetchSeedMaterial: (repoUrl, dest) => {
        calls.push(`seed:${repoUrl}->${dest}`);
        return Promise.resolve({ files: 3, repoHeadSha: 'abcdef1234', capturedAt: '2026-07-01' });
      },
      createBox: () => {
        calls.push('create');
        return Promise.resolve({ id: 'box-1' });
      },
      tmpDir: () => '/tmp/cp-s',
      cleanup: () => Promise.resolve(),
    };
    const fn = makeControlPlaneCreateBox(deps);
    await fn({ repoUrl: 'https://github.com/a/b.git', provider: 'e2b' }, 'js');
    // Order matters: the seed overlays the checkout the box is created from.
    expect(calls).toEqual(['clone', 'seed:https://github.com/a/b.git->/tmp/cp-s', 'create']);
  });

  it('still creates the box when seed material is unavailable', async () => {
    const logs: string[] = [];
    let created = false;
    const deps: CreateBoxDeps = {
      leaseRemoteUrl: () => Promise.resolve('https://x-access-token:t@github.com/a/b.git'),
      cloneRepo: () => Promise.resolve(),
      fetchSeedMaterial: () => Promise.reject(new Error('custody down')),
      createBox: () => {
        created = true;
        return Promise.resolve({ id: 'box-2' });
      },
      tmpDir: () => '/tmp/cp-s2',
      cleanup: () => Promise.resolve(),
      log: (l) => logs.push(l),
    };
    const fn = makeControlPlaneCreateBox(deps);
    const res = await fn({ repoUrl: 'https://github.com/a/b.git', provider: 'e2b' }, 'js2');
    // A box without the user's untracked files still beats a failed create.
    expect(res).toEqual({ boxId: 'box-2' });
    expect(created).toBe(true);
    expect(logs.join('\n')).toMatch(/seed material unavailable.*custody down/);
  });

  it("forwards the job's agent to the provider, so an adopting PC knows what to relaunch", async () => {
    // Regression: the create job carried `agent` and the registration had a slot
    // for it, but the orchestrator never passed it through — so every hub-created
    // box registered without one and adopted with no `lastAgent`.
    let seen: string | undefined = 'UNSET';
    const deps: CreateBoxDeps = {
      leaseRemoteUrl: () => Promise.resolve('https://x-access-token:t@github.com/a/b.git'),
      cloneRepo: () => Promise.resolve(),
      createBox: ({ agent }) => {
        seen = agent;
        return Promise.resolve({ id: 'box-4' });
      },
      tmpDir: () => '/tmp/cp-a',
      cleanup: () => Promise.resolve(),
    };
    const fn = makeControlPlaneCreateBox(deps);
    await fn({ repoUrl: 'https://github.com/a/b.git', provider: 'e2b', agent: 'codex' }, 'ja');
    expect(seen).toBe('codex');
  });

  it('creates from the bare clone when no seed step is wired', async () => {
    const deps: CreateBoxDeps = {
      leaseRemoteUrl: () => Promise.resolve('https://x-access-token:t@github.com/a/b.git'),
      cloneRepo: () => Promise.resolve(),
      createBox: () => Promise.resolve({ id: 'box-3' }),
      tmpDir: () => '/tmp/cp-s3',
      cleanup: () => Promise.resolve(),
    };
    const fn = makeControlPlaneCreateBox(deps);
    await expect(
      fn({ repoUrl: 'https://github.com/a/b.git', provider: 'e2b' }, 'js3'),
    ).resolves.toEqual({ boxId: 'box-3' });
  });
});
