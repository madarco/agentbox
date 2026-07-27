import { describe, expect, it } from 'vitest';
import { repoNameFromOrigin, repoNameFromRegistration, repoNameFromSlug } from './project-name';

describe('repoNameFromOrigin', () => {
  it('takes the last path segment of an https origin, without .git', () => {
    expect(repoNameFromOrigin('https://github.com/acme/widgets.git')).toBe('widgets');
    expect(repoNameFromOrigin('https://github.com/acme/widgets')).toBe('widgets');
  });

  it('handles scp-like (git@) and ssh:// shapes', () => {
    expect(repoNameFromOrigin('git@github.com:acme/widgets.git')).toBe('widgets');
    expect(repoNameFromOrigin('ssh://git@github.com/acme/widgets.git')).toBe('widgets');
  });

  it('tolerates a trailing slash', () => {
    expect(repoNameFromOrigin('https://github.com/acme/widgets/')).toBe('widgets');
    expect(repoNameFromOrigin('https://github.com/acme/widgets.git/')).toBe('widgets');
  });

  it('keeps the leaf of a nested (self-hosted) path', () => {
    expect(repoNameFromOrigin('https://gitlab.com/group/subgroup/widgets.git')).toBe('widgets');
  });

  it('returns undefined for an unusable value', () => {
    expect(repoNameFromOrigin('')).toBeUndefined();
    expect(repoNameFromOrigin('   ')).toBeUndefined();
  });
});

describe('repoNameFromSlug', () => {
  it('takes the repo half of owner__repo', () => {
    expect(repoNameFromSlug('acme__widgets')).toBe('widgets');
  });

  it('returns the whole slug when there is no owner half', () => {
    expect(repoNameFromSlug('widgets')).toBe('widgets');
  });

  it('returns undefined for an empty slug', () => {
    expect(repoNameFromSlug('')).toBeUndefined();
  });
});

describe('repoNameFromRegistration', () => {
  it('prefers the origin URL', () => {
    expect(
      repoNameFromRegistration({
        originUrl: 'git@github.com:acme/widgets.git',
        projectSlug: 'acme__something-else',
        name: 'box-1',
      }),
    ).toBe('widgets');
  });

  it('falls back to the custody slug when there is no origin', () => {
    expect(repoNameFromRegistration({ projectSlug: 'acme__widgets', name: 'box-1' })).toBe('widgets');
  });

  it('falls back to the box name when there is no git identity', () => {
    expect(repoNameFromRegistration({ name: 'smoke' })).toBe('smoke');
    expect(repoNameFromRegistration({ originUrl: '', projectSlug: '', name: 'smoke' })).toBe('smoke');
  });

  it('falls through an unparseable origin to the slug', () => {
    expect(repoNameFromRegistration({ originUrl: '::::', projectSlug: 'acme__widgets', name: 'box' })).toBe(
      'widgets',
    );
  });
});
