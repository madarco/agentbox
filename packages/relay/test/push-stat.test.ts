import { mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { describe, expect, it } from 'vitest';
import {
  boxPushLineStat,
  parseShortstat,
  pushedRef,
  pushLineStat,
  readRefTip,
  type BoxGitExec,
} from '../src/workspaces/push-stat.js';

async function git(repo: string, ...args: string[]): Promise<string> {
  const r = await execa('git', [
    '-c',
    'user.name=t',
    '-c',
    'user.email=t@t',
    '-c',
    'commit.gpgsign=false',
    '-C',
    repo,
    ...args,
  ]);
  return r.stdout.trim();
}

/** A repo on `main` with one commit, and a helper that commits `lines` lines to a file. */
async function repo(): Promise<{
  dir: string;
  commit: (file: string, lines: number) => Promise<string>;
}> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'agentbox-pushstat-')));
  await git(dir, 'init', '-q', '-b', 'main');
  const commit = async (file: string, lines: number): Promise<string> => {
    await writeFile(
      join(dir, file),
      Array.from({ length: lines }, (_, i) => `l${String(i)}\n`).join(''),
    );
    await git(dir, 'add', file);
    await git(dir, 'commit', '-q', '-m', file);
    return git(dir, 'rev-parse', 'HEAD');
  };
  await commit('base.txt', 3);
  return { dir, commit };
}

describe('pushedRef', () => {
  it('names the tracking ref for a remote, and the local branch for a landing or a URL', () => {
    expect(pushedRef('feat/x', { remote: 'origin' })).toBe('refs/remotes/origin/feat/x');
    expect(pushedRef('feat/x', {})).toBe('refs/remotes/origin/feat/x');
    expect(pushedRef('feat/x', { hostOnly: true, remote: 'origin' })).toBe('refs/heads/feat/x');
    expect(pushedRef('feat/x', { remote: 'git@github.com:o/r.git' })).toBe('refs/heads/feat/x');
  });
});

describe('parseShortstat', () => {
  it('reads each part, any of them optional', () => {
    expect(parseShortstat(' 2 files changed, 5 insertions(+), 1 deletion(-)')).toEqual({
      filesChanged: 2,
      additions: 5,
      deletions: 1,
    });
    expect(parseShortstat('')).toEqual({ filesChanged: 0, additions: 0, deletions: 0 });
  });
});

describe('pushLineStat', () => {
  it('diffs the old tip against the new one', async () => {
    const { dir, commit } = await repo();
    await git(dir, 'checkout', '-q', '-b', 'feat');
    const old = await commit('a.txt', 4);
    await git(dir, 'update-ref', 'refs/remotes/origin/feat', old);
    const before = await readRefTip(dir, 'refs/remotes/origin/feat');
    expect(before).toBe(old);
    const next = await commit('b.txt', 7);
    await git(dir, 'update-ref', 'refs/remotes/origin/feat', next);
    expect(
      await pushLineStat({ repo: dir, ref: 'refs/remotes/origin/feat', branch: 'feat', before }),
    ).toEqual({ additions: 7, deletions: 0 });
  });

  it('measures a rebase + force-push from the merge base, not the upstream it moved onto', async () => {
    const { dir, commit } = await repo();
    await git(dir, 'checkout', '-q', '-b', 'feat');
    const old = await commit('a.txt', 4);
    await git(dir, 'update-ref', 'refs/remotes/origin/feat', old);
    await git(dir, 'checkout', '-q', 'main');
    await commit('main-only.txt', 50);
    await git(dir, 'update-ref', 'refs/remotes/origin/main', 'main');
    await git(dir, 'checkout', '-q', 'feat');
    await git(dir, '-c', 'core.editor=true', 'rebase', '-q', 'main');
    const rebased = await git(dir, 'rev-parse', 'HEAD');
    await git(dir, 'update-ref', 'refs/remotes/origin/feat', rebased);
    expect(
      await pushLineStat({
        repo: dir,
        ref: 'refs/remotes/origin/feat',
        branch: 'feat',
        before: old,
      }),
    ).toEqual({ additions: 4, deletions: 0 });
  });

  it('measures a first push from the merge base with the default branch', async () => {
    const { dir, commit } = await repo();
    await git(dir, 'checkout', '-q', '-b', 'feat');
    await commit('a.txt', 4);
    await commit('b.txt', 2);
    await git(dir, 'checkout', '-q', 'main');
    await commit('main-only.txt', 50);
    // No tracking ref at all: the local branch stands in for it.
    expect(
      await pushLineStat({ repo: dir, ref: 'refs/remotes/origin/feat', branch: 'feat' }),
    ).toEqual({ additions: 6, deletions: 0 });
  });

  it('has nothing to say for a push that moved nothing, an unknown ref, or no repo', async () => {
    const { dir, commit } = await repo();
    const tip = await commit('a.txt', 1);
    expect(
      await pushLineStat({ repo: dir, ref: 'refs/heads/main', branch: 'main', before: tip }),
    ).toBeUndefined();
    // The default branch itself: its merge base is its own tip.
    expect(
      await pushLineStat({ repo: dir, ref: 'refs/heads/main', branch: 'main' }),
    ).toBeUndefined();
    expect(
      await pushLineStat({ repo: dir, ref: 'refs/heads/nope', branch: 'nope' }),
    ).toBeUndefined();
    const empty = await realpath(await mkdtemp(join(tmpdir(), 'agentbox-pushstat-none-')));
    expect(
      await pushLineStat({ repo: empty, ref: 'refs/heads/main', branch: 'main' }),
    ).toBeUndefined();
    expect(await readRefTip(empty, 'refs/heads/main')).toBeUndefined();
  });
});

