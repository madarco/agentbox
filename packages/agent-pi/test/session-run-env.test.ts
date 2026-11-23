import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveAgentSpec } from '@agentbox/sandbox-core';

const { execaMock } = vi.hoisted(() => ({ execaMock: vi.fn() }));
vi.mock('execa', () => ({ execa: execaMock }));

const { startPiSession } = await import('../src/docker-sync.js');

/**
 * The declared `boxRunEnv` reaches the docker container only as create-time
 * env, and only on a box created for pi. Started in a box created for
 * another agent, the tmux server already exists and a new session inherits
 * the server's environment, not the exec's — so the env has to ride
 * `tmux new-session -e`, or the synced config is not where pi looks.
 */
describe('startPiSession passes boxRunEnv to the tmux session', () => {
  beforeEach(() => {
    execaMock.mockReset();
    execaMock.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
  });

  it('sets every declared key with new-session -e', async () => {
    await startPiSession({ container: 'c', piArgs: [], sessionName: 'pi' });
    const argv = execaMock.mock.calls[0]![1] as string[];
    const end = argv.indexOf(';') === -1 ? argv.length : argv.indexOf(';');
    const tmux = argv.slice(argv.indexOf('new-session'), end);
    const declared = Object.entries(resolveAgentSpec('pi').boxRunEnv);
    expect(declared.length).toBeGreaterThan(0);
    for (const [k, v] of declared) {
      const i = tmux.indexOf(`${k}=${v}`);
      expect(i, `${k} missing from tmux new-session`).toBeGreaterThan(0);
      expect(tmux[i - 1]).toBe('-e');
    }
  });
});

describe('startPiSession creates the --skill dir before launching', () => {
  beforeEach(() => {
    execaMock.mockReset();
    execaMock.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
  });

  it('runs mkdir -p on the library dir, then execs pi with --skill', async () => {
    // pi >= 0.84 warns "skill path does not exist" on every launch otherwise.
    await startPiSession({ container: 'c', piArgs: [], sessionName: 'pi' });
    const argv = execaMock.mock.calls[0]![1] as string[];
    const cmd = argv.find((a) => a.includes('--skill'));
    expect(cmd).toMatch(
      /^mkdir -p \/home\/vscode\/\.local\/share\/agentbox\/skills 2>\/dev\/null; exec pi -a --skill /,
    );
  });
});
