import { beforeEach, describe, expect, it, vi } from 'vitest';

const { execaMock } = vi.hoisted(() => ({ execaMock: vi.fn() }));
vi.mock('execa', () => ({ execa: execaMock }));

import { runBox } from '../src/docker.js';
import { unwritableGitBind } from '../src/sync/in-box-git.js';

describe('runBox', () => {
  it('passes the host-gateway add-host by default (Linux native docker needs it)', async () => {
    execaMock.mockResolvedValue({ stdout: 'agentbox-test-1', stderr: '', exitCode: 0 });
    await runBox({ name: 'agentbox-test-1', image: 'agentbox/box:dev' });
    const [cmd, args] = execaMock.mock.calls[0] as [string, string[]];
    expect(cmd).toBe('docker');
    expect(args).toContain('--add-host=host.docker.internal:host-gateway');
  });

  it('omits the host-gateway add-host when addHostGateway is false (colima)', async () => {
    execaMock.mockReset().mockResolvedValue({ stdout: 'agentbox-test-2', stderr: '', exitCode: 0 });
    await runBox({ name: 'agentbox-test-2', image: 'agentbox/box:dev', addHostGateway: false });
    const [, args] = execaMock.mock.calls[0] as [string, string[]];
    expect(args).not.toContain('--add-host=host.docker.internal:host-gateway');
  });
});

describe('unwritableGitBind', () => {
  beforeEach(() => {
    execaMock.mockReset();
  });

  it('returns the first repo whose bind-mounted .git the box user cannot write', async () => {
    // vscode can write repo A's .git (exit 0), not repo B's (exit 1).
    execaMock
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 1 });
    const bad = await unwritableGitBind('agentbox-test', [
      { repo: { hostMainRepo: '/Users/me/ok' } },
      { repo: { hostMainRepo: '/Users/me/bad' } },
    ]);
    expect(bad).toBe('/Users/me/bad/.git');
    // The probe runs as the box user against the exact bind path.
    const [, args] = execaMock.mock.calls[1] as [string, string[]];
    expect(args[1]).toBe('--user');
    expect(args[2]).toBe('vscode');
    expect(args[6]).toContain("test -w '/Users/me/bad/.git'");
  });

  it('returns null when every bind is writable', async () => {
    execaMock.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
    expect(
      await unwritableGitBind('agentbox-test', [{ repo: { hostMainRepo: '/Users/me/ok' } }]),
    ).toBeNull();
  });
});
