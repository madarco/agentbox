import { describe, expect, it } from 'vitest';
import {
  HUB_WORKER_CLONE_PREFIX,
  deriveRepoLabel,
  isHubWorkerClone,
  registrationProjectKey,
} from '../lib/boxes/project-key';

const CLONE = `/tmp/${HUB_WORKER_CLONE_PREFIX}f9d4a8ab-e57d-428c-9464-f5eca4bef594`;

describe('isHubWorkerClone', () => {
  it('recognizes the control box per-job checkout', () => {
    expect(isHubWorkerClone(CLONE)).toBe(true);
  });

  it('leaves a real project folder alone', () => {
    expect(isHubWorkerClone('/Users/marco/Projects/agentbox-test-repo')).toBe(false);
    // A folder that merely lives in /tmp is still a folder.
    expect(isHubWorkerClone('/tmp/my-scratch-repo')).toBe(false);
  });
});

describe('registrationProjectKey', () => {
  const repoReg = {
    name: 'wispy-fox',
    originUrl: 'https://github.com/madarco/agentbox-test-repo.git',
    projectSlug: 'madarco__agentbox-test-repo',
  };

  it('groups a PC box by its host folder', () => {
    const k = registrationProjectKey({
      ...repoReg,
      worktrees: [{ hostMainRepo: '/Users/marco/Projects/agentbox-test-repo' }],
    });
    expect(k.repo).toBe('agentbox-test-repo');
  });

  // The bug: the control box records its throwaway clone as `hostMainRepo`, so
  // grouping by it named the card after a directory that is already deleted —
  // and made the card vanish with the box that produced it.
  it('ignores a worker clone and groups by the repo instead', () => {
    const k = registrationProjectKey({ ...repoReg, worktrees: [{ hostMainRepo: CLONE }] });
    expect(k.repo).toBe('madarco/agentbox-test-repo');
    expect(k.repo).not.toContain(HUB_WORKER_CLONE_PREFIX);
  });

  // Two boxes of the same repo, built by different create jobs, must land on ONE
  // card — otherwise every create still spawns its own project.
  it('gives every box of a repo the same id, whatever job built it', () => {
    const a = registrationProjectKey({ ...repoReg, worktrees: [{ hostMainRepo: `${CLONE}-a` }] });
    const b = registrationProjectKey({
      ...repoReg,
      worktrees: [{ hostMainRepo: `/tmp/${HUB_WORKER_CLONE_PREFIX}totally-different-job` }],
    });
    expect(a.id).toBe(b.id);
  });

  it('keys on the slug, so two owners of the same repo name stay apart', () => {
    const mine = registrationProjectKey({
      name: 'x',
      projectSlug: 'madarco__app',
      originUrl: 'https://github.com/madarco/app.git',
      worktrees: [{ hostMainRepo: CLONE }],
    });
    const theirs = registrationProjectKey({
      name: 'y',
      projectSlug: 'acme__app',
      originUrl: 'https://github.com/acme/app.git',
      worktrees: [{ hostMainRepo: CLONE }],
    });
    expect(mine.id).not.toBe(theirs.id);
  });

  it('falls back to the box name when there is no repo identity at all', () => {
    const k = registrationProjectKey({ name: 'lonely-box', worktrees: [{ hostMainRepo: CLONE }] });
    expect(k.repo).toBe('lonely-box');
  });
});

describe('deriveRepoLabel', () => {
  it('reads owner/repo from https and ssh remotes', () => {
    expect(deriveRepoLabel('https://github.com/madarco/agentbox.git')).toBe('madarco/agentbox');
    expect(deriveRepoLabel('git@github.com:madarco/agentbox.git')).toBe('madarco/agentbox');
  });

  it('passes an unrecognizable remote through', () => {
    expect(deriveRepoLabel('weird')).toBe('weird');
  });
});
