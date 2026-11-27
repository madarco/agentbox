import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The resync's config read, stubbed: a unit test must not read the real
// ~/.agentbox/config.yaml (apps tests have no HOME isolation, and neither does this).
const { carryAll } = vi.hoisted(() => ({ carryAll: { value: false } }));
vi.mock('../src/sync/concerns/carry-all.js', () => ({
  resolveCarryAll: () => Promise.resolve(carryAll.value),
}));

const {
  GENERATED_DIR_NAMES,
  buildWorkspaceListScript,
  dropHostOnlyPaths,
  isExcludedPath,
  parseWorkspaceList,
  seedExcludeTarArgs,
  untrackedExcludePathspecs,
  workspaceExcludes,
} = await import('../src/sync/concerns/workspace-files.js');
const { makeHostGitPorts } = await import('../src/sync/concerns/git.js');

/**
 * The generated dirs (`node_modules`, `dist`, `.venv`, `__pycache__`, ...) do not
 * cross the box boundary by default, in either direction, whatever the
 * gitignore says — for UNTRACKED files. The reported failure: a box's `uv sync`
 * built a Linux `/workspace/.venv`, the project relied on the Mac's GLOBAL
 * gitignore for `.venv` (which git in the box never sees), and `download`
 * copied it over the Mac's own venv.
 *
 * Every tree here has NO .gitignore, so git lists them as untracked and only
 * the shared list keeps them out.
 */
const GENERATED_FILES = [
  'node_modules/x/index.js',
  'packages/web/node_modules/y/index.js',
  'dist/bundle.js',
  'packages/web/dist/app.js',
  'build/out.o',
  '.venv/bin/python',
  'venv/lib/site.py',
  'services/api/.venv/pyvenv.cfg',
  '__pycache__/mod.cpython-312.pyc',
  'services/api/app/__pycache__/main.cpython-312.pyc',
  '.next/cache/a',
  'target/debug/app',
];
// Look-alikes that are the user's own content and must survive.
const KEPT_FILES = [
  'src/app.py',
  'distribution/notes.md',
  'my_build.py',
  'scripts/build',
  'src/dist',
  'myvenv/x.txt',
  'src/venv_tools.py',
  'docs/.venvrc',
];
// Never the user's content, `--all` or not.
const OURS = ['.agentbox/box.md'];
// A COMMITTED file under a generated dir: tracked, so it is the user's.
const TRACKED_GENERATED = 'dist/committed.js';

function makeTree(withGit: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), 'agentbox-generated-'));
  const write = (rel: string): void => {
    mkdirSync(join(dir, dirname(rel)), { recursive: true });
    writeFileSync(join(dir, rel), rel);
  };
  if (withGit) {
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
    git('init', '-q');
    // Keep the developer's own global excludes out of the test, which is the
    // exact blind spot the box has.
    git('config', 'core.excludesFile', '/dev/null');
    write(TRACKED_GENERATED);
    git('add', TRACKED_GENERATED);
    git(
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@example.com',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-qm',
      'init',
    );
  }
  for (const rel of [...GENERATED_FILES, ...KEPT_FILES, ...OURS]) write(rel);
  return dir;
}

function listIn(
  dir: string,
  opts: { all?: boolean; respectGitignore?: boolean } = {},
): { mode: string; paths: string[] } {
  const script = buildWorkspaceListScript({
    workspaceDir: dir,
    excludes: workspaceExcludes({ all: opts.all }),
    all: opts.all,
    respectGitignore: opts.respectGitignore,
  });
  const parsed = parseWorkspaceList(
    execFileSync('bash', ['-c', script], { encoding: 'utf8', maxBuffer: 1e8 }),
  );
  return { mode: parsed.mode, paths: parsed.paths.sort() };
}

