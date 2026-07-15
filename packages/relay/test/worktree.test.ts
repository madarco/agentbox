import { describe, expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import type { BoxWorktree } from '../src/types.js';
import { hostRepoUnavailableReason, resolveWorktree } from '../src/worktree.js';

const tree = (over: Partial<BoxWorktree> = {}): BoxWorktree => ({
  containerPath: '/workspace',
  hostMainRepo: tmpdir(), // a dir that exists
  branch: 'agentbox/b1',
  ...over,
});

describe('resolveWorktree', () => {
  it('prefers an exact container path, then the longest prefix', () => {
    const reg = {
      boxId: 'b1',
      token: 't',
      name: 'b1',
      registeredAt: '',
      worktrees: [tree(), tree({ containerPath: '/workspace/app', hostMainRepo: '/repo/app' })],
    };
    expect(resolveWorktree(reg, '/workspace/app')?.hostMainRepo).toBe('/repo/app');
    expect(resolveWorktree(reg, '/workspace/app/src')?.hostMainRepo).toBe('/repo/app');
    expect(resolveWorktree(reg, '/workspace')?.containerPath).toBe('/workspace');
  });
});

describe('hostRepoUnavailableReason', () => {
  it('returns null when the host repo dir exists', () => {
    expect(hostRepoUnavailableReason(tree(), 'b1', 'git.push')).toBeNull();
  });

  it('rejects an empty hostMainRepo (unreconstructable host path)', () => {
    const reason = hostRepoUnavailableReason(tree({ hostMainRepo: '' }), 'b1', 'git.push');
    expect(reason).toContain('unavailable');
    expect(reason).toContain('<unset>');
  });

  it('rejects a hostMainRepo whose directory is gone (worker temp clone)', () => {
    const reason = hostRepoUnavailableReason(
      tree({ hostMainRepo: '/tmp/agentbox-hub-worker-deleted-123' }),
      'wispy-fox',
      'git.fetch',
    );
    expect(reason).toContain('host-side git.fetch is unavailable for box wispy-fox');
    expect(reason).toContain('/tmp/agentbox-hub-worker-deleted-123');
  });
});
