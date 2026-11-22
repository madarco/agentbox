import { describe, expect, it } from 'vitest';
import {
  boxNameBasisFromOriginUrl,
  deriveRepoLabel,
  custodySlugCandidates,
  isEphemeralWorkerClone,
  registrationOrigin,
  isHubWorkerClone,
  legacyProjectSlugFromOriginUrl,
  ownerRepoFromOriginUrl,
  projectSlugFromOriginUrl,
  repoKeyAtEdge,
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
    expect(slugs[0]).toBe('github.com__madarco__agentbox');
  });

  it('ignores case, keeps the host and keeps subgroups (the legacy slug did none)', () => {
    expect(projectSlugFromOriginUrl('git@github.com:Madarco/AgentBox.git')).toBe(
      projectSlugFromOriginUrl('https://github.com/madarco/agentbox'),
    );
    expect(projectSlugFromOriginUrl('https://gitlab.com/madarco/agentbox')).not.toBe(
      projectSlugFromOriginUrl('https://github.com/madarco/agentbox'),
    );
    expect(projectSlugFromOriginUrl('ssh://git@gitlab.example.com:2222/group/sub/repo.git')).toBe(
      'gitlab.example.com__group__sub__repo',
    );
  });

  it('sanitizes characters that are illegal in a custody path segment', () => {
    // A custody segment is [A-Za-z0-9._-]; anything else must be replaced, not
    // passed through to be rejected (or to escape the scope) at the store.
    expect(projectSlugFromOriginUrl('https://example.com/some~owner/re po.git')).toMatch(
      /^example\.com__some-owner__re-po-[0-9a-f]{16}$/,
    );
  });

  it('agrees across URL shapes even for a percent-encoded path', () => {
    expect(projectSlugFromOriginUrl('https://example.com/o/re%20po.git')).toBe(
      projectSlugFromOriginUrl('git@example.com:o/re po.git'),
    );
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

  it('returns null when the origin carries no repo path', () => {
    expect(projectSlugFromOriginUrl('https://github.com')).toBeNull();
    expect(projectSlugFromOriginUrl('/srv/repos/app.git')).toBeNull();
  });
});

describe('repoKeyAtEdge', () => {
  const sshConfig: Record<string, string> = {
    'github-work': 'github.com',
    'github.com-work': 'github.com',
    'work.github.com': 'github.com',
    // `Host github.com / HostName ssh.github.com / Port 443`
    'github.com': 'ssh.github.com',
    'gitlab.com': 'altssh.gitlab.com',
  };
  const resolveHost = (h: string) => Promise.resolve(sshConfig[h] ?? h);

  it('expands an alias whenever ssh -G names a different host, dotted or not', async () => {
    for (const url of [
      'git@github-work:Acme/Web.git',
      'git@github.com-work:acme/web.git',
      'ssh://git@work.github.com/acme/web',
    ]) {
      expect(await repoKeyAtEdge(url, { resolveHost }), url).toBe('github.com/acme/web');
    }
  });

  it('maps the ssh-over-443 endpoints back, so ssh and https keys agree', async () => {
    expect(await repoKeyAtEdge('git@github.com:acme/web.git', { resolveHost })).toBe(
      'github.com/acme/web',
    );
    expect(await repoKeyAtEdge('git@gitlab.com:g/sub/r.git', { resolveHost })).toBe(
      'gitlab.com/g/sub/r',
    );
    expect(await repoKeyAtEdge('https://github.com/acme/web', { resolveHost })).toBe(
      'github.com/acme/web',
    );
  });

  it('never consults ssh config for an https remote', async () => {
    const asked: string[] = [];
    await repoKeyAtEdge('https://github-work/acme/web', {
      resolveHost: (h) => {
        asked.push(h);
        return Promise.resolve('github.com');
      },
    });
    expect(asked).toEqual([]);
  });
});

describe('legacyProjectSlugFromOriginUrl', () => {
  it('is the pre-repo-key owner__repo slug, case kept', () => {
    expect(legacyProjectSlugFromOriginUrl('git@github.com:Madarco/AgentBox.git')).toBe(
      'Madarco__AgentBox',
    );
    expect(legacyProjectSlugFromOriginUrl('https://gitlab.com/group/sub/repo.git')).toBe(
      'sub__repo',
    );
  });
});

describe('custodySlugCandidates', () => {
  it('reads the new slug first and the legacy one last, deduplicated', () => {
    expect(custodySlugCandidates({ originUrl: 'git@github.com:Madarco/AgentBox.git' })).toEqual([
      'github.com__madarco__agentbox',
      'Madarco__AgentBox',
    ]);
  });

  it('puts the PC-computed (alias-expanded) key ahead of the hub-derived one', () => {
    expect(
      custodySlugCandidates({
        repoKey: 'github.com/madarco/agentbox',
        originUrl: 'git@github-work:madarco/agentbox.git',
        projectSlug: 'madarco__agentbox',
      }),
    ).toEqual([
      'github.com__madarco__agentbox',
      'github-work__madarco__agentbox',
      'madarco__agentbox',
    ]);
  });

  it('is empty for a box with no remote', () => {
    expect(custodySlugCandidates({})).toEqual([]);
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

describe('registrationOrigin', () => {
  it('records the requesting PC, not the worker, for a box built from a hub clone (sign-off of #426)', async () => {
    const r = await registrationOrigin({
      originUrl: 'https://github.com/acme/web.git',
      folder: '/tmp/agentbox-hub-worker-job1',
      repoKey: 'github.com/acme/web',
      requester: { machineId: 'pc-a-id', label: 'laptop', folder: '/Users/a/web' },
    });
    expect(r).toEqual({
      repoKey: 'github.com/acme/web',
      originMachineId: 'pc-a-id',
      originMachineLabel: 'laptop',
      originFolder: '/Users/a/web',
    });
  });

  it('records no origin for a worker clone when nobody asked (a web UI create)', async () => {
    const r = await registrationOrigin({
      originUrl: 'https://github.com/acme/web.git',
      folder: '/tmp/agentbox-hub-worker-job1',
    });
    expect(r.originMachineId).toBeUndefined();
    expect(r.originFolder).toBeUndefined();
  });
});

describe('isEphemeralWorkerClone', () => {
  it("matches both workers' per-job clones and nothing else", () => {
    expect(isEphemeralWorkerClone('/tmp/agentbox-hub-worker-74d5')).toBe(true);
    expect(isEphemeralWorkerClone('/var/folders/x/T/agentbox-cp-worker-job-1')).toBe(true);
    expect(isEphemeralWorkerClone('/Users/me/src/agentbox')).toBe(false);
    expect(isEphemeralWorkerClone('/tmp/agentbox-cp-worker-1/nested')).toBe(false);
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
