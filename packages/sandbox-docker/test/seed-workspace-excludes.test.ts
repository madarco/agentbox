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

  it('drops untracked generated dirs at any depth, and keeps them under box.carryAll', async () => {
    // A project with no `.venv` gitignore entry (one that relied on a global
    // ignore the box never sees) would otherwise ship a Mac venv into the box.
    execaMock.mockImplementation((bin: string, argv: string[]) => {
      if (bin === 'git' && argv.includes('ls-files')) {
        return Promise.resolve({
          exitCode: 0,
          stdout:
            '.venv/bin/python\0services/api/.venv/pyvenv.cfg\0src/__pycache__/a.pyc\0' +
            'node_modules/x/i.js\0pkg/dist/b.js\0scripts/build\0src/a.py\0',
          stderr: '',
        });
      }
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
    });
    const repo = { kind: 'root', hostMainRepo: '/proj', containerPath: '/workspace' } as never;
    const wt = '/home/vscode/.agentbox-worktrees/x';

    const dropped = await collectRepoCarryOver(repo, 'agentbox/x', '/workspace', wt);
    expect(dropped.untrackedNul).toBe('scripts/build\0src/a.py\0');

    const kept = await collectRepoCarryOver(repo, 'agentbox/x', '/workspace', wt, {
      all: true,
    });
    expect(kept.untrackedNul.split('\0').filter(Boolean)).toHaveLength(7);
  });
});

describe('seedWorkspaceFromDir and the generated dirs', () => {
  const tarArgv = (): string[] =>
    execaMock.mock.calls.find((c) => c[0] === 'tar' && (c[1] as string[]).includes('-cf'))![1];

  it('excludes the shared list by default', async () => {
    await seedWorkspaceFromDir({ container: 'agentbox-x', hostSource: '/proj' });
    for (const d of ['node_modules', 'dist', '.venv', 'venv', '__pycache__']) {
      expect(tarArgv()).toContain(`--exclude=${d}`);
    }
  });

  it('keeps them under box.carryAll, and still drops .agentbox', async () => {
    await seedWorkspaceFromDir({ container: 'agentbox-x', hostSource: '/proj', carryAll: true });
    expect(tarArgv().filter((a) => a.startsWith('--exclude='))).toEqual(['--exclude=.agentbox']);
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
