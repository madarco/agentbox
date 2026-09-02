import { describe, expect, it } from 'vitest';
import {
  agentStateExcludePaths,
  buildWorkspaceListScript,
  isExcludedPath,
  parseItemizedChanges,
  parseWorkspaceList,
  workspaceExcludes,
} from '../src/sync/concerns/workspace-files.js';

describe('workspaceExcludes', () => {
  it('carries the dir names, the live-database globs and the agent state paths', () => {
    const ex = workspaceExcludes();
    expect(ex).toContain('.git');
    expect(ex).toContain('node_modules');
    expect(ex).toContain('media');
    expect(ex).toContain('*.sqlite*');
    // Derived from the registry, not listed — the reason a new agent needs no
    // edit here.
    expect(ex).toEqual(expect.arrayContaining(agentStateExcludePaths()));
    expect(agentStateExcludePaths()).toContain('.claude');
  });

  it('keeps node_modules when asked', () => {
    expect(workspaceExcludes({ includeNodeModules: true })).not.toContain('node_modules');
  });
});

describe('isExcludedPath', () => {
  const ex = workspaceExcludes();

  it('matches a bare name at any depth', () => {
    expect(isExcludedPath('node_modules/x/index.js', ex)).toBe(true);
    expect(isExcludedPath('src/node_modules/a', ex)).toBe(true);
    expect(isExcludedPath('src/app.js', ex)).toBe(false);
  });

  it('matches a slashed pattern as a subtree, not as a name', () => {
    expect(isExcludedPath('.config/opencode/auth.json', ['.config/opencode'])).toBe(true);
    // The parent dir must NOT be swept along with it.
    expect(isExcludedPath('.config/other/x', ['.config/opencode'])).toBe(false);
  });

  it('matches a glob against the basename only', () => {
    expect(isExcludedPath('state/live.sqlite', ex)).toBe(true);
    expect(isExcludedPath('state/live.sqlite-wal', ex)).toBe(true);
    expect(isExcludedPath('docs/notes.dbg', ex)).toBe(false);
  });
});

describe('buildWorkspaceListScript', () => {
  it('probes git first and falls through to find', () => {
    const script = buildWorkspaceListScript({ excludes: ['node_modules'] });
    expect(script).toContain('git rev-parse --is-inside-work-tree');
    expect(script).toContain('git ls-files -z --cached --others --exclude-standard');
    expect(script).toContain('MODE=git');
    expect(script).toContain('MODE=exclude');
    expect(script).toContain("-name 'node_modules'");
  });

  it('skips the git probe entirely when gitignore is off', () => {
    const script = buildWorkspaceListScript({ respectGitignore: false, excludes: [] });
    expect(script).not.toContain('git rev-parse');
    expect(script).toContain('if false');
  });

  it('uses -print0, which BSD find on macOS also has', () => {
    expect(buildWorkspaceListScript({ excludes: [] })).toContain('-print0');
  });

  it('excludes a FILE named like an excluded dir — a worktree .git is a file', () => {
    // Regression: pruning only `-type d -name .git` let a linked worktree's
    // `.git` FILE into the list, and rsync then aborted with "could not make way
    // for new regular file: .git" against the host checkout's `.git` directory.
    const script = buildWorkspaceListScript({
      respectGitignore: false,
      excludes: ['.git', '.config/opencode', '*.sqlite*'],
    });
    const findLine = script.split('\n').find((l) => l.includes('find .')) ?? '';
    expect(findLine).toContain(`! -name '.git'`);
    expect(findLine).toContain(`! -path './.config/opencode'`);
    expect(findLine).toContain(`! -path './.config/opencode/*'`);
    expect(findLine).toContain(`! -name '*.sqlite*'`);
  });
});

describe('parseWorkspaceList', () => {
  it('reads the mode marker and NUL-splits the rest', () => {
    const parsed = parseWorkspaceList('MODE=git\na\0b/c\0');
    expect(parsed.mode).toBe('git');
    expect(parsed.paths).toEqual(['a', 'b/c']);
    expect(parsed.fileList).toBe('a\0b/c');
  });

  it("strips find's leading ./ so both modes feed rsync identically", () => {
    expect(parseWorkspaceList('MODE=exclude\n./a\0./b/c\0').paths).toEqual(['a', 'b/c']);
  });

  it('tolerates an empty listing', () => {
    expect(parseWorkspaceList('MODE=exclude\n').paths).toEqual([]);
  });

  it('throws rather than guessing when the marker is missing', () => {
    expect(() => parseWorkspaceList('a\0b\0')).toThrow(/mode marker/);
  });
});

describe('parseItemizedChanges', () => {
  it('keeps file transfers, drops attr-only and directory lines', () => {
    const out = [
      '>f+++++++++ new.txt',
      '>fcst...... changed.txt',
      '.f........./ untouched.txt',
      'cd+++++++++ some/dir/',
    ].join('\n');
    expect(parseItemizedChanges(out)).toEqual(['>f+++++++++ new.txt', '>fcst...... changed.txt']);
  });

  it('counts no directory line, however it was produced', () => {
    // Directories are created as a side effect of transferring files; counting
    // them would overstate "files changed". `*deleting <dir>` reads as a `d`
    // entry too — and the pull never passes `--delete` anyway.
    expect(parseItemizedChanges('cd+++++++++ a/\n*deleting   b/')).toEqual([]);
  });
});