describe('the shared list', () => {
  it('holds the usual generated dirs, venv included, and none of ours', () => {
    for (const d of ['node_modules', 'dist', 'build', '.venv', 'venv', '__pycache__']) {
      expect(GENERATED_DIR_NAMES).toContain(d);
    }
    expect(GENERATED_DIR_NAMES).not.toContain('.git');
    expect(GENERATED_DIR_NAMES).not.toContain('.agentbox');
  });

  it('matches a generated name as a directory only', () => {
    const pats = GENERATED_DIR_NAMES.map((d) => `${d}/`);
    expect(isExcludedPath('dist/a.js', pats)).toBe(true);
    expect(isExcludedPath('a/b/dist/a.js', pats)).toBe(true);
    expect(isExcludedPath('src/dist', pats)).toBe(false);
    expect(isExcludedPath('scripts/build', pats)).toBe(false);
    expect(isExcludedPath('distribution/x', pats)).toBe(false);
  });

  it('builds untracked pathspecs only, and none under --all but .agentbox', () => {
    expect(untrackedExcludePathspecs({ all: true })).toEqual([':(exclude).agentbox']);
    const specs = untrackedExcludePathspecs();
    for (const d of GENERATED_DIR_NAMES) {
      expect(specs).toContain(`:(exclude)${d}/*`);
      expect(specs).toContain(`:(exclude)*/${d}/*`);
    }
  });
});

describe('the pull selection (download / clone)', { timeout: 30_000 }, () => {
  let repo: string;
  let plain: string;
  beforeAll(() => {
    repo = makeTree(true);
    plain = makeTree(false);
  });

  it('git mode drops untracked generated dirs at any depth, keeps a tracked dist/ file', () => {
    const { mode, paths } = listIn(repo);
    expect(mode).toBe('git');
    expect(paths).toEqual([...KEPT_FILES, TRACKED_GENERATED].sort());
  });

  it('git mode --all keeps everything git does not ignore, except .agentbox', () => {
    const { paths } = listIn(repo, { all: true });
    expect(paths).toEqual([...GENERATED_FILES, ...KEPT_FILES, TRACKED_GENERATED].sort());
  });

  it('exclude-list mode drops them too, and --all keeps all but .git/.agentbox', () => {
    const dropped = listIn(plain);
    expect(dropped.mode).toBe('exclude');
    expect(dropped.paths).toEqual([...KEPT_FILES].sort());

    const kept = listIn(plain, { all: true });
    expect(kept.paths).toEqual([...GENERATED_FILES, ...KEPT_FILES].sort());
  });

  it('--no-respect-gitignore on a repo is exclude-list mode with the same rule', () => {
    const { mode, paths } = listIn(repo, { respectGitignore: false });
    expect(mode).toBe('exclude');
    for (const p of GENERATED_FILES) expect(paths).not.toContain(p);
    for (const p of KEPT_FILES) expect(paths).toContain(p);
    expect(paths.some((p) => p.startsWith('.git/') || p === '.git')).toBe(false);
  });
});

describe('the create-time seed', () => {
  const nul = (paths: string[]): string => `${paths.join('\0')}\0`;

  it('drops them from the untracked carry-over list at any depth', () => {
    expect(dropHostOnlyPaths(nul([...GENERATED_FILES, ...KEPT_FILES, ...OURS]))).toBe(
      nul(KEPT_FILES),
    );
  });

  it('keeps them under box.carryAll, and still drops .agentbox', () => {
    const input = nul([...OURS, ...GENERATED_FILES]);
    expect(dropHostOnlyPaths(input, { all: true })).toBe(nul(GENERATED_FILES));
  });

  it('the no-git tar seed drops them at any depth, and keeps them under box.carryAll', () => {
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
    for (const p of [...GENERATED_FILES, ...OURS]) expect(dropped).not.toContain(p);
    // A FILE called `build` or `dist` goes too: no tar can exclude a dir only.
    for (const p of KEPT_FILES.filter((k) => k !== 'scripts/build' && k !== 'src/dist')) {
      expect(dropped).toContain(p);
    }

    const kept = tarList(seedExcludeTarArgs({ all: true }));
    for (const p of [...GENERATED_FILES, ...KEPT_FILES]) expect(kept).toContain(p);
    for (const p of OURS) expect(kept).not.toContain(p);
  });
});

describe('the resync / upload untracked overlay', { timeout: 30_000 }, () => {
  let repo: string;
  beforeAll(() => {
    repo = makeTree(true);
  });
  beforeEach(() => {
    carryAll.value = false;
  });

  it('lists the host untracked files without the generated dirs', async () => {
    const listed = (await makeHostGitPorts().listHostUntracked(repo)).sort();
    expect(listed).toEqual([...KEPT_FILES].sort());
  });

  it('keeps them when box.carryAll is set, never .agentbox', async () => {
    carryAll.value = true;
    const listed = (await makeHostGitPorts().listHostUntracked(repo)).sort();
    expect(listed).toEqual([...GENERATED_FILES, ...KEPT_FILES].sort());
  });
});
