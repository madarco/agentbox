import { describe, expect, it } from 'vitest';
import { resolveMergeTarget } from '../src/commands/git.js';

/**
 * What `agentbox git pull` merges after the relay's host-side fetch.
 *
 * The bug this pins, caught on a live docker box: the merge target was an
 * unconditional `origin/HEAD`, so every pull failed with
 * `merge: origin/HEAD - not something we can merge` — `refs/remotes/origin/HEAD`
 * is written by `git clone`, and `/workspace` is a WORKTREE on the host's
 * bind-mounted `.git/`, which never had one.
 */
function fakeGit(refs: Record<string, string>) {
  return async (args: string[]): Promise<string> => {
    const key = args.join(' ');
    return refs[key] ?? '';
  };
}

describe('resolveMergeTarget', () => {
  it('prefers the branch upstream when one is configured', async () => {
    const probe = fakeGit({
      'rev-parse --abbrev-ref --symbolic-full-name @{u}': 'origin/feature',
      'rev-parse --abbrev-ref HEAD': 'feature',
    });
    expect(await resolveMergeTarget('origin', '/workspace', probe)).toBe('origin/feature');
  });

  it('falls back to <remote>/<branch> — the box branch, NOT the default branch', async () => {
    // The docker box case: no upstream, but the branch was pushed so its
    // remote-tracking ref exists. Merging `origin/HEAD` here would have pulled
    // `main` into `agentbox/ghsmoke`.
    const probe = fakeGit({
      'rev-parse --abbrev-ref HEAD': 'agentbox/ghsmoke',
      'rev-parse --verify --quiet origin/agentbox/ghsmoke': '35f1a4eb',
    });
    expect(await resolveMergeTarget('origin', '/workspace', probe)).toBe('origin/agentbox/ghsmoke');
  });

  it('falls back to <remote>/HEAD when neither exists', async () => {
    // A freshly cloned worktree whose branch was never pushed: origin/HEAD is
    // the only thing that can resolve, and it is what clone wrote.
    const probe = fakeGit({ 'rev-parse --abbrev-ref HEAD': 'agentbox/fresh' });
    expect(await resolveMergeTarget('origin', '/workspace', probe)).toBe('origin/HEAD');
  });

  it('does not build a target from a detached HEAD', async () => {
    const probe = fakeGit({
      'rev-parse --abbrev-ref HEAD': 'HEAD',
      'rev-parse --verify --quiet origin/HEAD': 'deadbeef',
    });
    expect(await resolveMergeTarget('origin', '/workspace', probe)).toBe('origin/HEAD');
  });

  it('honours a non-origin remote', async () => {
    const probe = fakeGit({
      'rev-parse --abbrev-ref HEAD': 'agentbox/x',
      'rev-parse --verify --quiet upstream/agentbox/x': 'cafe',
    });
    expect(await resolveMergeTarget('upstream', '/workspace', probe)).toBe('upstream/agentbox/x');
  });
});
