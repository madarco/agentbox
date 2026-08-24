import { describe, expect, it } from 'vitest';
import {
  boxNameBasisFromOriginUrl,
  deriveRepoLabel,
  isHubWorkerClone,
  ownerRepoFromOriginUrl,
  projectSlugFromOriginUrl,
} from '../src/project-slug.js';

/**
 * The custody `projects/<slug>` key is a contract between separate machines: the
 * PC writes seed material under it, and the control box's worker reads it back.
 * Every producer/consumer must derive the SAME key from the same origin, so
 * these cases pin the derivation rather than just exercising it.
 */
describe('ownerRepoFromOriginUrl', () => {
  it('parses every common git remote shape', () => {
    for (const url of [
      'https://github.com/madarco/agentbox.git',
      'https://github.com/madarco/agentbox',
      'git@github.com:madarco/agentbox.git',
      'ssh://git@github.com/madarco/agentbox.git',
      'https://github.com/madarco/agentbox/',
    ]) {
      expect(ownerRepoFromOriginUrl(url), url).toEqual({ owner: 'madarco', repo: 'agentbox' });
    }
  });

  it('takes the LAST two segments, so a nested group resolves to the real repo', () => {
    // Regression: a slugger that took the FIRST two segments turned
    // gitlab.com/group/subgroup/repo into `group__subgroup`, so a seed pushed by
    // the PC landed where the hub worker never looked.
    expect(ownerRepoFromOriginUrl('https://gitlab.com/group/subgroup/repo.git')).toEqual({
      owner: 'subgroup',
      repo: 'repo',
    });
  });

  it('returns null for a non-repo URL rather than guessing', () => {
    expect(ownerRepoFromOriginUrl('')).toBeNull();
    expect(ownerRepoFromOriginUrl('   ')).toBeNull();
    expect(ownerRepoFromOriginUrl('https://github.com/onlyowner')).toBeNull();
    expect(ownerRepoFromOriginUrl('not a url')).toBeNull();
  });
});

describe('projectSlugFromOriginUrl', () => {
  it('is stable across URL shapes for the same repo', () => {
    const slugs = [
      'https://github.com/madarco/agentbox.git',
      'git@github.com:madarco/agentbox.git',
      'ssh://git@github.com/madarco/agentbox.git',
    ].map(projectSlugFromOriginUrl);
    expect(new Set(slugs).size).toBe(1);
    expect(slugs[0]).toBe('madarco__agentbox');
  });

  it('sanitizes characters that are illegal in a custody path segment', () => {
    // A custody segment is [A-Za-z0-9._-]; anything else must be replaced, not
    // passed through to be rejected (or to escape the scope) at the store.
    expect(projectSlugFromOriginUrl('https://example.com/some~owner/re po.git')).toBe(
      'some-owner__re-po',
    );
  });

  it('agrees across URL shapes even for a path needing percent-encoding', () => {
    // `new URL` encodes the pathname but the scp-like parse doesn't, so without
    // decoding these two spellings of one repo produced different slugs
    // (`re-20po` vs `re-po`) — a seed pushed under one is invisible under the other.
    expect(projectSlugFromOriginUrl('https://example.com/o/re po.git')).toBe(
      projectSlugFromOriginUrl('git@example.com:o/re po.git'),
    );
  });

  it('does not collide across different repos', () => {
    expect(projectSlugFromOriginUrl('git@github.com:o/a.git')).not.toBe(
      projectSlugFromOriginUrl('git@github.com:o/b.git'),
    );
  });

  it('returns null when the origin carries no owner/repo', () => {
    expect(projectSlugFromOriginUrl('https://github.com/onlyowner')).toBeNull();
  });
});

/**
 * A control box builds every box from a per-job clone under
 * `$TMPDIR/agentbox-hub-worker-<jobId>` and deletes it the moment the create
 * returns. Both the hub (project-card grouping) and the CLI (`agentbox ls`, box
 * naming) have to recognize that path and substitute the repo, which is the only
 * durable identity such a box has.
 */
describe('hub-worker clone recognition', () => {
  it('matches a per-job clone path', () => {
    expect(isHubWorkerClone('/tmp/agentbox-hub-worker-74d57005-7edf-46ea-bfad-131de5653762')).toBe(
      true,
    );
  });

  it('does not match a real project folder', () => {
    expect(isHubWorkerClone('/Users/marco/Projects/Evinto/optima')).toBe(false);
  });

  it('tests the basename, not the whole path', () => {
    // A user whose checkout happens to live under a similarly-named parent must
    // not have their own folder mistaken for a throwaway clone.
    expect(isHubWorkerClone('/tmp/agentbox-hub-worker-abc/nested-real-repo')).toBe(false);
  });
});

describe('deriveRepoLabel', () => {
  it('returns owner/repo for both URL shapes', () => {
    expect(deriveRepoLabel('git@github.com:Evinto-Solutions/optima.git')).toBe(
      'Evinto-Solutions/optima',
    );
    expect(deriveRepoLabel('https://github.com/Evinto-Solutions/optima.git')).toBe(
      'Evinto-Solutions/optima',
    );
  });

  it('hands back an unparseable URL unchanged rather than inventing a label', () => {
    expect(deriveRepoLabel('not a url')).toBe('not a url');
  });
});

describe('boxNameBasisFromOriginUrl', () => {
  it('is the repo alone — the owner would bloat every box name', () => {
    expect(boxNameBasisFromOriginUrl('git@github.com:Evinto-Solutions/optima.git')).toBe('optima');
  });

  it('is null when no repo can be parsed, leaving the caller on its own default', () => {
    expect(boxNameBasisFromOriginUrl('https://github.com/onlyowner')).toBeNull();
  });
});
