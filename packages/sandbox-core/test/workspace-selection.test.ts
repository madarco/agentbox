import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  buildWorkspaceListScript,
  parseWorkspaceList,
} from '../src/sync/concerns/workspace-files.js';

/**
 * The selection, run for real against a real git repo.
 *
 * Every other test here asserts on the script's TEXT, which is how the bug this
 * file exists for survived: the script looked right and the repo it ran against
 * disagreed. This one builds a worktree with each hazard in it and executes the
 * generated script, so the assertions are about what a box would actually list.
 */
const EXCLUDES = ['.git', 'node_modules', 'media'];
let repo: string;

function list(opts: { includeNodeModules?: boolean } = {}): string[] {
  const script = buildWorkspaceListScript({ workspaceDir: repo, excludes: EXCLUDES, ...opts });
  const out = execFileSync('bash', ['-c', script], { encoding: 'utf8', maxBuffer: 1e8 });
  return parseWorkspaceList(out).paths.sort();
}

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'agentbox-selection-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  writeFileSync(join(repo, 'a.txt'), 'a');
  mkdirSync(join(repo, 'sub'));
  writeFileSync(join(repo, 'sub/b.txt'), 'b');
  git('add', '-A');
  git('-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init');
  // Tracked, then deleted from the worktree: still an index entry.
  rmSync(join(repo, 'a.txt'));
  // Untracked and NOT gitignored (this repo has no .gitignore), at two depths.
  mkdirSync(join(repo, 'node_modules'));
  writeFileSync(join(repo, 'node_modules/x'), 'x');
  mkdirSync(join(repo, 'pkg/node_modules'), { recursive: true });
  writeFileSync(join(repo, 'pkg/node_modules/y'), 'y');
  writeFileSync(join(repo, 'has space.txt'), 's');
  symlinkSync('sub/b.txt', join(repo, 'link.txt'));
  symlinkSync('nowhere', join(repo, 'dangling.txt'));
});

// Same reasoning as `rsync-pull.test.ts`: real git, bash and xargs per case.
describe('the git-mode selection, executed', { timeout: 30_000 }, () => {
  it('never names a path that is not there', () => {
    // `git ls-files --cached` prints an index entry whose worktree file was
    // DELETED. That path is fatal on both transports: rsync exits 23 and the
    // shared pull throws on its dry run, while the cloud tar dies on `Cannot
    // stat` under `set -e`. Reported as "download transferred nothing".
    expect(list()).not.toContain('a.txt');
    expect(list()).toContain('sub/b.txt');
  });

  it('drops node_modules at EVERY depth, not just the root', () => {
    // The reported bug. A root-anchored `:(exclude)node_modules` alone still
    // lists a monorepo's nested copies (measured: 3310 of them in this repo),
    // which the docker mirror's `--exclude=node_modules` had already removed —
    // so the selection asked for files the staging never wrote.
    expect(list()).not.toContain('node_modules/x');
    expect(list()).not.toContain('pkg/node_modules/y');
  });

  it('returns both when the user asks for node_modules', () => {
    const paths = list({ includeNodeModules: true });
    expect(paths).toContain('node_modules/x');
    expect(paths).toContain('pkg/node_modules/y');
  });

  it('keeps names with spaces and both kinds of symlink', () => {
    // The whole pipeline is NUL-delimited (`ls-files -z` | `xargs -0` | argv |
    // `printf %s\0`); a space in a name is where a sloppier filter breaks.
    const paths = list();
    expect(paths).toContain('has space.txt');
    expect(paths).toContain('link.txt');
    // `[ -L ]` keeps a dangling symlink: rsync -a and tar both copy the link
    // itself and never stat the target.
    expect(paths).toContain('dangling.txt');
  });

  it('lists exactly the surviving set', () => {
    expect(list()).toEqual(['dangling.txt', 'has space.txt', 'link.txt', 'sub/b.txt']);
  });

  it('fails loudly when git fails, instead of reporting an empty workspace', () => {
    // Without `set -o pipefail` the pipeline exits 0 and the short list reads
    // as "this workspace has fewer files" — a silent, wrong download.
    const script = buildWorkspaceListScript({ workspaceDir: repo, excludes: EXCLUDES }).replace(
      'git ls-files',
      'git ls-files --definitely-not-a-flag',
    );
    expect(() => execFileSync('bash', ['-c', script], { encoding: 'utf8' })).toThrow();
  });
});
