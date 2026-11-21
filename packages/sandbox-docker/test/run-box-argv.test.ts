import { beforeEach, describe, expect, it, vi } from 'vitest';

// execa is mocked so the test never shells out to a real docker.
const { execaMock } = vi.hoisted(() => ({ execaMock: vi.fn() }));
vi.mock('execa', () => ({ execa: execaMock }));

import { runBox } from '../src/docker.js';

describe('runBox argv', () => {
  beforeEach(() => {
    execaMock.mockReset();
    execaMock.mockResolvedValue({ stdout: 'cid\n', stderr: '', exitCode: 0 });
  });

  it('carries the cap/security/cgroup set the in-box dockerd needs', async () => {
    await runBox({ name: 'agentbox-x', image: 'agentbox/box:dev' });
    const argv = execaMock.mock.calls[0]![1] as string[];
    for (const flag of [
      '--cap-add=SYS_ADMIN',
      '--cap-add=NET_ADMIN',
      // #396: without it the inner dockerd can't start any image whose USER is non-root.
      '--cap-add=SYS_PTRACE',
      '--device=/dev/fuse',
      '--security-opt=apparmor:unconfined',
      '--security-opt=seccomp=unconfined',
      '--cgroupns=private',
    ]) {
      expect(argv).toContain(flag);
    }
    expect(argv).not.toContain('--privileged');
    expect(argv.indexOf('--cap-add=SYS_PTRACE')).toBeLessThan(argv.indexOf('agentbox/box:dev'));
  });
});
