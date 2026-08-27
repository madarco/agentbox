import { describe, expect, it, vi } from 'vitest';

/**
 * ~/.ssh/config aliases: the host in a remote URL is a config entry, not a
 * server. Everything asking "which host do I need a credential for" has to
 * expand it the way ssh does, or an alias user is asked about a host that
 * doesn't exist — where a plain `gh auth token` used to answer correctly.
 */
const SSH_CONFIG: Record<string, string> = {
  'github.com-work': 'github.com',
  'ghe-work': 'ghe.corp.example',
};

vi.mock('@agentbox/sandbox-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agentbox/sandbox-core')>()),
  resolveSshConfigTarget: async (destination: string) => ({
    host: SSH_CONFIG[destination] ?? destination,
  }),
}));

const { resolveOriginGitHost } = await import('../src/lib/git-host.js');

describe('resolveOriginGitHost', () => {
  it('defaults to github.com for github.com, missing and unusable remotes', async () => {
    expect(await resolveOriginGitHost('git@github.com:o/r.git')).toBe('github.com');
    expect(await resolveOriginGitHost('https://github.com/o/r')).toBe('github.com');
    expect(await resolveOriginGitHost(undefined)).toBe('github.com');
    expect(await resolveOriginGitHost('')).toBe('github.com');
    expect(await resolveOriginGitHost('/srv/mirrors/r.git')).toBe('github.com');
  });

  it('keeps an enterprise host from an https remote as-is', async () => {
    expect(await resolveOriginGitHost('https://ghe.corp.example/team/svc.git')).toBe(
      'ghe.corp.example',
    );
  });

  it('expands an ssh alias to the host that actually answers', async () => {
    expect(await resolveOriginGitHost('git@github.com-work:o/r.git')).toBe('github.com');
    expect(await resolveOriginGitHost('ssh://git@ghe-work/team/svc.git')).toBe('ghe.corp.example');
  });

  it('leaves an unaliased ssh host alone', async () => {
    expect(await resolveOriginGitHost('git@ghe.corp.example:team/svc.git')).toBe(
      'ghe.corp.example',
    );
  });
});
