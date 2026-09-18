import { describe, expect, it } from 'vitest';
import {
  isResolvedBranch,
  isScratchBranch,
  landRefspec,
  remoteTrackingRef,
  resolveLandDest,
  pushDestructiveReason,
  pushRefspecTarget,
  resolveRemote,
  sanitizeGitArgs,
  SCRATCH_BRANCH_PREFIX,
  upstreamRef,
} from '../src/sync/git-refs.js';

describe('git-refs pure decisions', () => {
  describe('resolveRemote', () => {
    it('defaults undefined to origin', () => {
      expect(resolveRemote(undefined)).toBe('origin');
    });
    it('keeps an empty-string remote empty (?? not ||)', () => {
      // The regression guard: `||` would coerce '' to 'origin' and silently
      // change the push target. Only undefined falls back.
      expect(resolveRemote('')).toBe('');
    });
    it('passes a named remote through', () => {
      expect(resolveRemote('upstream')).toBe('upstream');
    });
  });

  describe('resolveLandDest', () => {
    it('falls back to src when as is undefined', () => {
      expect(resolveLandDest('main', undefined)).toBe('main');
    });
    it('falls back to src when as is empty', () => {
      expect(resolveLandDest('main', '')).toBe('main');
    });
    it('uses as when provided', () => {
      expect(resolveLandDest('main', 'feat/x')).toBe('feat/x');
    });
  });

  describe('landRefspec', () => {
    it('builds a fast-forward refspec when force is off', () => {
      expect(landRefspec('main', 'main', false)).toBe('main:refs/heads/main');
      expect(landRefspec('main', 'main', undefined)).toBe('main:refs/heads/main');
    });
    it('prepends + when force is on', () => {
      expect(landRefspec('main', 'main', true)).toBe('+main:refs/heads/main');
    });
    it('honors a distinct destination', () => {
      expect(landRefspec('src', 'dest', false)).toBe('src:refs/heads/dest');
    });
  });

  describe('isScratchBranch', () => {
    it('matches a per-box scratch branch', () => {
      expect(isScratchBranch('agentbox/box-one')).toBe(true);
    });
    it('rejects a normal branch', () => {
      expect(isScratchBranch('main')).toBe(false);
    });
    it('is undefined-safe (reproduces the ?? false sites)', () => {
      expect(isScratchBranch(undefined)).toBe(false);
    });
    it('requires the trailing slash (not a bare prefix match)', () => {
      expect(isScratchBranch('agentboxfoo')).toBe(false);
    });
    it('exposes the prefix constant', () => {
      expect(SCRATCH_BRANCH_PREFIX).toBe('agentbox/');
    });
  });

  describe('upstreamRef / remoteTrackingRef', () => {
    it('upstreamRef is <remote>/<branch>', () => {
      expect(upstreamRef('origin', 'main')).toBe('origin/main');
    });
    it('remoteTrackingRef is the full refs/remotes path', () => {
      expect(remoteTrackingRef('origin', 'main')).toBe('refs/remotes/origin/main');
    });
  });

  describe('isResolvedBranch', () => {
    it('rejects an empty probe', () => {
      expect(isResolvedBranch('')).toBe(false);
    });
    it('rejects detached HEAD', () => {
      expect(isResolvedBranch('HEAD')).toBe(false);
    });
    it('accepts a real branch', () => {
      expect(isResolvedBranch('main')).toBe(true);
    });
  });

  describe('sanitizeGitArgs', () => {
    it('coerces a non-array to []', () => {
      expect(sanitizeGitArgs(undefined)).toEqual([]);
    });
    it('drops non-string entries', () => {
      expect(sanitizeGitArgs(['--tags', 3, '--force'])).toEqual(['--tags', '--force']);
    });
    it('passes an all-string array through', () => {
      expect(sanitizeGitArgs(['--set-upstream', 'origin', 'main'])).toEqual([
        '--set-upstream',
        'origin',
        'main',
      ]);
    });
  });
});

/**
 * The push approval model, inverted from what it was: adding commits to ANY
 * branch is ordinary agent work and runs silently, and only the irreversible
 * needs the user. Same shape as the `gh` policy — a blacklist, not an
 * allowlist.
 */
