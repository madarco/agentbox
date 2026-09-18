import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { CloudBackend } from '@agentbox/core';
import { executeCloudAction, setCloudBackendLoader } from '../src/host-actions.js';
import { PendingPrompts, PromptSubscribers } from '../src/prompts.js';
import type { HostAction } from '../src/types.js';

/**
 * The cloud twin of the docker push gate in `server.test.ts`: the box's argv
 * tail is appended to the relay's own `push <remote> <branch>`, so a bypass is
 * only safe while every ref that tail would write is already sanctioned.
 *
 * With no SSE subscriber attached, a push that must be approved auto-denies
 * ("no attached wrapper to confirm") — which is the decisive signal that it
 * reached the gate rather than bypassing it.
 */
describe('cloud git.push argv-tail targets', () => {
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

  it('a scratch-branch push with a routine tail still bypasses the gate', async () => {
    const r = await push(['--force']);
    expect(r.stderr).not.toMatch(/no attached wrapper/);
    expect(r.stderr).toMatch(/bundle create failed/);
  });

  it("a tail naming the box's own branch still bypasses the gate", async () => {
    const r = await push([`HEAD:refs/heads/${BRANCH}`]);
    expect(r.stderr).toMatch(/bundle create failed/);
  });

  it('a tail that adds an unsanctioned refspec must ask, even on a scratch branch', async () => {
    const r = await push(['other-branch']);
    expect(r.exitCode).toBe(10);
    expect(r.stderr).toMatch(/no attached wrapper to confirm/);
  });

  it('the same holds for a fully-qualified injected refspec', async () => {
    const r = await push(['HEAD:refs/heads/other']);
    expect(r.exitCode).toBe(10);
    expect(r.stderr).toMatch(/no attached wrapper to confirm/);
  });
});
