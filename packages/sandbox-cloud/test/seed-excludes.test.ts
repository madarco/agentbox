import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CloudBackend, CloudHandle } from '@agentbox/core';

// execa is mocked so no tar or git actually runs; we assert on the argv the
// seed builds. `detectGitRepos` is real and reads the temp dir.
const { execaMock } = vi.hoisted(() => ({ execaMock: vi.fn() }));
vi.mock('execa', () => ({ execa: execaMock }));

const { seedCloudWorkspace } = await import('../src/sync/workspace-seed.js');

let hostDir: string;

beforeEach(async () => {
  hostDir = await mkdtemp(join(tmpdir(), 'agentbox-cloud-seed-'));
  execaMock.mockReset();
  execaMock.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
});

afterEach(async () => {
  await rm(hostDir, { recursive: true, force: true });
});

function fakeBackend(): { backend: CloudBackend; handle: CloudHandle } {
  return {
    backend: {
      uploadFile: vi.fn().mockResolvedValue(undefined),
      exec: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }),
    } as unknown as CloudBackend,
    handle: {} as CloudHandle,
  };
}

/**
 * The cloud half of "`.agentbox/` never crosses the box boundary".
 *
 * `remote-docker` runs through `createCloudProvider`, so this covers it too —
 * it is the main consumer of the non-git seed leg, because a bind mount cannot
 * cross a network.
 */
describe('the non-git cloud seed', () => {
  it('excludes the host-only dirs from the workspace tarball', async () => {
    await writeFile(join(hostDir, 'app.ts'), 'export {};');
    await mkdir(join(hostDir, '.agentbox', 'bots'), { recursive: true });

    const { backend, handle } = fakeBackend();
    await seedCloudWorkspace({ backend, handle, workspacePath: hostDir, branch: 'agentbox/x' });

    const tarCall = execaMock.mock.calls.find(
      (c) => c[0] === 'tar' && (c[1] as string[]).includes('-czf'),
    );
    expect(tarCall, 'no host-side tar was run').toBeDefined();
    expect(tarCall![1] as string[]).toContain('--exclude=.agentbox');
  });

  it('suppresses AppleDouble sidecars, like every other tar in this file', async () => {
    // This tar was the last one in the file WITHOUT COPYFILE_DISABLE, so a
    // macOS host seeded a cloud box with `._*` stubs that extract on Linux as
    // literal junk in /workspace.
    await writeFile(join(hostDir, 'app.ts'), 'export {};');

    const { backend, handle } = fakeBackend();
    await seedCloudWorkspace({ backend, handle, workspacePath: hostDir, branch: 'agentbox/x' });

    const tarCall = execaMock.mock.calls.find(
      (c) => c[0] === 'tar' && (c[1] as string[]).includes('-czf'),
    );
    expect((tarCall![2] as { env: Record<string, string> }).env.COPYFILE_DISABLE).toBe('1');
  });
});
