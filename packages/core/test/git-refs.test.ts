import { describe, expect, it } from 'vitest';
import {
  isResolvedBranch,
  isSanctionedPushBranch,
  isScratchBranch,
  landRefspec,
  remoteTrackingRef,
  resolveLandDest,
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
