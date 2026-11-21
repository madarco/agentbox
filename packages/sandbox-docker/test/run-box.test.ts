import { beforeEach, describe, expect, it, vi } from 'vitest';

const execaMock = vi.hoisted(() => vi.fn());
vi.mock('execa', () => ({ execa: execaMock }));

import {
  isMissingDockerInit,
  MISSING_DOCKER_INIT_WARNING,
  runBox,
  runBoxArgv,
} from '../src/docker.js';

// Verbatim from docker 29.1.3 with /usr/bin/docker-init removed.
const NO_INIT_STDERR =
  'docker: Error response from daemon: exec: "docker-init": executable file not found in $PATH\n\nRun \'docker run --help\' for more information';

const spec = { name: 'agentbox-x', image: 'agentbox/box:dev' };

describe('runBoxArgv', () => {
  it('runs tini as PID 1 so orphaned processes get reaped', () => {
    const argv = runBoxArgv(spec);
    expect(argv).toContain('--init');
    expect(argv.indexOf('--init')).toBeLessThan(argv.indexOf('agentbox/box:dev'));
    expect(argv.slice(-3)).toEqual(['agentbox/box:dev', 'sleep', 'infinity']);
  });

  it('omits --init only when asked (missing-docker-init fallback)', () => {
    expect(runBoxArgv(spec, { init: false })).not.toContain('--init');
  });
});

describe('isMissingDockerInit', () => {
  it('matches the engine error for a missing docker-init', () => {
    expect(isMissingDockerInit(NO_INIT_STDERR)).toBe(true);
    expect(
      isMissingDockerInit(
        'Error response from daemon: exec: "/opt/bin/docker-init": stat /opt/bin/docker-init: no such file or directory',
      ),
    ).toBe(true);
  });

  it('does not match other docker run failures', () => {
    for (const other of [
      'docker: Error response from daemon: Conflict. The container name "/agentbox-x" is already in use',
      "Unable to find image 'agentbox/box:dev' locally",
      'exec: "sleep": executable file not found in $PATH: unknown',
      'Error response from daemon: unknown flag: --init',
    ]) {
      expect(isMissingDockerInit(other)).toBe(false);
    }
  });
});

describe('runBox', () => {
  beforeEach(() => execaMock.mockReset());

  it('retries once without --init, after removing the half-created container', async () => {
    execaMock
      .mockRejectedValueOnce(Object.assign(new Error('Command failed'), { stderr: NO_INIT_STDERR }))
      .mockResolvedValueOnce({ stdout: '' })
      .mockResolvedValueOnce({ stdout: 'abc123\n' });
    const onLog = vi.fn();

    await expect(runBox({ ...spec, onLog })).resolves.toBe('abc123');

    const calls = execaMock.mock.calls.map((c) => c[1] as string[]);
    expect(calls).toHaveLength(3);
    expect(calls[0]).toContain('--init');
    expect(calls[1]).toEqual(['rm', '-f', 'agentbox-x']);
    expect(calls[2]).not.toContain('--init');
    expect(onLog).toHaveBeenCalledTimes(1);
    expect(onLog).toHaveBeenCalledWith(MISSING_DOCKER_INIT_WARNING);
  });

  it('rethrows any other failure without retrying', async () => {
    const err = Object.assign(new Error('Command failed'), { stderr: 'Conflict. name in use' });
    execaMock.mockRejectedValueOnce(err);

    await expect(runBox(spec)).rejects.toBe(err);
    expect(execaMock).toHaveBeenCalledTimes(1);
  });
});
