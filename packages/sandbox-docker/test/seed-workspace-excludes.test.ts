import { beforeEach, describe, expect, it, vi } from 'vitest';

// execa is mocked so the test never touches a real docker daemon or writes a tar.
const { execaMock } = vi.hoisted(() => ({ execaMock: vi.fn() }));
vi.mock('execa', () => ({ execa: execaMock }));

const { seedWorkspaceFromDir, collectRepoCarryOver } = await import('../src/sync/in-box-git.js');
const { EXCLUDE_DIRS } = await import('../src/snapshot.js');

beforeEach(() => {
  execaMock.mockReset();
  execaMock.mockResolvedValue({ exitCode: 0, stdout: '', stderr: Buffer.from('') });
});

/**
 * The seed half of "`.agentbox/` never crosses the box boundary".
 *
 * A host `<project>/.agentbox/bots/` holds a bot's workspace AND its gateway
 * identity (`download --backup`). Before this, the no-git seed tarred the whole
 * host dir with no exclude, so every new box from that project got a copy of
 * every backup — growing with each one.
 */
describe('seedWorkspaceFromDir', () => {
  it('excludes the host-only dirs from the tar it pipes into the box', async () => {
    await seedWorkspaceFromDir({ container: 'agentbox-x', hostSource: '/proj' });

    const tarCall = execaMock.mock.calls.find(
      (c) => c[0] === 'tar' && (c[1] as string[]).includes('-cf'),
    );
    expect(tarCall, 'no host-side tar was run').toBeDefined();
    expect(tarCall![1] as string[]).toContain('--exclude=.agentbox');
  });

  it('still suppresses AppleDouble sidecars', async () => {
    // COPYFILE_DISABLE and the new exclude live on the same argv; a careless
    // edit to one drops the other, and `._*` stubs extract as literal junk.
    await seedWorkspaceFromDir({ container: 'agentbox-x', hostSource: '/proj' });
    const tarCall = execaMock.mock.calls.find(
      (c) => c[0] === 'tar' && (c[1] as string[]).includes('-cf'),
    );
    expect((tarCall![2] as { env: Record<string, string> }).env.COPYFILE_DISABLE).toBe('1');
  });
});

describe('collectRepoCarryOver', () => {
  it('keeps the host-only dirs out of the untracked carry-over list', async () => {
    // The git leg does not tar a directory, it tars a vetted file list — so the
    // exclude has to be applied to the list. `--exclude-standard` already drops
    // a gitignored `.agentbox/`; this is what still holds when the user has
    // edited their .gitignore.
    execaMock.mockImplementation((bin: string, argv: string[]) => {
      if (bin === 'git' && argv.includes('ls-files')) {
        return Promise.resolve({
          exitCode: 0,
          stdout: '.agentbox/bots/ada/manifest.json\0src/app.ts\0',
          stderr: '',
        });
      }
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
    });

    const carry = await collectRepoCarryOver(
      { kind: 'root', hostMainRepo: '/proj', containerPath: '/workspace' } as never,
      'agentbox/x',
      '/workspace',
      '/home/vscode/.agentbox-worktrees/x',
    );
    expect(carry.untrackedNul).toBe('src/app.ts\0');
  });
});

describe('the APFS workspace snapshot', () => {
  it('prunes the host-only dirs from the clone', () => {
    // The clone is the SOURCE of the no-git seed. The tar exclude already makes
    // the box correct; pruning here stops the clone copying gigabytes of
    // backups only to drop them again.
    expect(EXCLUDE_DIRS.has('.agentbox')).toBe(true);
  });
});
