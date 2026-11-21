import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { execa } from 'execa';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { removeInBoxWorktree } from '../src/sync/in-box-git.js';

// #408: destroying one box must deregister exactly that box, never the repo's
// other worktrees. Local git on a temp dir only (no docker, no network).
async function git(cwd: string, ...args: string[]): Promise<string> {
  const r = await execa('git', ['-C', cwd, ...args], {
    env: { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  });
  return r.stdout;
}

let dir = '';
let main = '';
let ct = '';
let hostWt = '';

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'abx-408-'));
  main = join(dir, 'main');
  ct = join(dir, 'ct');
  hostWt = join(dir, 'usb', 'feature');
  await execa('git', ['init', '-q', '-b', 'main', main]);
  await git(
    main,
    '-c',
    'user.email=a@b',
    '-c',
    'user.name=a',
    'commit',
    '-q',
    '--allow-empty',
    '-m',
    'init',
  );
  for (const b of ['box1', 'box2']) {
    await git(main, 'worktree', 'add', '-q', '-b', `agentbox/${b}`, join(ct, b));
    // What guardWorktreeRegistrations does from inside each box.
    await git(main, 'worktree', 'lock', '--reason', `agentbox box ${b}`, join(ct, b));
  }
  await git(main, 'worktree', 'add', '-q', '-b', 'feature', hostWt);
  // Box paths are container-only and the host worktree sits on an unmounted
  // drive: all three look missing to host git.
  await rename(ct, join(dir, 'ct-gone'));
  await rename(join(dir, 'usb'), join(dir, 'usb-unmounted'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('removeInBoxWorktree', () => {
  it('drops only the destroyed (locked) box, keeping other boxes and host worktrees', async () => {
    await removeInBoxWorktree({ hostMainRepo: main, gitWorktreePath: join(ct, 'box1') });

    const list = await git(main, 'worktree', 'list', '--porcelain');
    expect(list).toContain(join(ct, 'box2'));
    expect(list).toContain(hostWt);
    expect(list).not.toContain(join(ct, 'box1'));
    // The branch survives destroy.
    expect(await git(main, 'branch', '--list', 'agentbox/box1')).toContain('agentbox/box1');
  });

  it('matches a gitdir written relative to the admin dir (worktree.useRelativePaths)', async () => {
    const admin = join(main, '.git', 'worktrees', 'box1');
    const abs = (await readFile(join(admin, 'gitdir'), 'utf8')).trim();
    await writeFile(join(admin, 'gitdir'), `${relative(admin, abs)}\n`);

    await removeInBoxWorktree({ hostMainRepo: main, gitWorktreePath: join(ct, 'box1') });

    const list = await git(main, 'worktree', 'list', '--porcelain');
    expect(list).not.toContain(join(ct, 'box1'));
    expect(list).toContain(join(ct, 'box2'));
  });

  it('locked box registrations survive a host-side `git worktree prune`', async () => {
    await git(main, 'worktree', 'prune');
    const list = await git(main, 'worktree', 'list', '--porcelain');
    expect(list).toContain(join(ct, 'box1'));
    expect(list).toContain(join(ct, 'box2'));
  });
});
