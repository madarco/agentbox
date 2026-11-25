import { describe, expect, it } from 'vitest';
import { createProjectCustodySlugs } from '../lib/backend/project-custody';
import { matchProjects } from '../lib/files-view';

describe('project custody slugs', () => {
  it('expands an ssh alias for a project folder on this machine', async () => {
    const asked: string[] = [];
    const slugs = createProjectCustodySlugs({
      repoKeyOf: (o) => {
        asked.push(o);
        return Promise.resolve('github.com/acme/web');
      },
    });
    const p = { originUrl: 'git@github-work:acme/web.git' };
    expect(await slugs.local(p)).toContain('github.com__acme__web');
    await slugs.local(p);
    // One ssh lookup per origin, not per listing.
    expect(asked).toEqual(['git@github-work:acme/web.git']);
  });

  it('maps the ssh-over-443 endpoint and an upper-case .GIT to the forge slug', () => {
    const slugs = createProjectCustodySlugs({ repoKeyOf: () => Promise.resolve(undefined) });
    expect(slugs.registered({ originUrl: 'ssh://git@ssh.github.com:443/acme/web.git' })).toContain(
      'github.com__acme__web',
    );
    expect(slugs.registered({ originUrl: 'https://github.com/Acme/Web.GIT' })).toContain(
      'github.com__acme__web',
    );
  });

  it('prefers the repo key a registration carries', () => {
    const slugs = createProjectCustodySlugs();
    const out = slugs.registered({
      originUrl: 'git@github-work:acme/web.git',
      repoKey: 'github.com/acme/web',
    });
    expect(out[0]).toBe('github.com__acme__web');
  });

  it('lets the Files page name a project whose origin uses an alias', async () => {
    const slugs = createProjectCustodySlugs({
      repoKeyOf: () => Promise.resolve('github.com/acme/web'),
    });
    const project = {
      id: 'p',
      name: 'web',
      originUrl: 'git@github-work:acme/web.git',
      custodySlugs: await slugs.local({ originUrl: 'git@github-work:acme/web.git' }),
    };
    expect(matchProjects('github.com__acme__web', [project]).map((x) => x.id)).toEqual(['p']);
  });

  it('survives a failing lookup', async () => {
    const slugs = createProjectCustodySlugs({
      repoKeyOf: () => Promise.reject(new Error('no ssh')),
    });
    expect(await slugs.local({ originUrl: 'https://github.com/acme/web' })).toContain(
      'github.com__acme__web',
    );
  });
});
