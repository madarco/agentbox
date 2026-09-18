import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { CloudBackend } from '@agentbox/core';
import { executeCloudAction, setCloudBackendLoader } from '../src/host-actions.js';
import { PendingPrompts, PromptSubscribers } from '../src/prompts.js';
import type { HostAction } from '../src/types.js';

/**
 * The cloud twin of the docker push gate in `server.test.ts`, on the same
 * verdict: adding commits to any branch is ordinary work and runs silently,
 * and only the irreversible asks.
 *
 * With no SSE subscriber attached, a push that must be approved auto-denies
 * ("no attached wrapper to confirm") — which is the decisive signal that it
 * reached the gate rather than bypassing it.
 */
describe('cloud git.push destructive argv', () => {
  const BRANCH = 'agentbox/box-one';
  const execLog: string[] = [];

  const backend = {
    name: 'fake',
    async exec(_handle: unknown, cmd: string) {
      execLog.push(cmd);
      if (cmd.includes('rev-parse --abbrev-ref HEAD')) {
        return { exitCode: 0, stdout: `${BRANCH}\n`, stderr: '' };
      }
      // Anything past the gate fails here, with a message no gate produces.
      return { exitCode: 1, stdout: '', stderr: 'fake backend: refused' };
    },
  } as unknown as CloudBackend;

  beforeEach(async () => {
    execLog.length = 0;
    delete process.env.AGENTBOX_PROMPT;
    const dir = join(homedir(), '.agentbox');
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'state.json'),
      JSON.stringify({
        version: 1,
        boxes: [
          {
            id: 'box1',
            name: 'box-one',
            provider: 'daytona',
            workspacePath: '/tmp',
            cloud: { sandboxId: 'sb1', workspaceBranch: BRANCH, sanctionedBranch: BRANCH },
          },
        ],
      }),
    );
    setCloudBackendLoader({
      id: 'test',
      resolveBackend: async () => backend,
      loadCloudCp: () => Promise.reject(new Error('not used')),
    });
  });

  afterEach(() => {
    setCloudBackendLoader(undefined);
  });

  function deps(): Parameters<typeof executeCloudAction>[1] {
    return {
      backendName: 'fake',
      boxId: 'box1',
      boxName: 'box-one',
      prompts: new PendingPrompts(),
      subscribers: new PromptSubscribers(),
      log: () => {},
    };
  }

  function push(args?: string[]): Promise<{ exitCode: number; stderr: string }> {
    const action: HostAction = {
      id: 'a1',
      boxId: 'box1',
      method: 'git.push',
      params: { path: '/workspace', ...(args ? { args } : {}) },
      createdAt: new Date().toISOString(),
    };
    return executeCloudAction(action, deps()) as Promise<{ exitCode: number; stderr: string }>;
  }

  it('an ordinary push bypasses the gate, on any branch', async () => {
    for (const args of [undefined, ['some-new-branch'], ['HEAD:refs/heads/other'], ['--tags']]) {
      const r = await push(args);
      expect(r.stderr).not.toMatch(/no attached wrapper/);
      expect(r.stderr).toMatch(/bundle create failed/);
    }
  });

  it("a force-push to the box's own scratch branch bypasses the gate", async () => {
    for (const args of [['--force'], ['+HEAD:refs/heads/agentbox/other'], ['--force-with-lease']]) {
      const r = await push(args);
      expect(r.stderr).toMatch(/bundle create failed/);
    }
  });

  it('a deletion must ask', async () => {
    const r = await push(['--delete', 'some-branch']);
    expect(r.exitCode).toBe(10);
    expect(r.stderr).toMatch(/no attached wrapper to confirm/);
  });

  it('a force-push to a branch the box did not create must ask', async () => {
    const r = await push(['--force', 'main']);
    expect(r.exitCode).toBe(10);
    expect(r.stderr).toMatch(/no attached wrapper to confirm/);
  });

  it('the wholesale ref syncs, a redirected repo and an unknown flag must ask', async () => {
    for (const args of [['--mirror'], ['--prune'], ['--repo', 'https://e/x.git'], ['--nope']]) {
      const r = await push(args);
      expect(r.exitCode).toBe(10);
      expect(r.stderr).toMatch(/no attached wrapper to confirm/);
    }
  });
});
