import { describe, expect, it } from 'vitest';
import {
  ghHostFromRemote,
  parseGitRemote,
  repoSlugFromRemote,
  toAuthedHttpsUrl,
  toHttpsUrl,
} from '../src/git-pat.js';

describe('toAuthedHttpsUrl', () => {
  const TOKEN = 'github_pat_ABC123';

  it('rewrites scp-like ssh remotes', () => {
    expect(toAuthedHttpsUrl('git@github.com:owner/repo.git', TOKEN)).toBe(
      `https://x-access-token:${TOKEN}@github.com/owner/repo.git`,
    );
  });

  it('rewrites https remotes', () => {
    expect(toAuthedHttpsUrl('https://github.com/owner/repo.git', TOKEN)).toBe(
      `https://x-access-token:${TOKEN}@github.com/owner/repo.git`,
    );
  });

  it('rewrites ssh:// remotes', () => {
    expect(toAuthedHttpsUrl('ssh://git@github.com/owner/repo.git', TOKEN)).toBe(
      `https://x-access-token:${TOKEN}@github.com/owner/repo.git`,
    );
  });

  it('strips existing embedded credentials', () => {
    expect(toAuthedHttpsUrl('https://olduser:oldpass@github.com/owner/repo.git', TOKEN)).toBe(
      `https://x-access-token:${TOKEN}@github.com/owner/repo.git`,
    );
  });

  it('preserves enterprise hosts', () => {
    expect(toAuthedHttpsUrl('git@ghe.corp.example:team/svc.git', TOKEN)).toBe(
      `https://x-access-token:${TOKEN}@ghe.corp.example/team/svc.git`,
    );
  });

  it('throws on an unrecognized URL', () => {
    expect(() => toAuthedHttpsUrl('not a url', TOKEN)).toThrow(/unrecognized|empty/);
    expect(() => toAuthedHttpsUrl('', TOKEN)).toThrow(/empty/);
  });
});

describe('toHttpsUrl', () => {
  it('rewrites scp-like ssh remotes the hub cannot authenticate', () => {
    expect(toHttpsUrl('git@github.com:Evinto-Solutions/optima.git')).toBe(
      'https://github.com/Evinto-Solutions/optima.git',
    );
  });

  it('leaves https remotes alone', () => {
    expect(toHttpsUrl('https://github.com/owner/repo.git')).toBe(
      'https://github.com/owner/repo.git',
    );
  });

  it('rewrites ssh:// remotes', () => {
    expect(toHttpsUrl('ssh://git@github.com/owner/repo.git')).toBe(
      'https://github.com/owner/repo.git',
    );
  });

  it('drops embedded credentials rather than carrying them into a stored origin', () => {
    expect(toHttpsUrl('https://olduser:oldpass@github.com/owner/repo.git')).toBe(
      'https://github.com/owner/repo.git',
    );
  });

  it('preserves enterprise hosts', () => {
    expect(toHttpsUrl('git@ghe.corp.example:team/svc.git')).toBe(
      'https://ghe.corp.example/team/svc.git',
    );
  });

  it('throws on an unrecognized URL', () => {
    expect(() => toHttpsUrl('not a url')).toThrow(/unrecognized|empty/);
    expect(() => toHttpsUrl('')).toThrow(/empty/);
  });
});

describe('repoSlugFromRemote', () => {
  it('returns OWNER/REPO for github.com (https and ssh)', () => {
    expect(repoSlugFromRemote('https://github.com/owner/repo.git')).toBe('owner/repo');
    expect(repoSlugFromRemote('git@github.com:owner/repo.git')).toBe('owner/repo');
    expect(repoSlugFromRemote('https://github.com/owner/repo')).toBe('owner/repo');
  });

  it('prefixes the host for enterprise remotes', () => {
    expect(repoSlugFromRemote('git@ghe.corp.example:team/svc.git')).toBe(
      'ghe.corp.example/team/svc',
    );
  });
});

describe('parseGitRemote', () => {
  it('reports the URL scheme, and null for the scp-like form', () => {
    expect(parseGitRemote('https://github.com/owner/repo.git').scheme).toBe('https');
    expect(parseGitRemote('SSH://git@ghe.corp.example/team/svc').scheme).toBe('ssh');
    expect(parseGitRemote('git@github.com:owner/repo.git').scheme).toBeNull();
  });
});

describe('ghHostFromRemote', () => {
  it('returns null for github.com — gh needs no hint there', () => {
    expect(ghHostFromRemote('https://github.com/owner/repo.git')).toBeNull();
    expect(ghHostFromRemote('git@github.com:owner/repo.git')).toBeNull();
    expect(ghHostFromRemote('https://GitHub.com/owner/repo')).toBeNull();
  });

  it('returns null when there is no usable remote', () => {
    expect(ghHostFromRemote(undefined)).toBeNull();
    expect(ghHostFromRemote('')).toBeNull();
    expect(ghHostFromRemote('   ')).toBeNull();
    expect(ghHostFromRemote('/srv/mirrors/r.git')).toBeNull();
    expect(ghHostFromRemote('not a url')).toBeNull();
  });

  it('reports an enterprise host, lowercased, with creds stripped', () => {
    expect(ghHostFromRemote('https://user:pw@GHE.Corp.Example/team/svc')).toEqual({
      host: 'ghe.corp.example',
      aliasable: false,
    });
  });

  it('marks ssh-shaped remotes aliasable — their host may be an ~/.ssh/config alias', () => {
    expect(ghHostFromRemote('git@ghe.corp.example:team/svc.git')).toEqual({
      host: 'ghe.corp.example',
      aliasable: true,
    });
    expect(ghHostFromRemote('ssh://git@ghe-work/team/svc.git')).toEqual({
      host: 'ghe-work',
      aliasable: true,
    });
    // An https URL has no aliasing layer, so its host is authoritative.
    expect(ghHostFromRemote('http://ghe.corp.example/team/svc.git')).toEqual({
      host: 'ghe.corp.example',
      aliasable: false,
    });
  });
});
