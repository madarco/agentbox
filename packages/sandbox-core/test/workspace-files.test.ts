import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  agentStateExcludePaths,
  GIT_MODE_EXCLUDE_DIRS,
  agentCloneDropPaths,
  agentWorkspaceArtifactPaths,
  buildWorkspaceListScript,
  gitModeExcludePathspecs,
  isAgentWorkspaceArtifact,
  parseItemizedEntries,
  isExcludedPath,
  overlayHostDirIntoBox,
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

  it('drops the box-local .agentbox dir from the GIT selection too', () => {
    // Git mode otherwise carries everything `ls-files --cached --others` reports
    // on purpose (a tracked `.claude/` there is the user's own content). The one
    // exception is the dir AgentBox itself generates in the box every boot:
    // pulling it back writes a file describing THIS box into the user's project.
    //
    // The pathspec is the only mechanism that works everywhere. `.git/info/exclude`
    // does not: in a docker box `/workspace/.git` is a linked-worktree FILE whose
    // per-worktree `info/exclude` git does not read (verified in a live box), and
    // the common dir it does read is the user's bind-mounted host repo.
    const script = buildWorkspaceListScript({ excludes: [] });
    for (const dir of GIT_MODE_EXCLUDE_DIRS) {
      expect(script).toContain(`':(exclude)${dir}'`);
    }
    expect(GIT_MODE_EXCLUDE_DIRS).toContain('.agentbox');
    // …and it is on the ls-files line, not merely somewhere in the script.
    const gitLine = script.split('\n').find((l) => l.includes('git ls-files'))!;
    expect(gitLine).toContain("':(exclude).agentbox'");
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

describe('overlayHostDirIntoBox', () => {
  it('propagates a probe failure and pushes NOTHING into the box', async () => {
    // The end of the fail-closed chain: if the probe cannot answer, the overlay
    // must abort rather than read the silence as "the box is empty" and copy the
    // whole host tree over the box's own work.
    const hostDir = await mkdtemp(join(tmpdir(), 'agentbox-overlay-test-'));
    try {
      await writeFile(join(hostDir, 'a.txt'), 'host');
      let pushed = 0;
      await expect(
        overlayHostDirIntoBox({
          hostDir,
          excludes: workspaceExcludes(),
          ports: {
            probeBoxTokens: () => Promise.reject(new Error('probe exploded')),
            applyTarToBox: () => {
              pushed += 1;
              return Promise.resolve();
            },
          },
        }),
      ).rejects.toThrow(/probe exploded/);
      expect(pushed).toBe(0);
    } finally {
      await rm(hostDir, { recursive: true, force: true });
    }
  });
});

describe('gitModeExcludePathspecs', () => {
  it('anchors .agentbox at the root but node_modules at every depth', () => {
    // Not a stylistic difference. `.agentbox` is one dir at the workspace root,
    // while `node_modules` has to mean what the docker mirror's
    // `--exclude=node_modules` means — a basename at ANY depth. Measured against
    // git 2.39: the root-anchored form alone still lists 3310 nested paths in
    // this repo, so a monorepo would select files the mirror never wrote.
    const specs = gitModeExcludePathspecs();
    expect(specs).toContain(':(exclude).agentbox');
    expect(specs).toContain(':(exclude)node_modules');
    expect(specs).toContain(':(exclude)*/node_modules');
    expect(specs).toContain(':(exclude)*/node_modules/*');
  });

  it('keeps node_modules when the user asked for it, and still drops .agentbox', () => {
    const specs = gitModeExcludePathspecs({ includeNodeModules: true });
    expect(specs).toEqual([':(exclude).agentbox']);
  });

  it('is what the script actually passes to git', () => {
    const script = buildWorkspaceListScript({ excludes: [] });
    const gitLine = script.split('\n').find((l) => l.includes('git ls-files'))!;
    for (const spec of gitModeExcludePathspecs()) expect(gitLine).toContain(`'${spec}'`);
    // The positive `.` must survive: on git 2.39 a DIRECTORY positive pathspec
    // plus any exclude returns nothing at all.
    expect(gitLine).toContain('-- . ');
  });
});

describe('parseItemizedEntries', () => {
  it('reads `created` from the attribute slots, not a fixed literal', () => {
    // rsync's flag word is 9 chars on the 2.6.9 macOS ships and 11 on rsync 3.x.
    // Matching `+++++++` literally would report "nothing is new" on one of them.
    expect(parseItemizedEntries('>f+++++++ new.txt')[0]?.created).toBe(true);
    expect(parseItemizedEntries('>f+++++++++ new.txt')[0]?.created).toBe(true);
    expect(parseItemizedEntries('>fcst...... changed.txt')[0]?.created).toBe(false);
  });

  it('strips the symlink target from the path', () => {
    // rsync prints `%i %n%L`, so a symlink line carries ` -> target`.
    expect(parseItemizedEntries('cL+++++++ link.txt -> sub/b.txt')[0]?.path).toBe('link.txt');
  });

  it('drops directory, attr-only AND *deleting lines, exactly as before', () => {
    // `*deleting` is dropped by the same `kind !== 'd'` rule that prunes
    // directories, because its second character is a `d`. That predates this
    // change and is harmless — a pull never passes `--delete`, so the line
    // cannot occur — but the refactor must not quietly alter it either.
    const entries = parseItemizedEntries(
      ['*deleting  old.txt', 'cd+++++++ somedir/', '.f....og.. attrs.txt', '>f+++++++ a.txt'].join(
        '\n',
      ),
    );
    expect(entries.map((e) => e.path)).toEqual(['a.txt']);
  });
});

describe('isAgentWorkspaceArtifact', () => {
  it('matches at the root only', () => {
    // Deliberately not `isExcludedPath`, whose bare-name rule matches any depth
    // and would sweep up a `docs/AGENTS.md` the user wrote.
    const artifacts = ['AGENTS.md', 'SOUL.md'];
    expect(isAgentWorkspaceArtifact('AGENTS.md', artifacts)).toBe(true);
    expect(isAgentWorkspaceArtifact('docs/AGENTS.md', artifacts)).toBe(false);
  });

  it('is derived from the registry, and openclaw declares its four', () => {
    expect(agentWorkspaceArtifactPaths()).toEqual([
      'AGENTS.md',
      'IDENTITY.md',
      'SOUL.md',
      'USER.md',
    ]);
  });
});

describe('agentCloneDropPaths', () => {
  it('drops only what the agent regenerates — NOT the files a clone rewrites', () => {
    // The distinction the whole spawn feature turns on: a clone must not carry
    // the source bot's `AGENTS.md`, but `SOUL.md` is the user's own writing and
    // is rendered for the new bot instead of thrown away.
    const drop = agentCloneDropPaths('openclaw');
    expect(drop).toEqual(['AGENTS.md', 'USER.md']);
    expect(drop).not.toContain('SOUL.md');
    expect(drop).not.toContain('IDENTITY.md');
  });

  it('is empty for an agent that declares no clone rules', () => {
    expect(agentCloneDropPaths('claude')).toEqual([]);
  });

  it('drops NOTHING when the caller cannot say which agent, rather than everything', () => {
    // The two mistakes are not symmetric: keeping a file the agent regenerates
    // costs nothing, while dropping one it does not is silent data loss — and
    // `AGENTS.md` / `USER.md` are exactly what a user writes for themselves.
    expect(agentCloneDropPaths()).toEqual([]);
  });
});
