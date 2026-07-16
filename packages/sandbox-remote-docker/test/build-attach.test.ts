import { describe, expect, it, vi } from 'vitest';

// Mock the tunnel so buildAttach doesn't try to open a real SSH ControlMaster.
// `ensureTunnel` returns the ssh target the attach argv is built from; a bare
// host with no control socket is enough to exercise the command assembly.
vi.mock('../src/remote-docker.js', async () => {
  const actual =
    await vi.importActual<typeof import('../src/remote-docker.js')>('../src/remote-docker.js');
  return {
    ...actual,
    ensureTunnel: vi.fn(async () => ({ host: 'macmini' })),
  };
});

import { buildRemoteDockerAttach } from '../src/build-attach.js';
import type { BoxRecord } from '@agentbox/core';

function boxFixture(): BoxRecord {
  return {
    id: 'b1',
    name: 'proj-b1',
    provider: 'remote-docker',
    cloud: { backend: 'remote-docker', sandboxId: 'macmini/agentbox-proj-b1' },
  } as unknown as BoxRecord;
}

describe('buildRemoteDockerAttach', () => {
  it('runs the docker command through a LOGIN shell so `docker` is on PATH', async () => {
    const spec = await buildRemoteDockerAttach(boxFixture(), 'agent', {
      sessionName: 'agent',
      command: 'claude',
    });
    const remoteCommand = spec.argv.at(-1)!;
    // The bug this guards: without `bash -lc`, ssh runs the string in the remote
    // user's NON-login shell, where Docker Desktop / OrbStack aren't on PATH, so
    // the attach dies with "command not found: docker".
    expect(remoteCommand.startsWith('bash -lc ')).toBe(true);
    expect(remoteCommand).toContain('docker exec');
    expect(remoteCommand).toContain('agentbox-proj-b1');
  });

  it('allocates a TTY for an interactive attach but not for a detached pre-start', async () => {
    const box = boxFixture();
    const interactive = await buildRemoteDockerAttach(box, 'agent', { sessionName: 'agent' });
    expect(interactive.argv).toContain('-t');
    const remoteInteractive = interactive.argv.at(-1)!;
    expect(remoteInteractive).toContain('docker exec -it');

    const detached = await buildRemoteDockerAttach(box, 'agent', {
      sessionName: 'agent',
      detached: true,
    });
    expect(detached.argv).not.toContain('-t');
    const remoteDetached = detached.argv.at(-1)!;
    // detached only creates the session, so no TTY is requested of docker either.
    expect(remoteDetached).toContain('docker exec -i ');
  });
});
