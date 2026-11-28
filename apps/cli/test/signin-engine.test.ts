import { describe, expect, it, vi } from 'vitest';
import type { DockerRun } from '@agentbox/sandbox-docker';
import { hubSigninEngine, withContainerName } from '../src/lib/signin-engine.js';

const ok = { exitCode: 0, stdout: '', stderr: '' };

describe('withContainerName', () => {
  it('names the container right after `run`', () => {
    expect(withContainerName(['run', '-it', 'img', 'claude'], 'v-signin-1')).toEqual([
      'run',
      '--name',
      'v-signin-1',
      '-it',
      'img',
      'claude',
    ]);
  });

  it('refuses anything that is not a docker run', () => {
    expect(() => withContainerName(['exec', 'x'], 'n')).toThrow(/not a docker run/);
  });
});

describe('hubSigninEngine', () => {
  const engine = (run: DockerRun) =>
    hubSigninEngine({
      alias: 'hub',
      run,
      ttyCommand: (argv) => ({ file: 'ssh', args: ['-tt', 'h', ...argv] }),
      ensureAgentImage: () => Promise.resolve('img'),
    });

  it('holds no account volumes, so the store is where a login lands', () => {
    expect(engine(() => Promise.resolve(ok)).hostsAccountVolumes).toBe(false);
  });

  it('creates an unseeded scratch volume on the engine, and says why it could not', async () => {
    const run = vi.fn<DockerRun>().mockResolvedValue(ok);
    await engine(run).prepareVolume({ runtime: {} } as never, 'v-signin-1', 'img', 'default');
    expect(run).toHaveBeenCalledWith(['volume', 'create', 'v-signin-1']);
    // An agent that asks for first-run state gets it, on the engine.
    const seedLoginVolume = vi.fn().mockResolvedValue(undefined);
    await engine(run).prepareVolume(
      { runtime: { seedLoginVolume } } as never,
      'v',
      'img',
      'default',
    );
    expect(seedLoginVolume).toHaveBeenCalledWith('v', 'img', run);
    const bad: DockerRun = () => Promise.resolve({ exitCode: 1, stdout: '', stderr: 'disk full' });
    await expect(
      engine(bad).prepareVolume({ runtime: {} } as never, 'v', 'img', 'default'),
    ).rejects.toThrow(/on hub: disk full/);
  });

  it('wraps the login argv for a remote tty, container named after the volume', () => {
    const cmd = engine(() => Promise.resolve(ok)).loginCommand(['run', '-it', 'img'], 'v-signin-1');
    expect(cmd).toEqual({
      file: 'ssh',
      args: ['-tt', 'h', 'run', '--name', 'v-signin-1', '-it', 'img'],
    });
  });
});