describe('pushDestructiveReason', () => {
  const SCRATCH = 'agentbox/box-one';

  describe('ordinary pushes (silent)', () => {
    it('allows a bare push on the scratch branch', () => {
      expect(pushDestructiveReason([], SCRATCH)).toBeNull();
    });
    it('allows a push to an arbitrary branch the agent names', () => {
      expect(pushDestructiveReason([], 'main')).toBeNull();
      expect(pushDestructiveReason(['some-new-branch'], 'main')).toBeNull();
      expect(pushDestructiveReason(['HEAD:refs/heads/other'], SCRATCH)).toBeNull();
    });
    it('allows the routine reporting/upstream flags', () => {
      expect(pushDestructiveReason(['-u', '--quiet', '--dry-run'], 'main')).toBeNull();
      expect(pushDestructiveReason(['--no-verify', '--atomic'], 'main')).toBeNull();
    });
    it('allows the safe force spellings, which refuse to clobber unseen work', () => {
      expect(pushDestructiveReason(['--force-with-lease'], 'main')).toBeNull();
      expect(pushDestructiveReason(['--force-with-lease=main:abc123'], 'main')).toBeNull();
      expect(pushDestructiveReason(['--force-if-includes'], 'main')).toBeNull();
    });
    it("allows a force-push to the box's own scratch branch", () => {
      expect(pushDestructiveReason(['--force'], SCRATCH)).toBeNull();
      expect(pushDestructiveReason(['-f'], SCRATCH)).toBeNull();
      expect(pushDestructiveReason(['--force', 'agentbox/other'], SCRATCH)).toBeNull();
      expect(pushDestructiveReason(['+HEAD:refs/heads/agentbox/other'], SCRATCH)).toBeNull();
    });
    it('allows a plain new tag push', () => {
      expect(pushDestructiveReason(['--tags'], SCRATCH)).toBeNull();
      expect(pushDestructiveReason(['--follow-tags'], 'main')).toBeNull();
      expect(pushDestructiveReason(['HEAD:refs/tags/v1'], 'main')).toBeNull();
    });
    it('allows pushing every matching branch, as long as nothing is rewritten', () => {
      expect(pushDestructiveReason(['--all'], 'main')).toBeNull();
    });
  });

  describe('destructive pushes (confirmed)', () => {
    it('flags a deletion in every spelling', () => {
      expect(pushDestructiveReason(['--delete', 'some-branch'], SCRATCH)).toMatch(/deletes/);
      expect(pushDestructiveReason(['-d', 'some-branch'], SCRATCH)).toMatch(/deletes/);
      expect(pushDestructiveReason([':some-branch'], SCRATCH)).toMatch(/deletes/);
      expect(pushDestructiveReason(['+:some-branch'], SCRATCH)).toMatch(/deletes/);
      expect(pushDestructiveReason([':refs/tags/v1'], SCRATCH)).toMatch(/deletes/);
    });
    it('flags a force-push to a branch that is not the box scratch space', () => {
      expect(pushDestructiveReason(['--force'], 'main')).toMatch(/force-pushes main/);
      expect(pushDestructiveReason(['-f'], 'feature/x')).toMatch(/force-pushes feature\/x/);
      expect(pushDestructiveReason(['--force', 'main'], SCRATCH)).toMatch(/force-pushes main/);
      expect(pushDestructiveReason(['+HEAD:refs/heads/main'], SCRATCH)).toMatch(
        /force-pushes main/,
      );
    });
    it('flags a force-push when the pushed branch is unknown (fail closed)', () => {
      expect(pushDestructiveReason(['--force'], undefined)).toMatch(/force-pushes/);
    });
    it('flags a forced tag overwrite', () => {
      expect(pushDestructiveReason(['+HEAD:refs/tags/v1'], SCRATCH)).toMatch(/force-pushes/);
      expect(pushDestructiveReason(['--force', '--tags'], SCRATCH)).toMatch(/--tags/);
      expect(pushDestructiveReason(['--force', '--all'], SCRATCH)).toMatch(/--all/);
    });
    it('flags the wholesale ref syncs', () => {
      expect(pushDestructiveReason(['--mirror'], SCRATCH)).toMatch(/mirrors/);
      expect(pushDestructiveReason(['--prune'], SCRATCH)).toMatch(/deletes remote refs/);
    });
    it('flags an argv that escapes the intended target', () => {
      expect(pushDestructiveReason(['--repo', 'https://evil.example/x.git'], SCRATCH)).toMatch(
        /redirects/,
      );
      expect(pushDestructiveReason(['--repo=https://evil.example/x.git'], SCRATCH)).toMatch(
        /redirects/,
      );
      expect(pushDestructiveReason(['--receive-pack=/tmp/x'], SCRATCH)).toMatch(/remote side/);
      expect(pushDestructiveReason(['--exec', '/tmp/x'], SCRATCH)).toMatch(/remote side/);
    });
    it('flags any flag it does not recognise (fail closed)', () => {
      expect(pushDestructiveReason(['--brand-new-git-flag'], SCRATCH)).toMatch(
        /does not recognise/,
      );
      expect(pushDestructiveReason(['-fq'], SCRATCH)).toMatch(/does not recognise/);
      expect(pushDestructiveReason(['-o', 'ci.skip'], SCRATCH)).toMatch(/does not recognise/);
    });
    it('reads a token after -- as a refspec, not as a flag', () => {
      expect(pushDestructiveReason(['--', 'some-branch'], SCRATCH)).toBeNull();
      expect(pushDestructiveReason(['--', ':some-branch'], SCRATCH)).toMatch(/deletes/);
      // After `--` this is a refspec named `--force`, not the force flag.
      expect(pushDestructiveReason(['--', '--force'], SCRATCH)).toBeNull();
    });
    it('treats a second remote positional as a non-scratch target under force', () => {
      expect(pushDestructiveReason(['--force', 'upstream', 'agentbox/other'], SCRATCH)).toMatch(
        /force-pushes upstream/,
      );
    });
  });

  describe('pushRefspecTarget', () => {
    it('reads a bare branch as its own destination', () => {
      expect(pushRefspecTarget('main')).toBe('main');
    });
    it('reads the destination side of src:dst and strips refs/heads/', () => {
      expect(pushRefspecTarget('HEAD:refs/heads/other')).toBe('other');
      expect(pushRefspecTarget('agentbox/a:agentbox/b')).toBe('agentbox/b');
    });
    it('strips a leading + (force refspec)', () => {
      expect(pushRefspecTarget('+HEAD:refs/heads/agentbox/x')).toBe('agentbox/x');
    });
    it('refuses a deletion refspec', () => {
      expect(pushRefspecTarget(':main')).toBeNull();
    });
    it('refuses a non-branch ref namespace', () => {
      expect(pushRefspecTarget('HEAD:refs/tags/v1')).toBeNull();
      expect(pushRefspecTarget('HEAD:refs/notes/x')).toBeNull();
    });
    it('refuses globs, negatives and anything not a plain branch name', () => {
      expect(pushRefspecTarget('refs/heads/*:refs/heads/*')).toBeNull();
      expect(pushRefspecTarget('^main')).toBeNull();
      expect(pushRefspecTarget('a:b:c')).toBeNull();
      expect(pushRefspecTarget('')).toBeNull();
    });
  });
});
