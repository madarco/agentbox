import { describe, expect, it } from 'vitest';
import {
  isAllowedPushTarget,
  isResolvedBranch,
  isSanctionedPushBranch,
  isScratchBranch,
  landRefspec,
  remoteTrackingRef,
  resolveLandDest,
  pushArgvTargetsAllowed,
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

  describe('isSanctionedPushBranch', () => {
    it('always allows a scratch branch, regardless of sanctioned value', () => {
      expect(isSanctionedPushBranch('agentbox/box1', undefined)).toBe(true);
      expect(isSanctionedPushBranch('agentbox/box1', 'main')).toBe(true);
    });
    it('allows a non-scratch branch only when it equals the sanctioned branch', () => {
      expect(isSanctionedPushBranch('main', 'main')).toBe(true);
      expect(isSanctionedPushBranch('feature/x', 'feature/x')).toBe(true);
    });
    it('rejects an agent-switched branch that is not the sanctioned one', () => {
      expect(isSanctionedPushBranch('main', 'agentbox/box1')).toBe(false);
      expect(isSanctionedPushBranch('rogue', 'main')).toBe(false);
    });
    it('rejects when sanctioned is unset or branch is empty/HEAD', () => {
      expect(isSanctionedPushBranch('main', undefined)).toBe(false);
      expect(isSanctionedPushBranch('', 'main')).toBe(false);
      expect(isSanctionedPushBranch('HEAD', 'HEAD')).toBe(false);
      expect(isSanctionedPushBranch(undefined, undefined)).toBe(false);
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
 * The relay appends the box's argv tail to its own `push <remote> <branch>`,
 * and git accepts several refspecs — so the approval bypass has to hold for
 * every ref the assembled command would write, not just the relay's own.
 */
describe('push argv target vetting', () => {
  const policy = { branch: 'agentbox/box-one', sanctionedBranch: 'feature/x' };

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

  describe('isAllowedPushTarget', () => {
    it('allows any scratch branch, the create-time branch and the sanctioned branch', () => {
      expect(isAllowedPushTarget('agentbox/other', policy)).toBe(true);
      expect(isAllowedPushTarget('agentbox/box-one', policy)).toBe(true);
      expect(isAllowedPushTarget('feature/x', policy)).toBe(true);
    });
    it('refuses anything else', () => {
      expect(isAllowedPushTarget('main', policy)).toBe(false);
      expect(isAllowedPushTarget('main', {})).toBe(false);
    });
  });

  describe('pushArgvTargetsAllowed', () => {
    it("allows an empty tail (the product's normal push)", () => {
      expect(pushArgvTargetsAllowed([], policy)).toBe(true);
    });
    it('allows the target-neutral flags the product itself sends', () => {
      expect(pushArgvTargetsAllowed(['--force'], policy)).toBe(true);
      expect(pushArgvTargetsAllowed(['--force-with-lease'], policy)).toBe(true);
      expect(pushArgvTargetsAllowed(['-u', '--quiet', '--dry-run'], policy)).toBe(true);
    });
    it('allows the =value form of a target-neutral flag', () => {
      expect(pushArgvTargetsAllowed(['--force-with-lease=main:abc123'], policy)).toBe(true);
    });
    it('allows a refspec that names an already-sanctioned target', () => {
      expect(pushArgvTargetsAllowed(['agentbox/other'], policy)).toBe(true);
      expect(pushArgvTargetsAllowed(['HEAD:refs/heads/agentbox/x'], policy)).toBe(true);
      expect(pushArgvTargetsAllowed(['agentbox/box-one'], policy)).toBe(true);
      expect(pushArgvTargetsAllowed(['feature/x'], policy)).toBe(true);
    });
    it('refuses a refspec that adds an unsanctioned target', () => {
      expect(pushArgvTargetsAllowed(['other-branch'], policy)).toBe(false);
      expect(pushArgvTargetsAllowed(['HEAD:refs/heads/other'], policy)).toBe(false);
      expect(pushArgvTargetsAllowed(['--force', 'main'], policy)).toBe(false);
    });
    it('refuses the flags that publish refs it cannot enumerate', () => {
      for (const flag of ['--all', '--mirror', '--tags', '--follow-tags', '--prune']) {
        expect(pushArgvTargetsAllowed([flag], policy)).toBe(false);
      }
    });
    it('refuses a deletion', () => {
      expect(pushArgvTargetsAllowed(['--delete', 'agentbox/other'], policy)).toBe(false);
      expect(pushArgvTargetsAllowed(['-d', 'agentbox/other'], policy)).toBe(false);
      expect(pushArgvTargetsAllowed([':agentbox/other'], policy)).toBe(false);
    });
    it('refuses a redirected repository, value and all', () => {
      // `--repo <url>` must not be allowed, and its value must not be read as
      // a separate token that might have passed on its own.
      expect(pushArgvTargetsAllowed(['--repo', 'https://evil.example/x.git'], policy)).toBe(false);
      expect(pushArgvTargetsAllowed(['--repo=https://evil.example/x.git'], policy)).toBe(false);
      expect(pushArgvTargetsAllowed(['--receive-pack=/tmp/x'], policy)).toBe(false);
    });
    it('refuses any flag it does not recognise (fail closed)', () => {
      expect(pushArgvTargetsAllowed(['--brand-new-git-flag'], policy)).toBe(false);
      expect(pushArgvTargetsAllowed(['-fq'], policy)).toBe(false);
      expect(pushArgvTargetsAllowed(['-o', 'ci.skip'], policy)).toBe(false);
    });
    it('treats a token after -- as a refspec, not as a flag', () => {
      expect(pushArgvTargetsAllowed(['--', 'agentbox/other'], policy)).toBe(true);
      expect(pushArgvTargetsAllowed(['--', 'main'], policy)).toBe(false);
      expect(pushArgvTargetsAllowed(['--', '--force'], policy)).toBe(false);
    });
    it('refuses a second remote positional', () => {
      expect(pushArgvTargetsAllowed(['upstream', 'agentbox/other'], policy)).toBe(false);
    });
    it('with no branches known, a scratch target still passes and nothing else does', () => {
      expect(pushArgvTargetsAllowed(['agentbox/other'], {})).toBe(true);
      expect(pushArgvTargetsAllowed(['main'], {})).toBe(false);
    });
  });
});