/**
 * A box's git, as `provider.exec` hands it over: answers what `answers` maps the
 * joined argv to, exit 1 for anything else (git's own "unknown revision").
 */
function fakeBoxGit(answers: Record<string, string>): {
  exec: BoxGitExec;
  calls: string[][];
} {
  const calls: string[][] = [];
  const exec: BoxGitExec = async (args) => {
    calls.push(args);
    const hit = answers[args.join(' ')];
    return hit === undefined ? { exitCode: 1, stdout: '' } : { exitCode: 0, stdout: `${hit}\n` };
  };
  return { exec, calls };
}

const HEAD_SHA = 'f'.repeat(40);
const BASE_SHA = 'a'.repeat(40);
const HEAD_ARGS = 'rev-parse --verify --quiet HEAD^{commit}';

describe('boxPushLineStat', () => {
  it('measures from the merge base with the default branch, falling through the refs', async () => {
    const { exec, calls } = fakeBoxGit({
      [HEAD_ARGS]: HEAD_SHA,
      [`merge-base origin/main ${HEAD_SHA}`]: BASE_SHA,
      [`diff --shortstat ${BASE_SHA}..${HEAD_SHA}`]:
        ' 2 files changed, 9 insertions(+), 4 deletions(-)',
    });
    expect(await boxPushLineStat(exec)).toEqual({ additions: 9, deletions: 4 });
    // origin/HEAD is tried first and answers nothing, so origin/main is asked next.
    expect(calls.map((a) => a.join(' '))).toEqual([
      HEAD_ARGS,
      `merge-base origin/HEAD ${HEAD_SHA}`,
      `merge-base origin/main ${HEAD_SHA}`,
      `diff --shortstat ${BASE_SHA}..${HEAD_SHA}`,
    ]);
  });

  it('reaches the local branch names when the box has no remote-tracking refs', async () => {
    const { exec, calls } = fakeBoxGit({
      [HEAD_ARGS]: HEAD_SHA,
      [`merge-base master ${HEAD_SHA}`]: BASE_SHA,
      [`diff --shortstat ${BASE_SHA}..${HEAD_SHA}`]: ' 1 file changed, 1 insertion(+)',
    });
    expect(await boxPushLineStat(exec)).toEqual({ additions: 1, deletions: 0 });
    expect(calls.map((a) => a[1])).toContain('main');
  });

  it('measures from the old tip when the push fast-forwarded it', async () => {
    const before = 'b'.repeat(40);
    const { exec, calls } = fakeBoxGit({
      [HEAD_ARGS]: HEAD_SHA,
      [`merge-base --is-ancestor ${before} ${HEAD_SHA}`]: '',
      [`diff --shortstat ${before}..${HEAD_SHA}`]: ' 1 file changed, 3 insertions(+)',
    });
    expect(await boxPushLineStat(exec, { before })).toEqual({ additions: 3, deletions: 0 });
    expect(calls.some((a) => a[1] === 'origin/HEAD')).toBe(false);
  });

  it('falls back to the default branch when the old tip was rewritten', async () => {
    const before = 'b'.repeat(40);
    const { exec } = fakeBoxGit({
      [HEAD_ARGS]: HEAD_SHA,
      [`merge-base origin/HEAD ${HEAD_SHA}`]: BASE_SHA,
      [`diff --shortstat ${BASE_SHA}..${HEAD_SHA}`]: ' 1 file changed, 7 insertions(+)',
    });
    expect(await boxPushLineStat(exec, { before })).toEqual({ additions: 7, deletions: 0 });
  });

  it('is undefined for a push that moved nothing, an unreadable HEAD or no base', async () => {
    const moved = fakeBoxGit({ [HEAD_ARGS]: HEAD_SHA });
    expect(await boxPushLineStat(moved.exec, { before: HEAD_SHA })).toBeUndefined();
    expect(await boxPushLineStat(fakeBoxGit({}).exec)).toBeUndefined();
    expect(await boxPushLineStat(moved.exec)).toBeUndefined();
    const empty = fakeBoxGit({
      [HEAD_ARGS]: HEAD_SHA,
      [`merge-base origin/HEAD ${HEAD_SHA}`]: BASE_SHA,
      [`diff --shortstat ${BASE_SHA}..${HEAD_SHA}`]: '',
    });
    expect(await boxPushLineStat(empty.exec)).toBeUndefined();
  });

  it('gives up on a box that does not answer within the budget', async () => {
    const exec: BoxGitExec = () => new Promise(() => {});
    expect(await boxPushLineStat(exec, { timeoutMs: 20 })).toBeUndefined();
  });
});
