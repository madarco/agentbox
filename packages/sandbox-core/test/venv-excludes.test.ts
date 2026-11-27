import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The resync's config read, stubbed: a unit test must not read the real
// ~/.agentbox/config.yaml (apps tests have no HOME isolation, and neither does this).
const { carryVenv } = vi.hoisted(() => ({ carryVenv: { value: false } }));
vi.mock('../src/sync/concerns/carry-venv.js', () => ({
  resolveCarryVenv: () => Promise.resolve(carryVenv.value),
}));

const {
  buildWorkspaceListScript,
  dropHostOnlyPaths,
  parseWorkspaceList,
  seedExcludeTarArgs,
  workspaceExcludes,
} = await import('../src/sync/concerns/workspace-files.js');
const { makeHostGitPorts } = await import('../src/sync/concerns/git.js');

/**
 * Python env dirs never cross the box boundary by default, whatever the
 * gitignore says. The reported failure: a box's `uv sync` built a Linux
 * `/workspace/.venv`, the project relied on the Mac's GLOBAL gitignore for
 * `.venv` (which git in the box never sees), and `download` copied it over the
 * Mac's own venv.
 *
 * Every tree here has NO .gitignore, so git lists the venvs as untracked and
 * only the new rule keeps them out.
 */
const VENV_FILES = [
  '.venv/bin/python',
  'venv/lib/site.py',
  '__pycache__/mod.cpython-312.pyc',
  'services/api/.venv/pyvenv.cfg',
  'services/api/app/__pycache__/main.cpython-312.pyc',
];
// Look-alikes that are the user's own content and must survive.
const KEPT_FILES = ['src/app.py', 'myvenv/x.txt', 'src/venv_tools.py', 'docs/.venvrc'];

function makeTree(withGit: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), 'agentbox-venv-'));
  for (const rel of [...VENV_FILES, ...KEPT_FILES]) {
    mkdirSync(join(dir, dirname(rel)), { recursive: true });
    writeFileSync(join(dir, rel), rel);
  }
  if (withGit) {
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
    git('init', '-q');
    // Keep the developer's own global excludes out of the test, which is the
    // exact blind spot the box has.
    git('config', 'core.excludesFile', '/dev/null');
  }
  return dir;
}

function listIn(
  dir: string,
  opts: { includeVenv?: boolean; respectGitignore?: boolean } = {},
): { mode: string; paths: string[] } {
  const script = buildWorkspaceListScript({
    workspaceDir: dir,
    excludes: workspaceExcludes({ includeVenv: opts.includeVenv }),
    includeVenv: opts.includeVenv,
    respectGitignore: opts.respectGitignore,
  });
  const parsed = parseWorkspaceList(
    execFileSync('bash', ['-c', script], { encoding: 'utf8', maxBuffer: 1e8 }),
  );
  return { mode: parsed.mode, paths: parsed.paths.sort() };
}

describe('the pull selection (download / clone)', { timeout: 30_000 }, () => {
  let repo: string;
  let plain: string;
  beforeAll(() => {
    repo = makeTree(true);
    plain = makeTree(false);
  });

  it('git mode drops .venv, venv and __pycache__ at any depth', () => {
    const { mode, paths } = listIn(repo);
    expect(mode).toBe('git');
    for (const p of VENV_FILES) expect(paths).not.toContain(p);
    expect(paths).toEqual([...KEPT_FILES].sort());
  });

  it('git mode keeps them with includeVenv (download --include-venv)', () => {
    const { paths } = listIn(repo, { includeVenv: true });
    for (const p of [...VENV_FILES, ...KEPT_FILES]) expect(paths).toContain(p);
  });

  it('exclude-list mode drops them too, and keeps them with includeVenv', () => {
    const dropped = listIn(plain);
    expect(dropped.mode).toBe('exclude');
    for (const p of VENV_FILES) expect(dropped.paths).not.toContain(p);
    for (const p of KEPT_FILES) expect(dropped.paths).toContain(p);

    const kept = listIn(plain, { includeVenv: true });
    for (const p of VENV_FILES) expect(kept.paths).toContain(p);
  });

  it('--no-respect-gitignore on a repo is exclude-list mode with the same rule', () => {
    const { mode, paths } = listIn(repo, { respectGitignore: false });
    expect(mode).toBe('exclude');
    for (const p of VENV_FILES) expect(paths).not.toContain(p);
  });
});

describe('the create-time seed', () => {
  const nul = (paths: string[]): string => `${paths.join('\0')}\0`;

  it('drops them from the untracked carry-over list at any depth', () => {
    expect(dropHostOnlyPaths(nul([...VENV_FILES, ...KEPT_FILES]))).toBe(nul(KEPT_FILES));
  });

  it('keeps them under box.carryVenv, and still drops .agentbox', () => {
    const input = nul(['.agentbox/x', ...VENV_FILES]);
    expect(dropHostOnlyPaths(input, { includeVenv: true })).toBe(nul(VENV_FILES));
  });

  it('the no-git tar seed drops them at any depth, and keeps them under box.carryVenv', () => {
    const src = makeTree(false);
    const tarList = (args: string[]): string[] => {
      const members = execFileSync('tar', [...args, '-cf', '-', '.'], {
        cwd: src,
        encoding: 'buffer',
        maxBuffer: 1e8,
      });
      return execFileSync('tar', ['-tf', '-'], { input: members, encoding: 'utf8' })
        .split('\n')
        .map((l) => l.replace(/^\.\//, ''))
        .filter((l) => l.length > 0 && !l.endsWith('/'));
    };
    const dropped = tarList(seedExcludeTarArgs());
    for (const p of VENV_FILES) expect(dropped).not.toContain(p);
    for (const p of KEPT_FILES) expect(dropped).toContain(p);

    const kept = tarList(seedExcludeTarArgs({ includeVenv: true }));
    for (const p of VENV_FILES) expect(kept).toContain(p);
  });
});

describe('the resync / upload untracked overlay', { timeout: 30_000 }, () => {
  let repo: string;
  beforeAll(() => {
    repo = makeTree(true);
  });
  beforeEach(() => {
    carryVenv.value = false;
  });

  it('lists the host untracked files without the venvs', async () => {
    const listed = (await makeHostGitPorts().listHostUntracked(repo)).sort();
    expect(listed).toEqual([...KEPT_FILES].sort());
  });

  it('keeps them when box.carryVenv is set', async () => {
    carryVenv.value = true;
    const listed = await makeHostGitPorts().listHostUntracked(repo);
    for (const p of VENV_FILES) expect(listed).toContain(p);
  });
});
