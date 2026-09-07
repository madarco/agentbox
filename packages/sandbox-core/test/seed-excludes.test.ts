import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  GIT_MODE_EXCLUDE_DIRS,
  dropHostOnlyPaths,
  seedExcludeTarArgs,
} from '../src/sync/concerns/workspace-files.js';

/**
 * The seed half of the invariant `.agentbox/` never crosses the box boundary.
 *
 * The pull half was already true; the seed half was not, and a host
 * `<project>/.agentbox/bots/` — where `download --backup` writes a bot's
 * workspace AND its gateway identity — was copied into every new box created
 * from that project.
 */
describe('seedExcludeTarArgs', () => {
  it('derives from the pull-side list so the two cannot drift', () => {
    // If someone adds a dir to GIT_MODE_EXCLUDE_DIRS, the seed must drop it too
    // — a dir the pull refuses to bring back but the seed still pushes in is
    // the asymmetry this whole change exists to remove.
    expect(seedExcludeTarArgs()).toEqual(GIT_MODE_EXCLUDE_DIRS.map((d) => `--exclude=${d}`));
  });

  it('emits a bare name, which is what both tars can actually honour', () => {
    // A `./`-prefixed pattern would read as root-anchored and is not: MEASURED
    // on bsdtar 3.5.3, `--exclude=./.agentbox` still drops `sub/.agentbox`.
    // Writing the anchored-looking form would document a guarantee neither tar
    // gives.
    for (const arg of seedExcludeTarArgs()) expect(arg).not.toMatch(/^--exclude=\.\//);
  });

  it('excludes the dir at the root and at any depth', () => {
    // The behavioural check: real tar, real tree. A nested `.agentbox` is ours
    // too — `download --backup` from a monorepo sub-project writes one.
    const src = mkdtempSync(join(tmpdir(), 'agentbox-seed-src-'));
    mkdirSync(join(src, '.agentbox', 'bots', 'ada', 'state'), { recursive: true });
    writeFileSync(join(src, '.agentbox', 'bots', 'ada', 'state', 'openclaw.json'), '{}');
    mkdirSync(join(src, 'sub', '.agentbox'), { recursive: true });
    writeFileSync(join(src, 'sub', '.agentbox', 'keep.txt'), 'mine');
    writeFileSync(join(src, 'app.ts'), 'export {};');

    const members = execFileSync('tar', [...seedExcludeTarArgs(), '-cf', '-', '.'], {
      cwd: src,
      encoding: 'buffer',
      maxBuffer: 1e8,
    });
    const listed = execFileSync('tar', ['-tf', '-'], {
      input: members,
      encoding: 'utf8',
      maxBuffer: 1e8,
    })
      .split('\n')
      .map((l) => l.replace(/^\.\//, '').replace(/\/$/, ''))
      .filter((l) => l.length > 0);

    expect(listed).toContain('app.ts');
    expect(listed.some((l) => l.includes('.agentbox'))).toBe(false);
  });
});

describe('dropHostOnlyPaths', () => {
  it('drops the root dir from a NUL list and keeps everything else', () => {
    const input = '.agentbox/bots/ada/manifest.json\0src/app.ts\0.agentbox\0';
    expect(dropHostOnlyPaths(input)).toBe('src/app.ts\0');
  });

  it('drops a nested dir of the same name too', () => {
    // Must agree with the tar side, which cannot anchor. Disagreeing would put
    // the two halves of one seed at odds about what a path list means.
    expect(dropHostOnlyPaths('sub/.agentbox/keep.txt\0')).toBe('');
  });

  it('does not drop the last path when the list is unterminated', () => {
    // `git ls-files -z` NUL-TERMINATES; a consumer that assumes separators has
    // dropped the final path here before (the resync probe bug).
    expect(dropHostOnlyPaths('a.txt\0b.txt')).toBe('a.txt\0b.txt\0');
  });

  it('returns an empty string when everything was host-only', () => {
    // Callers skip the tar entirely on '' — a tar of an empty list is an error
    // on GNU tar, not an empty archive.
    expect(dropHostOnlyPaths('.agentbox/x\0')).toBe('');
    expect(dropHostOnlyPaths('')).toBe('');
  });

  it('handles a ./-prefixed list', () => {
    expect(dropHostOnlyPaths('./.agentbox/x\0./src/a.ts\0')).toBe('./src/a.ts\0');
  });
});
