import { execa } from 'execa';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CloudHandle } from '@agentbox/core';
import { makeMockCloudBackend, type MockCloudBackend } from '../src/mock-backend.js';
import { seedGitIdentity } from '../src/sync/git-identity.js';

const HANDLE: CloudHandle = { sandboxId: 'box1' };

function lastExecCmd(backend: MockCloudBackend): string {
  const execCalls = backend.calls.filter((c) => c.method === 'exec');
  const last = execCalls[execCalls.length - 1];
  return (last?.args[1] as string) ?? '';
}

describe('seedGitIdentity', () => {
  let repo: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'agentbox-gitid-'));
    await execa('git', ['init', '-q', repo]);
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("configures the box with the host repo's effective identity", async () => {
    // Local config wins over any global/system identity, so this is
    // deterministic regardless of the CI host's git setup.
    await execa('git', ['-C', repo, 'config', 'user.name', 'test-user']);
    await execa('git', ['-C', repo, 'config', 'user.email', 'test@example.com']);

    const backend = makeMockCloudBackend({ preloaded: [{ id: 'box1' }] });
    await seedGitIdentity(backend, HANDLE, { hostRepo: repo });

    const cmd = lastExecCmd(backend);
    expect(cmd).toContain('git config --global user.name test-user');
    expect(cmd).toContain('git config --global user.email test@example.com');
  });

  it('falls back to a generic agentbox identity when the host has none', async () => {
    // Isolate from any real global/system identity on the test host so the
    // non-configured temp repo resolves to nothing → fallback path.
    const prevGlobal = process.env['GIT_CONFIG_GLOBAL'];
    const prevSystem = process.env['GIT_CONFIG_SYSTEM'];
    process.env['GIT_CONFIG_GLOBAL'] = '/dev/null';
    process.env['GIT_CONFIG_SYSTEM'] = '/dev/null';
    try {
      const backend = makeMockCloudBackend({ preloaded: [{ id: 'box1' }] });
      await seedGitIdentity(backend, HANDLE, { hostRepo: repo });

      const cmd = lastExecCmd(backend);
      expect(cmd).toContain('git config --global user.name agentbox');
      expect(cmd).toContain('git config --global user.email agentbox@users.noreply.github.com');
    } finally {
      if (prevGlobal === undefined) delete process.env['GIT_CONFIG_GLOBAL'];
      else process.env['GIT_CONFIG_GLOBAL'] = prevGlobal;
      if (prevSystem === undefined) delete process.env['GIT_CONFIG_SYSTEM'];
      else process.env['GIT_CONFIG_SYSTEM'] = prevSystem;
    }
  });

  it('issues exactly one identity exec (both keys in one command)', async () => {
    const backend = makeMockCloudBackend({ preloaded: [{ id: 'box1' }] });
    await seedGitIdentity(backend, HANDLE, { hostRepo: repo });
    expect(backend.calls.filter((c) => c.method === 'exec')).toHaveLength(1);
  });
});
