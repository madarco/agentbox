// Pure: everything happens under a mkdtemp dir; nothing is registered (the module
// never touches ~/.agentbox — that is the backend's half), so no $HOME relocation
// is needed here.
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  NEW_PROJECT_GITIGNORE,
  createProjectDir,
  validateProjectName,
  type ExecGit,
} from '../lib/boxes/create-project';

const execFileAsync = promisify(execFile);

let tmp: string;
beforeEach(async () => {
  tmp = await realpath(await mkdtemp(path.join(tmpdir(), 'agentbox-hub-cp-')));
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const git = async (cwd: string, ...args: string[]) =>
  (await execFileAsync('git', args, { cwd })).stdout.trim();

describe('validateProjectName', () => {
  it('accepts a plain folder name and refuses anything path-like', () => {
    expect(validateProjectName('my-bot')).toBeNull();
    expect(validateProjectName('.hidden')).not.toBeNull();
    expect(validateProjectName('a/b')).not.toBeNull();
    expect(validateProjectName('..')).not.toBeNull();
  });
});

describe('createProjectDir', () => {
  it('creates an empty folder and returns its canonical root', async () => {
    const r = await createProjectDir({ parent: tmp, name: 'demo', git: false });
    expect(r).toEqual({ ok: true, root: path.join(tmp, 'demo') });
    expect(await readdir(path.join(tmp, 'demo'))).toEqual([]);
  });

  it('realpaths the root (a symlinked parent resolves to the real dir)', async () => {
    const real = path.join(tmp, 'real');
    await mkdir(real);
    const link = path.join(tmp, 'link');
    await import('node:fs/promises').then((fs) => fs.symlink(real, link));
    const r = await createProjectDir({ parent: link, name: 'demo', git: false });
    expect(r).toEqual({ ok: true, root: path.join(real, 'demo') });
  });

  it('refuses an existing target', async () => {
    await mkdir(path.join(tmp, 'demo'));
    const r = await createProjectDir({ parent: tmp, name: 'demo', git: false });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('already exists');
  });

  it('refuses a relative or missing parent', async () => {
    expect((await createProjectDir({ parent: 'rel/dir', name: 'x', git: false })).ok).toBe(false);
    const r = await createProjectDir({ parent: path.join(tmp, 'nope'), name: 'x', git: false });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('not a directory');
  });

  it('refuses a bad name before touching the filesystem', async () => {
    const r = await createProjectDir({ parent: tmp, name: '../escape', git: false });
    expect(r.ok).toBe(false);
    expect(await readdir(tmp)).toEqual([]);
  });

  it('refuses a parent inside another project and names that project', async () => {
    const proj = path.join(tmp, 'proj');
    await mkdir(path.join(proj, 'sub'), { recursive: true });
    await writeFile(path.join(proj, 'agentbox.yaml'), 'services: {}\n');
    const r = await createProjectDir({ parent: path.join(proj, 'sub'), name: 'bot', git: false });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain(`inside the project at ${proj}`);
    expect(await stat(path.join(proj, 'sub', 'bot')).catch(() => null)).toBeNull();
  });

  it('git: true makes a repo on main with a .gitignore and one commit', async () => {
    // Prove the identity fallback: with no global/system config the first commit
    // fails on a machine without user.name, and the -c retry must cover it.
    const isolated: ExecGit = (args, { cwd }) =>
      execFileAsync('git', args, {
        cwd,
        env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
      });
    const r = await createProjectDir(
      { parent: tmp, name: 'repo', git: true },
      { execGit: isolated },
    );
    expect(r.ok).toBe(true);
    const root = path.join(tmp, 'repo');
    expect((await stat(path.join(root, '.git'))).isDirectory()).toBe(true);
    expect(await readFile(path.join(root, '.gitignore'), 'utf8')).toBe(NEW_PROJECT_GITIGNORE);
    expect(await git(root, 'symbolic-ref', '--short', 'HEAD')).toBe('main');
    expect(await git(root, 'rev-list', '--count', 'HEAD')).toBe('1');
    expect(await git(root, 'status', '--porcelain')).toBe('');
  });

  it('rolls the folder back when git fails', async () => {
    const failing: ExecGit = async (args) => {
      if (args[0] === 'init') throw Object.assign(new Error('boom'), { stderr: 'fatal: no git' });
    };
    const r = await createProjectDir(
      { parent: tmp, name: 'broken', git: true },
      { execGit: failing },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('fatal: no git');
    expect(await stat(path.join(tmp, 'broken')).catch(() => null)).toBeNull();
  });
});
