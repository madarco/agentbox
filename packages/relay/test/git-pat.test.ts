import { describe, expect, it } from 'vitest';
import { repoSlugFromRemote, toAuthedHttpsUrl, toHttpsUrl } from '../src/git-pat.js';

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
    expect(repoSlugFromRemote('git@ghe.corp.example:team/svc.git')).toBe('ghe.corp.example/team/svc');
  });
});
